import { randomUUIDv7 } from "bun";
import { ResultAsync } from "neverthrow";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
    contentToCortexMessages,
    createCardResolver,
    createStreamingChat,
    createThreadHistory,
    type DbError,
    type EmitFn,
    type Pool,
    type ThreadHistory,
} from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { isSubAgentEvent, readPlanCard, readRunCard } from "../../modules/harness/chat_printer.ts";
import { buildChatSession, runChatTurn, type TurnOutcome } from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { harnessRuntime } from "./boot.ts";
import { notify } from "./notice.ts";
import { setChatStatus } from "./status.ts";
import type { Part, TextPart, ToolCallPart } from "../../types/session.ts";

// The chat's hot state — the message list, the in-flight streaming buffer, and the last error —
// held here (not inside `app.tsx`) so the holder of the state is decoupled from its renderer, the
// same split as `status.ts`. The `Chat` component (`tui/components/chat.tsx`) renders it and drives
// the load on session/boot changes; the `Sidebar` reads `messageCount`; `app.tsx` only composes
// them. The transcript arrives two ways, BOTH writing this store directly (no bus for the harness
// path, per design D9/D10): `send` runs one shared turn and feeds every harness event through
// `applyEmitEvent`, and `loadMessages` replays the pg thread on open. One chat screen is mounted at
// a time, so a module singleton is correct. The coarse activity state stays in `status.ts`.

/** One chat turn as the UI holds it: the message identity plus its parts. */
export type UIMessage = {
    id: string;
    role: "user" | "assistant";
    parts: Part[];
    /** Assistant-only turn duration in ms, set when the turn finishes; undefined otherwise. */
    durationMs?: number;
};

// The most-recent turns the UI mounts. Layout cost scales with mounted message count (the scrollbox
// clips painting, not layout), so we cap what's mounted rather than virtualize — 200 turns ≈ 100
// exchanges, comfortably more than a screenful. Older turns stay in the pg thread; just not mounted.
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

/** Set (or clear with `null`) the error banner text. Called by the send path and app-level guards. */
export function setError(msg: string | null): void {
    setErrorMsg(msg);
}

// Per-turn adapter state. `currentAssistantId` is the message every harness event appends parts to;
// `currentSessionId` fills the persisted-part ceremony fields; `openTools` pairs a `tool-finished`
// with its `tool-started` by tool-use id (storing only the start timestamp — a primitive — so the
// copy-on-receive rule holds by construction). Module-private: only the send lifecycle touches them.
let currentAssistantId: string | null = null;
let currentSessionId: string | null = null;
const openTools = new Map<string, number>();

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

/** Append one part to the in-flight assistant message, if a turn is active. */
function appendPart(part: Part): void {
    const id = currentAssistantId;
    if (!id) return;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (msg) msg.parts.push(part);
        }),
    );
}

/**
 * Resolve a live tool part on `tool-finished`: flip its status and stamp the duration. Falls back to
 * appending a finished part when no matching `tool-started` was seen (should not happen, but the
 * transcript stays honest either way). A fresh object so Solid reconciles the status/duration edit.
 */
function updateToolPart(toolUseId: string, name: string, status: "ok" | "error", durationMs: number | undefined): void {
    const id = currentAssistantId;
    if (!id) return;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (!msg) return;
            const idx = msg.parts.findIndex((p) => p.id === toolUseId && p.type === "tool-call");
            if (idx !== -1) {
                msg.parts[idx] = { ...(msg.parts[idx] as ToolCallPart), status, durationMs };
            } else {
                msg.parts.push({
                    id: toolUseId,
                    sessionId: currentSessionId ?? "",
                    messageId: id,
                    type: "tool-call",
                    name,
                    status,
                    durationMs,
                    createdAt: Date.now(),
                });
            }
        }),
    );
}

/** The harness `EmitFn` event union — one event the agent loop, provider, or a tool streams. */
type EmitEventArg = Parameters<EmitFn>[0];

/**
 * Reduce one harness turn event into the store (design D3). This is the TUI's counterpart to the
 * REPL printer: it consumes the harness `contracts/` vocabulary directly (never the cli bus event
 * shapes) and writes the store rather than a terminal.
 *
 *   - sub-agent traffic (deeper `callPath`) is dropped — the shared depth filter;
 *   - `text-delta` accumulates in `streamText` and flushes on turn completion, never per delta;
 *   - `tool-started`/`tool-finished` become one live tool part paired by tool-use id, with a
 *     duration and error outcome on finish;
 *   - `data-plan`/`data-run-card` become card parts via the shared readers;
 *   - any other `data-*` part renders a visible tagged mention (observed, not swallowed);
 *   - `iteration`/`done` are dropped.
 *
 * COPY-ON-RECEIVE: in-process `emit` shares mutable references with the agent loop, so every branch
 * extracts the primitives/fresh objects it stores at receipt and NEVER retains the received event or
 * its `data` (the same hazard the printer guards). The card readers copy every field they keep.
 */
export function applyEmitEvent(event: EmitEventArg): void {
    if (isSubAgentEvent(event)) return;

    switch (event.type) {
        case "text-delta":
            setStreamText((prev) => prev + event.text);
            return;
        case "done":
        case "iteration":
            // Stream terminal marker / loop iteration boundary — orchestration, not transcript content.
            return;
        case "tool-started": {
            // Extract primitives at receipt; never retain the event.
            const toolUseId = event.toolUseId;
            const name = event.name;
            openTools.set(toolUseId, Date.now());
            appendPart({
                id: toolUseId,
                sessionId: currentSessionId ?? "",
                messageId: currentAssistantId ?? "",
                type: "tool-call",
                name,
                status: "running",
                createdAt: Date.now(),
            });
            return;
        }
        case "tool-finished": {
            const toolUseId = event.toolUseId;
            const name = event.name;
            const isError = event.isError;
            const startedAt = openTools.get(toolUseId);
            openTools.delete(toolUseId);
            const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
            updateToolPart(toolUseId, name, isError ? "error" : "ok", durationMs);
            return;
        }
        default:
            // Only `ChatDataPart` remains (its `type` is `data-${string}`).
            renderDataPart(event.type, event.data);
            return;
    }
}

/** Map a harness data part into a card part (via the shared readers) or a visible tagged mention. */
function renderDataPart(type: `data-${string}`, data: unknown): void {
    switch (type) {
        case "data-plan": {
            const plan = readPlanCard(data);
            appendPart({ id: randomUUIDv7(), type: "plan-card", planId: plan.planId, title: plan.title, steps: plan.steps });
            return;
        }
        case "data-run-card": {
            const run = readRunCard(data);
            appendPart({ id: randomUUIDv7(), type: "run-card", runId: run.runId, title: run.title, stepCount: run.stepCount });
            return;
        }
        default:
            // Observe an unknown conversation part as a one-line tagged mention — never swallowed.
            appendPart({
                id: randomUUIDv7(),
                sessionId: currentSessionId ?? "",
                messageId: currentAssistantId ?? "",
                type: "text",
                text: `[part:${type}]`,
                createdAt: Date.now(),
            });
            return;
    }
}

/** Push the user's turn as its own message, with its text part, re-enforcing the mount cap. */
function pushUserMessage(sessionId: string, text: string): void {
    const id = randomUUIDv7();
    setMessages(
        produce((msgs) => {
            msgs.push({ id, role: "user", parts: [{ id: randomUUIDv7(), sessionId, messageId: id, type: "text", text, createdAt: Date.now() }] });
            while (msgs.length > MESSAGE_CAP) msgs.shift();
        }),
    );
}

/**
 * Open the assistant turn: mint the assistant message with an empty streaming text part and arm the
 * per-turn adapter state. Streamed deltas accumulate into that text part; tool/card parts append
 * after it as they arrive. Called once at the top of {@link send}, per the design's "mint the
 * assistant message + streaming text part id when the turn starts". Returns the minted assistant id
 * so {@link send} can stamp its duration on finish and pop it on a pre-run failure.
 */
function startAssistantTurn(sessionId: string): string {
    const assistantId = randomUUIDv7();
    const textPartId = randomUUIDv7();
    currentAssistantId = assistantId;
    currentSessionId = sessionId;
    openTools.clear();
    setStreamPartId(textPartId);
    setStreamText("");
    setMessages(
        produce((msgs) => {
            msgs.push({
                id: assistantId,
                role: "assistant",
                parts: [{ id: textPartId, sessionId, messageId: assistantId, type: "text", text: "", createdAt: Date.now() }],
            });
            while (msgs.length > MESSAGE_CAP) msgs.shift();
        }),
    );
    return assistantId;
}

/** `unknown` → a one-line message, matching the REPL's `errText` shape. */
function errText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/** Surface an `appendTurn` fault as a non-fatal notice — the turn itself may have succeeded. */
function reportAppendError(e: DbError | undefined): void {
    if (e) notify({ kind: "warn", text: `Could not save the turn to the thread (${e.type}).` });
}

/**
 * Close every tool part still `running` when a turn ends, then clear the pairing map. A turn that
 * ends before a tool's `tool-finished` arrives (abort mid-tool, or a failure that races the sink)
 * would otherwise strand the chip at `running` forever at idle — the same "close the open chip
 * honestly" the REPL printer does in its own `finishTurn`. `error` is the terminal state (the part
 * status union has no `interrupted`), and the part already carries its name from `tool-started`, so
 * the empty `name` here is never read (`updateToolPart` only uses it on the never-taken append path).
 */
function drainOpenTools(): void {
    for (const [toolUseId, startedAt] of openTools) {
        updateToolPart(toolUseId, "", "error", Date.now() - startedAt);
    }
    openTools.clear();
}

/**
 * Stamp the assistant turn's wall-clock duration (fulfilling {@link UIMessage.durationMs}'s promise).
 * A fresh field write via `produce` so Solid reconciles the edit. No-op if the message is gone.
 */
function stampDuration(assistantId: string, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === assistantId);
            if (msg) msg.durationMs = durationMs;
        }),
    );
}

/**
 * Remove the just-minted empty assistant bubble on a pre-run failure and clear the streaming signals
 * that pointed at it. `prepare_failed`/`thread_gone` bail BEFORE `runAgent`, so this assistant message
 * only ever held its empty streaming text part (no deltas, no tools by construction) — leaving it
 * mounted would render a blank assistant turn beneath the error banner.
 */
function dropEmptyAssistant(assistantId: string): void {
    setStreamPartId(null);
    setStreamText("");
    setMessages(
        produce((msgs) => {
            const idx = msgs.findIndex((m) => m.id === assistantId);
            if (idx !== -1) msgs.splice(idx, 1);
        }),
    );
}

/**
 * Reduce the engine's {@link TurnOutcome} onto the store for the CURRENT turn (the caller's C1 guard
 * has already dropped a superseded turn's outcome, so `assistantId` still identifies a live message):
 * flush the streamed text (or the engine's `fallbackText` on a delta-less turn), close any open tool
 * chip, stamp the turn's duration, surface an append fault non-fatally, and set the coarse status.
 * `failed`/`prepare_failed`/`thread_gone` also raise the error banner with an actionable line;
 * `aborted` returns to idle with no error (the user cancelled), having flushed what streamed.
 * `prepare_failed`/`thread_gone` bail before the loop, so they pop the empty assistant bubble instead.
 */
function finishTurn(outcome: TurnOutcome, assistantId: string, startedAt: number): void {
    switch (outcome.kind) {
        case "ok":
            // Streamed answers already sit in `streamText`; a delta-less turn (or a non-streaming
            // loop) renders the engine's `fallbackText` instead — the same suppression the printer does.
            if (streamText().length === 0 && outcome.fallbackText.trim().length > 0) setStreamText(outcome.fallbackText);
            commitStream();
            drainOpenTools();
            stampDuration(assistantId, startedAt);
            reportAppendError(outcome.appendError);
            setChatStatus("idle");
            return;
        case "aborted":
            commitStream();
            drainOpenTools();
            stampDuration(assistantId, startedAt);
            reportAppendError(outcome.appendError);
            setChatStatus("idle");
            return;
        case "failed":
            commitStream();
            drainOpenTools();
            stampDuration(assistantId, startedAt);
            setErrorMsg(`The turn failed: ${errText(outcome.cause)}`);
            reportAppendError(outcome.appendError);
            setChatStatus("error");
            return;
        case "prepare_failed":
            dropEmptyAssistant(assistantId);
            setErrorMsg(`Could not start the turn (is Postgres reachable?): ${errText(outcome.cause)}`);
            setChatStatus("error");
            return;
        case "thread_gone":
            dropEmptyAssistant(assistantId);
            setErrorMsg("This conversation thread is no longer available.");
            setChatStatus("error");
            return;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled turn outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/** One reconstructed transcript message from the pg thread read path. Exported for the load seams. */
export type CortexMsg = Awaited<ReturnType<typeof contentToCortexMessages>>[number];

/**
 * Map a reconstructed {@link CortexMsg} to a {@link UIMessage}: text → text part; a replayed
 * tool-call → a finished tool part; recognized cards (`data-plan`/`data-run-card`) → card parts via
 * the SAME readers the live adapter uses; anything else the harness resolver kept → a visible tagged
 * mention. The harness resolver already dropped what the UI does not render (reasoning, tool
 * results). Card parts are FLAT on the reconstructed part, and the readers narrow off any object, so
 * the part is passed straight through.
 */
function cortexToUiMessage(m: CortexMsg, sessionId: string): UIMessage {
    const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
    const parts: Part[] = [];
    for (const part of m.parts) {
        switch (part.type) {
            case "text":
                parts.push({ id: randomUUIDv7(), sessionId, messageId: m.id, type: "text", text: part.text, createdAt: 0 });
                break;
            case "tool-call":
                // History-replayed calls arrive `finished`, and `isError` selects ok/error here.
                // LIMITATION: the harness reconstruction does not yet thread `is_error` through, so
                // `isError` is always false today and a reloaded tool renders `ok` even if it errored
                // live. This branch is contract-correct and needs no change once a harness-side
                // follow-up carries the real outcome through.
                parts.push({
                    id: part.toolCallId || randomUUIDv7(),
                    sessionId,
                    messageId: m.id,
                    type: "tool-call",
                    name: part.toolName,
                    status: part.isError ? "error" : "ok",
                    createdAt: 0,
                });
                break;
            case "data-plan": {
                const plan = readPlanCard(part);
                parts.push({ id: randomUUIDv7(), type: "plan-card", planId: plan.planId, title: plan.title, steps: plan.steps });
                break;
            }
            case "data-run-card": {
                const run = readRunCard(part);
                parts.push({ id: randomUUIDv7(), type: "run-card", runId: run.runId, title: run.title, stepCount: run.stepCount });
                break;
            }
            default:
                parts.push({ id: randomUUIDv7(), sessionId, messageId: m.id, type: "text", text: `[part:${part.type}]`, createdAt: 0 });
                break;
        }
    }
    return { id: m.id, role, parts };
}

/**
 * Injectable edges so {@link loadMessages} is unit-testable offline (no Postgres, no booted runtime)
 * — mirrors {@link SendSeams}. Production callers omit the third argument and get the real booted
 * runtime + `ThreadHistory` page reads + card reconstruction; tests pass fakes whose page loads and
 * card resolution resolve on the test's schedule, so an interleaving of two rapid loads is exercisable.
 */
export type LoadSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** One turn-paginated page of the thread. Real: `createThreadHistory(pool).loadPage`. */
    readonly loadPage: (pool: Pool, threadId: string, page: number, perPage: number) => ReturnType<ThreadHistory["loadPage"]>;
    /** Reconstruct display messages from a page (builds the card resolver internally). Real: below. */
    readonly toCortex: (pool: Pool, analysisId: string, messages: Parameters<typeof contentToCortexMessages>[0]) => Promise<CortexMsg[]>;
};

const realLoadSeams: LoadSeams = {
    runtime: harnessRuntime,
    loadPage: (pool, threadId, page, perPage) => createThreadHistory(pool).loadPage(threadId, page, perPage),
    // The card resolver reaches the pool + session tree to rebuild plan/run cards from the persisted
    // tool_use rows; `unwrapOrThrow` inside it THROWS on a storage fault, so `contentToCortexMessages`
    // is bridged to a Result in `loadMessages` (neverthrow-first: a harness throw becomes our error state).
    toCortex: (pool, analysisId, messages) => contentToCortexMessages(messages, createCardResolver(pool, analysisId, env.sessionsDir)),
};

// Monotonic token identifying the newest loadMessages call. Two rapid session swaps interleave their
// async page reads, and the older load can resolve LAST; without this it would clobber the newer
// store. Every store/error write in the async path re-checks it still owns the latest token, so the
// last load STARTED wins regardless of which finishes last. Module-private: only loadMessages touches it.
let loadGeneration = 0;

/**
 * Load a session's transcript from the pg thread history (design D9), replacing whatever was mounted.
 * The thread id equals the session id (design D1). `loadPage` paginates by whole turns; page 0
 * reveals the turn `total`, and when the thread spans more than one page we fetch the LAST page so
 * the store holds the newest window, then clamp to the {@link MESSAGE_CAP} oldest-first. A missing pg
 * thread (legacy session, or the runtime not yet booted) renders empty — correct and expected: the
 * legacy SQLite transcript is frozen and not shown here.
 *
 * Concurrency: each call claims a {@link loadGeneration} token at entry and re-checks it after every
 * await; a load superseded by a newer swap silently drops rather than writing a stale transcript.
 */
export async function loadMessages(sessionId: string, analysisId: string, seams: LoadSeams = realLoadSeams): Promise<void> {
    const runtime = seams.runtime();
    if (!runtime) return;
    const myLoad = ++loadGeneration;

    const firstRes = await seams.loadPage(runtime.pool, sessionId, 0, MESSAGE_CAP);
    if (myLoad !== loadGeneration) return; // a newer swap started while this page was in flight — drop it
    if (firstRes.isErr()) {
        setErrorMsg(`Failed to load the conversation: ${firstRes.error.type}`);
        setChatStatus("error");
        return;
    }
    let page = firstRes.value;
    const lastPage = Math.max(0, Math.ceil(page.total / MESSAGE_CAP) - 1);
    if (lastPage > 0) {
        const lastRes = await seams.loadPage(runtime.pool, sessionId, lastPage, MESSAGE_CAP);
        if (myLoad !== loadGeneration) return;
        if (lastRes.isErr()) {
            setErrorMsg(`Failed to load the conversation: ${lastRes.error.type}`);
            setChatStatus("error");
            return;
        }
        page = lastRes.value;
    }

    const mapped = await ResultAsync.fromPromise(seams.toCortex(runtime.pool, analysisId, page.messages), (e): unknown => e);
    if (myLoad !== loadGeneration) return;
    mapped.match(
        (cortex) => setMessages(cortex.map((m) => cortexToUiMessage(m, sessionId)).slice(-MESSAGE_CAP)),
        (cause) => {
            setErrorMsg(`Failed to load the conversation: ${errText(cause)}`);
            setChatStatus("error");
        },
    );
}

// The in-flight chat request. Module-private: only `send`/`abort`/`resetHotState` touch it, so the
// controller's lifetime is owned alongside the state it cancels.
let abortController: AbortController | null = null;

/**
 * Clear all hot state for an in-place session swap: cancel any in-flight request, drop the streamed
 * buffer, the error, the messages, and the per-turn adapter state, and return the status to idle.
 * Idempotent.
 */
export function resetHotState(): void {
    abortController?.abort();
    // C1: null the token AFTER aborting so an in-flight turn's controller no longer matches its
    // captured `myTurn` — the outcome/late-event guards in `send` then drop everything that turn
    // still emits, covering a reset that is NOT followed by a new send (a new send would otherwise
    // replace the token and supersede the old turn on its own).
    abortController = null;
    currentAssistantId = null;
    currentSessionId = null;
    openTools.clear();
    setStreamPartId(null);
    setStreamText("");
    setErrorMsg(null);
    setChatStatus("idle");
    setMessages([]);
}

/**
 * Injectable edges so {@link send} is unit-testable offline (no Postgres, no model, no credits) —
 * mirrors {@link ChatTurnSeams}. Production callers omit the second argument and get the real booted
 * runtime + engine; tests pass a stub runtime whose pool/provider are never dereferenced (the fake
 * engine drives the adapter and returns a chosen outcome without touching them).
 */
export type SendSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** The shared headless turn engine. Real: {@link runChatTurn}. */
    readonly runChatTurn: typeof runChatTurn;
};

const realSendSeams: SendSeams = { runtime: harnessRuntime, runChatTurn };

/**
 * Send a user turn through the shared harness turn engine (design D1–D3). Owns the turn-scoped
 * {@link AbortController} so {@link abort} (and a session swap) can cancel it. Flow: guard a booted
 * runtime → push the user message → open the assistant turn → drive `runChatTurn` with a per-turn
 * streaming wrapper whose deltas feed {@link applyEmitEvent} → reduce the outcome onto the store. The
 * thread id equals the session id, and the session carries a length-1 `callPath` identifying the TUI
 * surface so a chat-launched run stamps `cortex_runs.thread_id`.
 *
 * TURN-GENERATION GUARD (C1): the fresh {@link AbortController} instance IS this turn's identity
 * token. A session swap or {@link resetHotState} replaces (or nulls) the module `abortController`
 * mid-flight — while the OLD turn is still unwinding (`appendTurn`'s pg round-trip; a tool ignoring
 * its signal), a NEW turn can already be streaming into a new session. So every event this turn emits
 * flows through one guarded sink that drops it once the token no longer matches, and the outcome is
 * dropped on the same check — a superseded turn NEVER touches the new turn's streaming signals,
 * status, error, or messages. Its `appendTurn` already ran (correctly) inside the engine on the old
 * thread; the only remaining work is UI-visible, so dropping it is exactly right.
 */
export async function send(opts: { sessionId: string; analysisId: string; userText: string }, seams: SendSeams = realSendSeams): Promise<void> {
    setErrorMsg(null);
    const runtime = seams.runtime();
    if (!runtime) {
        // The app's boot gate should refuse a submit before this; a defensive terminal state beats a crash.
        setErrorMsg("The chat runtime is not ready yet — wait for boot to finish.");
        setChatStatus("error");
        return;
    }

    pushUserMessage(opts.sessionId, opts.userText);
    const assistantId = startAssistantTurn(opts.sessionId);
    setChatStatus("busy");
    const startedAt = Date.now();

    abortController = new AbortController();
    // The controller instance is this turn's token (C1). Captured once; the module `abortController`
    // may be reassigned/nulled by a swap or reset while this turn is in flight.
    const myTurn = abortController;

    // Every event this turn produces — streamed deltas, tool lifecycle, cards — passes through here.
    // Once a swap/reset supersedes the turn (`abortController !== myTurn`), late events are dropped at
    // this one boundary, so a stale turn can never write the new turn's streaming signals or store.
    const emitForTurn = (event: EmitEventArg): void => {
        if (abortController === myTurn) applyEmitEvent(event);
    };

    // Per-turn streaming wrapper: forward each provider text delta into the adapter as a `text-delta`
    // event, so answers accumulate in `streamText` as they arrive (design D3). Only this top-level
    // loop runs on the wrapper — sub-agent loops were wired to the plain provider at assembly.
    const chat = createStreamingChat(runtime.provider, (text) => void emitForTurn({ type: "text-delta", text }));
    const session = buildChatSession("tui-chat", opts.analysisId, opts.sessionId);

    const outcome = await seams.runChatTurn({
        pool: runtime.pool,
        conversationAgent: runtime.conversationAgent,
        chat,
        history: createThreadHistory(runtime.pool),
        session,
        emit: emitForTurn,
        signal: myTurn.signal,
        analysisId: opts.analysisId,
        // Design D1: the pg thread binds 1:1 to the session, so a plan launched here stamps its run.
        threadId: opts.sessionId,
        userInput: opts.userText,
    });

    // C1: the turn was superseded while the engine unwound — drop the outcome whole. Its `appendError`
    // toast is dropped too: it would otherwise fire over the new session's UI, and the persistence
    // fault is already reflected on the old thread's state, not the surface's.
    if (abortController !== myTurn) return;

    finishTurn(outcome, assistantId, startedAt);
}

/** Cancel the in-flight chat request, if any (the abort keybinding). */
export function abort(): void {
    abortController?.abort();
}
