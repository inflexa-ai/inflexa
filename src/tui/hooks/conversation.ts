import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { listSessionMessages } from "../../db/primary_query.ts";
import { chat } from "../../modules/intelligence/chat.ts";
import { setChatStatus } from "./status.ts";
import type { BusEvent } from "../../types/events.ts";
import type { Part, TextPart } from "../../types/session.ts";

// The chat's hot state — the message list, the in-flight streaming buffer, and the last error —
// held here (not inside `app.tsx`) so the holder of the state is decoupled from its renderer, the
// same split as `status.ts`. The `Chat` component (`tui/chat/chat.tsx`) renders it and owns the
// bus subscription that drives `applyBusEvent`; the `Sidebar` reads `messageCount`; `app.tsx` only
// composes them. One chat screen is mounted at a time, so a module singleton is correct. The coarse
// activity state stays in `status.ts` (the reducer below keeps it in sync via `setChatStatus`).

/** One chat turn as the UI holds it: the message identity plus its parts (text only, today). */
export type UIMessage = {
    id: string;
    role: "user" | "assistant";
    parts: Part[];
};

const [messages, setMessages] = createStore<UIMessage[]>([]);
const [streamText, setStreamText] = createSignal("");
const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

/** The conversation's messages — read in a tracking scope to react to appends/edits. */
export { messages };
/** The live streaming text for the in-flight part — read reactively. */
export { streamText };
/** The id of the part currently streaming, or `null` — read reactively. */
export { streamPartId };
/** The last chat error to surface as a banner, or `null` — read reactively. */
export { errorMsg };

/** The current message count — the `Sidebar` reads this; reactive on the store length. */
export function messageCount(): number {
    return messages.length;
}

/** Set (or clear with `null`) the error banner text. Called by the reducer and the send path. */
export function setError(msg: string | null): void {
    setErrorMsg(msg);
}

/**
 * Apply one bus event to the conversation, ignoring events for any session other than `sessionId`.
 * The streaming part accumulates in `streamText`/`streamPartId` and is flushed into the store only
 * when the turn completes (on `session.status` idle) — never one delta at a time.
 */
export function applyBusEvent(event: BusEvent, sessionId: string): void {
    switch (event.type) {
        case "session.status":
            if (event.sessionId === sessionId) {
                setChatStatus(event.status);
                if (event.status === "idle" && streamPartId()) {
                    const pid = streamPartId()!;
                    const text = streamText();
                    setMessages(
                        produce((msgs) => {
                            for (const msg of msgs) {
                                const idx = msg.parts.findIndex((p) => p.id === pid);
                                if (idx !== -1) {
                                    (msg.parts[idx] as TextPart).text = text;
                                    break;
                                }
                            }
                        }),
                    );
                    setStreamPartId(null);
                    setStreamText("");
                }
            }
            break;

        case "message.created":
            if (event.message.sessionId === sessionId) {
                setMessages(
                    produce((msgs) => {
                        msgs.push({
                            id: event.message.id,
                            role: event.message.role,
                            parts: [],
                        });
                    }),
                );
            }
            break;

        case "part.updated": {
            const part = event.part;
            if (part.sessionId !== sessionId) break;
            setMessages(
                produce((msgs) => {
                    const msg = msgs.find((m) => m.id === part.messageId);
                    if (!msg) return;
                    const idx = msg.parts.findIndex((p) => p.id === part.id);
                    if (idx === -1) {
                        msg.parts.push(part);
                    } else {
                        msg.parts[idx] = part;
                    }
                }),
            );
            break;
        }

        case "part.delta":
            if (event.sessionId !== sessionId) break;
            if (streamPartId() !== event.partId) {
                setStreamPartId(event.partId);
                setStreamText(event.delta);
            } else {
                setStreamText((prev) => prev + event.delta);
            }
            break;

        case "session.error":
            if (event.sessionId === sessionId) {
                setErrorMsg(event.error);
                setChatStatus("error");
            }
            break;
    }
}

/** Load a session's persisted messages into the store, replacing whatever was there. */
export function loadMessages(sessionId: string): void {
    listSessionMessages(sessionId).match(
        (existing) => {
            const uiMsgs: UIMessage[] = existing.map((m) => ({
                id: m.info.id,
                role: m.info.role,
                parts: m.parts,
            }));
            setMessages(uiMsgs);
        },
        (error) => {
            setErrorMsg(`Failed to load messages: ${error.type}`);
            setChatStatus("error");
        },
    );
}

// The in-flight chat request. Module-private: only `send`/`abort`/`resetHotState` touch it, so the
// controller's lifetime is owned alongside the state it cancels.
let abortController: AbortController | null = null;

/**
 * Clear all hot state for an in-place session swap: cancel any in-flight request, drop the streamed
 * buffer, the error, and the messages, and return the status to idle. Idempotent.
 */
export function resetHotState(): void {
    abortController?.abort();
    setStreamPartId(null);
    setStreamText("");
    setErrorMsg(null);
    setChatStatus("idle");
    setMessages([]);
}

/**
 * Send a user turn to the model engine. Owns the {@link AbortController} so {@link abort} (and a
 * session swap) can cancel it. `chat()` drives the persistence + streaming and emits the bus events
 * that {@link applyBusEvent} renders; only its terminal failure is surfaced here as the error banner.
 */
export async function send(opts: { sessionId: string; userText: string }): Promise<void> {
    setErrorMsg(null);
    abortController = new AbortController();
    (
        await chat({
            sessionId: opts.sessionId,
            userText: opts.userText,
            abort: abortController.signal,
        })
    ).match(
        () => {},
        (error) => {
            setErrorMsg(`Chat error: ${error.type}`);
            setChatStatus("error");
        },
    );
}

/** Cancel the in-flight chat request, if any (the abort keybinding). */
export function abort(): void {
    abortController?.abort();
}
