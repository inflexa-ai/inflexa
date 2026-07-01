import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { listRecentSessionMessages } from "../../db/primary_query.ts";
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
    /** Assistant-only turn duration in ms, set when the turn finishes (a `message.updated` event); undefined otherwise. */
    durationMs?: number;
};

// The most-recent turns the UI mounts. Layout cost scales with mounted message count (the scrollbox
// clips painting, not layout), so we cap what's mounted rather than virtualize — 200 turns ≈ 100
// exchanges, comfortably more than a screenful. Older turns stay on disk; they're just not mounted.
const MESSAGE_CAP = 200;

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
 * Flush the accumulated streamed text into the stored part and clear the streaming buffer. A fresh
 * object (not an in-place `.text =`) so Solid always reconciles; an equal-value write after the
 * engine's out-of-band mutation can otherwise be skipped, stranding the text off-screen.
 *
 * No sub-delta reveal/typewriter: feeding the `<markdown>` renderable a growing prefix many times a
 * second races its async (treesitter) parse, which left inline syntax (`**bold**`) rendered as raw
 * literal `**` inconsistently. We mirror opencode — render the whole accumulated `streamText` as it
 * arrives (a handful of coarse proxy chunks per turn), which the parser keeps up with cleanly.
 */
function commitStream(): void {
    const pid = streamPartId();
    if (pid) {
        const text = streamText();
        setMessages(
            produce((msgs) => {
                for (const msg of msgs) {
                    const idx = msg.parts.findIndex((p) => p.id === pid);
                    if (idx !== -1) {
                        msg.parts[idx] = { ...(msg.parts[idx] as TextPart), text };
                        break;
                    }
                }
            }),
        );
    }
    setStreamPartId(null);
    setStreamText("");
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
                if (event.status === "idle" && streamPartId()) commitStream();
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
                            durationMs: event.message.durationMs,
                        });
                        // Re-enforce the mount cap on every live insert (a turn pushes user+assistant),
                        // dropping the oldest so a long running session can't grow the store unbounded.
                        while (msgs.length > MESSAGE_CAP) msgs.shift();
                    }),
                );
            }
            break;

        case "message.updated":
            if (event.message.sessionId === sessionId) {
                setMessages(
                    produce((msgs) => {
                        const msg = msgs.find((m) => m.id === event.message.id);
                        // Only the duration is mutable post-creation today; copy it across rather than
                        // replacing the whole UIMessage (its `parts` are owned by the part reducers).
                        if (msg) msg.durationMs = event.message.durationMs;
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
                    // Clone, never store the event's reference: the engine REUSES one Part object across
                    // emits (it sets `.text` out-of-band before persisting — chat.ts), so keeping its
                    // reference (a) leaks untracked mutations into the store and (b) makes the final
                    // same-reference `parts[idx] = part` a no-op Solid skips, leaving the reactive text
                    // empty under the renderer's scheduling. Owning a copy keeps the store authoritative.
                    if (idx === -1) msg.parts.push({ ...part });
                    else msg.parts[idx] = { ...part };
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

/** Load a session's most-recent {@link MESSAGE_CAP} messages into the store, replacing whatever was there. */
export function loadMessages(sessionId: string): void {
    listRecentSessionMessages(sessionId, MESSAGE_CAP).match(
        (existing) => {
            const uiMsgs: UIMessage[] = existing.map((m) => ({
                id: m.info.id,
                role: m.info.role,
                parts: m.parts,
                durationMs: m.info.durationMs,
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
