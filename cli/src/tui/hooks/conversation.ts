import { randomUUIDv7 } from "bun";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { createSignal, untrack } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import {
    applyChatFrame,
    createStreamingChat,
    createThreadHistory,
    storedMessagesToCortex,
    toChatFrame,
    type ChatFrame,
    type ChatPartFrame,
    type DbError,
    type EmitFn,
    type Pool,
    type RetractOutcome,
    type ThreadHistory,
} from "@inflexa-ai/harness";
// The source of a frame. The barrel binds `EventSource` to the loop type, whose path is read-only.
import type { EventSource } from "@inflexa-ai/harness/contracts/chat-events.js";
import type { ChatMessage, MessagePart, ToolCallPart } from "@inflexa-ai/harness/contracts/message.js";

import { describeCause, findAuthCause } from "../../lib/cause.ts";
import { getLogger } from "../../lib/log.ts";
import { resolveModelConnection } from "../../modules/harness/config.ts";
import { MODEL_API_KEY_VAR, providerKindForSlug } from "../../modules/infra/setup.ts";
import { readCredentialVerdict } from "../../modules/infra/credential_state.ts";
import { isSubAgentEvent, readAskPart, readPlanCard, subAgentActivityLabel } from "../../modules/harness/chat_printer.ts";
import { readFileReference, readPresentation } from "../../modules/harness/artifact_open.ts";
import {
    buildChatSession,
    healTailOrphan,
    retractTailTurn,
    runChatTurn,
    type HealOutcome,
    type TurnOutcome,
    type TurnUsage,
} from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { leaderSeq, sequenceLabel } from "../keymap.ts";
import { harnessRuntime } from "./boot.ts";
import { clearAsks, pushAsk, settleAsk } from "./asks.ts";
import { refreshReportChildren } from "./report_children.ts";
import { notify } from "./notice.ts";
import { chatStatus, setChatStatus } from "./status.ts";
import { runTurnWrite } from "./thread_write.ts";
import type { OpenableEntry, Part, PlanCardStepView } from "../../types/session.ts";

// The chat's hot state — the message list, the in-flight streaming buffer, and the last error —
// held here (not inside `app.tsx`) so the holder of the state is decoupled from its renderer, the
// same split as `status.ts`. The `Chat` component (`tui/components/chat.tsx`) renders it and drives
// the load on session/boot changes; the `Sidebar` reads `messageCount`; `app.tsx` only composes
// them. The transcript arrives two ways, BOTH writing this store directly (no bus for the harness
// path): `send` runs one shared turn and feeds every harness event through `applyEmitEvent`, which
// builds the live message with the shared translation path of the harness, and `loadMessages` mounts
// the replayed pg thread as the harness gives it. One chat screen is mounted at a time, so a module
// singleton is correct. The coarse activity state stays in `status.ts`.

/**
 * One message as the store holds it: the harness message, whose parts can carry the screen state of
 * the live turn (see {@link Part}). A reload mounts the replayed harness messages unchanged.
 *
 * A `system` message is not a turn: the harness gives that role to a record of out-of-band work that
 * this app appended to the thread (an analysis run's outcome), and to the divider of a compaction. The
 * record is stored under the `user` role for the wire format, and it renders as neither party's turn,
 * because it would otherwise read as something the reader said and be offered to them as retractable.
 * The live turn writes `durationMs`, `usage`, and `interrupted` at settlement, and a reload reads back
 * the values that the turn stored.
 */
export type UIMessage = Omit<ChatMessage, "parts"> & { parts: Part[] };

// The most-recent MESSAGES the UI mounts. Layout cost scales with mounted message count (the
// scrollbox clips painting, not layout), so we cap what's mounted rather than virtualize — 200
// messages ≈ 100 exchanges, comfortably more than a screenful. Older turns stay in the pg thread;
// just not mounted.
//
// One unit throughout: the live store shifts once it exceeds this (`pushUserMessage` /
// `startAssistantTurn`), and `loadMessages` slices the replayed transcript to the same count. The
// store's read imposes no ceiling of its own, so this is free to move.
const MESSAGE_CAP = 200;

// The identity the ask seam keys a standing `always` grant on. One person owns a
// local install, and the CLI holds no account model, so every turn carries this
// one value.
const LOCAL_ASK_USER_ID = "local";

const [messages, setMessages] = createStore<UIMessage[]>([]);
const [streamText, setStreamText] = createSignal("");
const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
// The raw cause behind the current failure banner, retained so the "turn error details" dialog can
// render the FULL value (stack, nested `.cause`, the whole structured object) the one-line banner
// necessarily collapses. Typed `unknown` because a cause is exactly that — an `Error`, a
// discriminated `{ type, ... }`, or anything a throw/`err` carried. Cleared on every new turn.
const [lastTurnFailure, setLastTurnFailure] = createSignal<unknown>(null);

/** The conversation's messages — read in a tracking scope to react to appends/edits. */
export { messages };
/** The live streaming text for the in-flight part — read reactively. */
export { streamText };
/** The id of the part currently streaming, or `null` — read reactively. */
export { streamPartId };
/** The last chat error to surface as a banner, or `null` — read reactively. */
export { errorMsg };
/** The raw cause behind the last failed turn, or `null` — read reactively for the details dialog. */
export { lastTurnFailure };

/** The current message count — the `Sidebar` reads this; reactive on the store length. */
export function messageCount(): number {
    return messages.length;
}

/** Set (or clear with `null`) the error banner text. Called by the send path and app-level guards. */
export function setError(msg: string | null): void {
    setErrorMsg(msg);
}

// ── Interrupt double-press window ────────────────────────────────────────────────────────────────
//
// The chat's interrupt is a double press: a first key arms a short window, a second within it fires
// the turn's abort. The window lives here (not in the keymap) so the same lifecycle that ends a turn
// clears it, and the status hint can render the armed state reactively. The keys themselves, and the
// busy/NORMAL-mode gating, are the UI layer's — this hook owns only the armed FLAG and its timer.

/** How long a first interrupt press keeps the double-press window armed before a second must fire it. */
export const INTERRUPT_ARM_WINDOW_MS = 5000;

const [interruptArmed, setInterruptArmed] = createSignal(false);
/** True while a first interrupt press has armed the double-press window — read reactively for the hint. */
export { interruptArmed };

let interruptArmTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm (or refresh) the interrupt double-press window: the UI's first-press binding calls this, and a
 * second press within the window fires {@link abort}. A fresh press restarts the timer; the timer is
 * `.unref`'d so a pending window never keeps the process alive at shutdown.
 *
 * @param windowMs how long the armed window holds before it lapses and disarms itself. Production
 * callers pass nothing and get {@link INTERRUPT_ARM_WINDOW_MS}; the override exists purely so a test can
 * drive the expiry path without a real multi-second wait (mirroring {@link notify}'s `durationMs`).
 */
export function armInterrupt(windowMs: number = INTERRUPT_ARM_WINDOW_MS): void {
    // Once the abort has fired there is nothing left to interrupt, so a re-arm would only lie in the
    // status hint — the turn stays "busy" until settlement, keeping the interrupt layer enabled, so a
    // further press would otherwise flip the hint back to armed while the turn is already dying. Bail:
    // the layer stays enabled harmlessly, since its fire branch re-aborting an aborted signal is a no-op.
    if (abortController?.signal.aborted) return;
    if (interruptArmTimer) clearTimeout(interruptArmTimer);
    setInterruptArmed(true);
    interruptArmTimer = setTimeout(() => {
        interruptArmTimer = null;
        setInterruptArmed(false);
    }, windowMs);
    interruptArmTimer.unref();
}

/** Disarm the interrupt window (a turn ended, or the window lapsed unfired). Idempotent. */
function disarmInterrupt(): void {
    if (interruptArmTimer) clearTimeout(interruptArmTimer);
    interruptArmTimer = null;
    setInterruptArmed(false);
}

// Per-turn adapter state. `currentAssistantId` is the message every harness event appends parts to;
// `currentSessionId` and `currentAnalysisId` scope the report-children refresh that a spawn pokes;
// `openTools` pairs a `tool-finished` with its `tool-started` by tool-use id (storing only the start
// timestamp — a primitive — so the copy-on-receive rule holds by construction). Module-private: only
// the send lifecycle touches them.
let currentAssistantId: string | null = null;
let currentSessionId: string | null = null;
let currentAnalysisId: string | null = null;
// The live turn as the shared translation path builds it: `applyChatFrame` takes it and gives the
// next one, and it holds harness parts only. The assistant message in the store mirrors it part for
// part, at the same index, because each frame changes one part in place or appends one. The store
// adds the screen state, and the text of the streaming part rides `streamText` until the part seals.
let turnMessages: ChatMessage[] = [];
const openTools = new Map<string, number>();
// The deepest sub-agent call depth seen while the current tool call has been open. Only an event at
// least that deep may write the activity line, which is what "show the INNERMOST sub-agent" means:
// while a depth-3 agent is working, its depth-2 caller is merely waiting on it and should not
// overwrite the line with its own state. Reset whenever a tool call opens.
//
// Trade-off accepted: when the deepest sub-agent finishes, the bar stays raised for the rest of the
// call, so a shallower agent's later activity is not shown. The alternative — tracking each depth's
// liveness — buys a more accurate line in the tail of a call whose line disappears moments later
// anyway.
let deepestSubAgentDepth = 0;

// A `text-delta` carries no source, and only the top-level loop streams text through the provider
// wrapper of `send`. `applyChatFrame` reads only the depth of a source, and no part keeps the source of
// a frame. Thus a path of one entry is the whole of what this value must give, to the frame of a delta
// and to the two frames that the adapter makes itself: the fallback text and the close of an open call.
const TOP_LEVEL_SOURCE: EventSource = { agentId: "chat", callPath: ["chat"] };

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
    const key = streamPartId();
    if (key !== null) {
        const text = streamText();
        setMessages(
            produce((msgs) => {
                for (const msg of msgs) {
                    const idx = msg.parts.findIndex((p) => p.type === "text" && p.key === key);
                    if (idx !== -1) {
                        msg.parts[idx] = { type: "text", text, key };
                        break;
                    }
                }
            }),
        );
    }
    setStreamPartId(null);
    setStreamText("");
}

/** The parts of the live assistant message, as the shared translation path holds them. */
function turnParts(assistantId: string): readonly MessagePart[] {
    return turnMessages.find((m) => m.id === assistantId)?.parts ?? [];
}

/** The tool-call part of the live turn for `toolCallId`, or `undefined` when no `tool-started` opened it. */
function turnToolCall(assistantId: string, toolCallId: string): ToolCallPart | undefined {
    for (const part of turnParts(assistantId)) {
        if (part.type === "tool-call" && part.toolCallId === toolCallId) return part;
    }
    return undefined;
}

/**
 * Apply one frame to the live turn through the shared translation path of the harness, then copy the
 * part that the frame changed into the store. `applyChatFrame` changes one part in place or appends
 * one, and it keeps the identity of each other part, thus an identity check finds the change.
 *
 * The last part streams when it is text: a delta changes only `streamText`, never the store, thus a
 * card beside the text keeps its component state while the text streams. A delta after a card makes
 * a new text part (the order of the stream), and a part that follows the streaming text part seals
 * that text into the store before the part lands ({@link appendPart}).
 */
function applyFrame(frame: ChatFrame): void {
    const id = currentAssistantId;
    if (id === null) return;
    const before = turnParts(id);
    turnMessages = applyChatFrame(turnMessages, frame, id).messages;
    const after = turnParts(id);
    for (const [index, part] of after.entries()) {
        if (part === before[index]) continue;
        const opens = index >= before.length;
        if (part.type === "text" && index === after.length - 1 && (opens || streamPartId() !== null)) streamLastText(id, part.text, opens);
        else if (opens) appendPart(id, { ...part });
        else replacePart(id, index, part);
    }
}

/** Write the text of the streaming part. A new text part opens a segment in the store, and the store keeps its text empty until it seals. */
function streamLastText(assistantId: string, text: string, opens: boolean): void {
    if (opens) {
        const key = randomUUIDv7();
        appendPart(assistantId, { type: "text", text: "", key });
        setStreamPartId(key);
    }
    setStreamText(text);
}

/** Append a part to the assistant message. A part after the streaming text part seals that text first, thus the transcript keeps the order of the stream. */
function appendPart(assistantId: string, part: Part): void {
    if (streamPartId() !== null) commitStream();
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === assistantId);
            if (msg) msg.parts.push(part);
        }),
    );
}

/** Replace the store part at `index` with the harness part that a frame changed. */
function replacePart(assistantId: string, index: number, part: MessagePart): void {
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === assistantId);
            const previous = msg?.parts[index];
            if (msg && previous) msg.parts[index] = withScreenState(part, previous);
        }),
    );
}

/**
 * The store copy of a harness part that replaces `previous`: a fresh object, thus Solid reconciles the
 * edit. It keeps the screen state that the harness part does not carry: the key of a text part, and the
 * reject feedback of an ask. Thus the feedback survives a terminal re-emission of its ask, and
 * {@link noteAskFeedback} spreads the part that it finds, thus the two writes converge in either order.
 *
 * The activity line of a tool call is dropped: a call changes when it finishes, and a finished call has
 * an outcome instead. Leaving it would strand "planner: bash" under a chip that already says `ok · 14ms`.
 */
function withScreenState(part: MessagePart, previous: Part): Part {
    if (part.type === "text" && previous.type === "text" && previous.key !== undefined) return { ...part, key: previous.key };
    if (part.type === "data-ask" && previous.type === "data-ask" && previous.feedback !== undefined) return { ...part, feedback: previous.feedback };
    return { ...part };
}

/**
 * A deep copy of a data frame, taken at receipt. In-process `emit` shares mutable references with the
 * agent loop, and `toChatFrame` copies the top level only, thus the store must own each nested object
 * that the loop can still change. A payload is JSON by the wire contract, and a clone fails only on a
 * value that no JSON holds (a function, a proxy). `cause` is `unknown` because a throw carries anything.
 */
function copyOnReceive(frame: ChatPartFrame): Result<ChatPartFrame, { type: "clone_failed"; cause: unknown }> {
    try {
        return ok(structuredClone(frame));
    } catch (cause) {
        return err({ type: "clone_failed", cause });
    }
}

/**
 * How deep in the agent call chain `event` was emitted — 1 for the top-level chat agent, higher for a
 * sub-agent, and 0 for an event that carries no source (a stream delta).
 *
 * The depth selects the INNERMOST sub-agent when several nest: the deepest one is the agent that does
 * the work right now, while each of its callers only waits on it.
 *
 * Private to this file. {@link applySubAgentActivity} is the one caller, and the REPL printer — which
 * shares this file's other event readers — never asks the question.
 */
function eventDepth(event: EmitEventArg): number {
    // `source` is required on loop orchestration events, optional on data parts, and absent on stream
    // events, so `in` is the honest presence read across the union. `callPath` is loop-owned and
    // untrusted, hence the `Array.isArray` guard: a malformed source reads as top-level, not a throw.
    //
    // This repeats the read that `isSubAgentEvent` makes inside `chat_printer.ts`, which is a decision
    // and not an oversight: exporting that file's private `eventSource` for one outside function widens
    // the shared surface for less than the repeat costs. A widening of `EventSource` touches both.
    const src = "source" in event && event.source ? event.source : undefined;
    return src !== undefined && Array.isArray(src.callPath) ? src.callPath.length : 0;
}

/**
 * Route a sub-agent event onto the activity line of the tool call it is running inside.
 *
 * ATTRIBUTION: the event carries `{agentId, callPath}` and no tool-use id, so which call a sub-agent
 * belongs to is not stated on the wire. What is known is that a sub-agent runs INSIDE a tool call, so
 * the newest still-open call is the answer — exact whenever one tool is open, which is the shape of
 * every sub-agent-spawning tool today. With several open concurrently this attributes to the most
 * recent, and is wrong only in the line's placement, never in its content. Widening `EventSource`
 * with the originating tool-use id is the fix if that ever stops being good enough.
 *
 * A no-op when no tool is open: such an event has nothing to be subordinate to, and putting it at
 * the transcript root is exactly the burial the routing rule exists to prevent.
 */
function applySubAgentActivity(event: EmitEventArg): void {
    const id = currentAssistantId;
    if (!id || openTools.size === 0) return;

    const depth = eventDepth(event);
    if (depth < deepestSubAgentDepth) return;
    const label = subAgentActivityLabel(event);
    if (label === null) return;
    deepestSubAgentDepth = depth;

    // The newest open call — `Map` preserves insertion order, and tools are inserted on start.
    const toolUseId = [...openTools.keys()].pop();
    if (toolUseId === undefined) return;

    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (!msg) return;
            const idx = msg.parts.findIndex((p) => p.type === "tool-call" && p.toolCallId === toolUseId);
            const part = msg.parts[idx];
            // Fresh object so Solid reconciles the edit — the same rule every other part write here
            // follows. `label` is a fresh string built at receipt, so no reference to the event survives.
            // The line is screen state of the store alone: the harness part of the call never holds it.
            if (part?.type === "tool-call") msg.parts[idx] = { ...part, activity: label };
        }),
    );
}

/**
 * Echo the user's typed reject feedback onto the live ask card so the transcript shows what they said.
 * The ledger and the model-facing denial carry the feedback on their own; this write is presentation
 * only. It SPREADS the existing part and adds `feedback`, so whatever status a terminal re-emit already
 * folded in survives — and, symmetrically, the store copy of that re-emit ({@link withScreenState})
 * keeps a `feedback` already noted. The two writes therefore converge on the same card regardless of
 * which lands first: the gateway's terminal re-emit (the poll's `data-ask`) and this answer-side echo
 * race, and both are order-independent by construction. A no-op when no card matches — e.g. the
 * pending card was dropped by a mid-turn reset.
 */
export function noteAskFeedback(askId: string, feedback: string): void {
    const id = currentAssistantId;
    if (!id) return;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (!msg) return;
            const idx = msg.parts.findIndex((p) => p.type === "data-ask" && p.id === askId);
            const part = msg.parts[idx];
            // Fresh object so Solid reconciles.
            if (part?.type === "data-ask") msg.parts[idx] = { ...part, feedback };
        }),
    );
}

/** The harness `EmitFn` event union — one event the agent loop, provider, or a tool streams. */
type EmitEventArg = Parameters<EmitFn>[0];

/**
 * Reduce one harness turn event into the store. This is the TUI's counterpart to the REPL printer: it
 * consumes the harness `contracts/` vocabulary directly (never the cli bus event shapes) and writes the
 * store rather than a terminal.
 *
 *   - sub-agent traffic (deeper `callPath`) becomes the activity line of the running tool call, before
 *     any translation — the shared depth filter;
 *   - each other event becomes a frame through `toChatFrame`, and {@link applyFrame} applies it with
 *     `applyChatFrame`: the one translation path of the harness. Thus the live message holds the parts
 *     that the reload of the turn gives, less the differences that the parity test of the harness names;
 *   - `tool-started`/`tool-finished` also open and close the call in `openTools`: the start stamp gives
 *     the fallback duration;
 *   - a `data-ask` docks or settles its prompt, and a report spawn pokes the report-children listing;
 *   - `iteration`/`done` give no frame and are dropped.
 *
 * COPY-ON-RECEIVE: in-process `emit` shares mutable references with the agent loop. A tool frame holds
 * primitives only, and each data frame is deep-copied at receipt ({@link copyOnReceive}), thus the store
 * never retains the received event or its `data` (the same hazard the printer guards).
 */
export function applyEmitEvent(event: EmitEventArg): void {
    // An event outside a turn has no message to land in.
    const id = currentAssistantId;
    if (id === null) return;
    // Sub-agent traffic is ROUTED, not discarded. Its iterations and tool calls are far too numerous
    // to become transcript blocks — that would bury the conversation — but dropping it entirely made
    // a long tool call indistinguishable from a wedged one. It becomes one activity line on the tool
    // block it is running inside, and never reaches the translation below.
    if (isSubAgentEvent(event)) {
        applySubAgentActivity(event);
        return;
    }

    const frame = toChatFrame(event, TOP_LEVEL_SOURCE);
    if (frame === null) return;
    switch (frame.type) {
        case "text-delta":
            applyFrame(frame);
            return;
        case "tool-started":
            openTools.set(frame.toolUseId, Date.now());
            // A new call starts with no innermost agent known, so the depth bar drops. Without this
            // reset the first call's deepest nesting would gate every later call's activity line.
            deepestSubAgentDepth = 0;
            applyFrame(frame);
            return;
        case "tool-finished": {
            const startedAt = openTools.get(frame.toolUseId);
            openTools.delete(frame.toolUseId);
            // The harness measures each call around its own dispatch, thus its
            // figure is the only accurate one. This bracket cannot measure a call:
            // the loop emits every start of a round before it dispatches anything,
            // and every finish after the round settles. Thus the interval between
            // the two events is the round, and each call of a multi-call round
            // observes one identical figure.
            //
            // The bracket stays as the fallback for a harness that sends no
            // duration, which is the read that `ToolFinishedEvent` asks a host for.
            applyFrame(frame.durationMs === undefined && startedAt !== undefined ? { ...frame, durationMs: Date.now() - startedAt } : frame);
            return;
        }
        case "finish":
        case "error":
            // `toChatFrame` gives neither for an emitted event: the outcome of `runChatTurn` ends the turn.
            return;
        default:
            copyOnReceive(frame).match(applyDataFrame, (e) =>
                getLogger("chat").warn({ err: e.cause, type: frame.type }, "chat part dropped: it could not be copied at receipt"),
            );
            return;
    }
}

/** Apply a data frame, then run the side effect of an ask or of a report spawn. */
function applyDataFrame(frame: ChatPartFrame): void {
    applyFrame(frame);
    if (frame.type === "data-ask") {
        // The ask part reconciles under one id: `pending` opens the card and docks the prompt; a
        // terminal re-emission folds latest-wins onto the same card and drains the queue entry. The
        // reader gives a malformed status as `expired`, a terminal status, thus it never docks a prompt.
        const ask = readAskPart(frame);
        if (ask.status === "pending") {
            pushAsk({ askId: ask.askId, title: ask.title, command: ask.command, ...(ask.detail !== undefined ? { detail: ask.detail } : {}) });
        } else {
            settleAsk(ask.askId);
        }
    } else if (frame.type === "data-child-session-started" && frame.threadType === "report") {
        // The spawn wrote its thread row BEFORE it emitted this part, thus a read now finds the
        // row and the entry paints inside the turn. The settle-edge read of `watchReportChildren`
        // stays the authority for the title, which pg seeds after the child's first message.
        if (currentAnalysisId !== null && currentSessionId !== null) void refreshReportChildren(currentAnalysisId, currentSessionId);
    }
}

/** Push the user's turn as its own message, with its text part, re-enforcing the mount cap. */
function pushUserMessage(text: string): void {
    setMessages(
        produce((msgs) => {
            msgs.push({ id: randomUUIDv7(), role: "user", parts: [{ type: "text", text }] });
            while (msgs.length > MESSAGE_CAP) msgs.shift();
        }),
    );
}

/**
 * Open the assistant turn: mint the assistant message with no parts and arm the per-turn adapter
 * state. Each part arrives through {@link applyFrame}, in the order of the stream. Called once at the
 * top of {@link send}. Returns the minted assistant id so {@link send} can stamp its duration on finish
 * and pop it on a pre-run failure.
 */
function startAssistantTurn(sessionId: string): string {
    const assistantId = randomUUIDv7();
    currentAssistantId = assistantId;
    currentSessionId = sessionId;
    turnMessages = [];
    openTools.clear();
    deepestSubAgentDepth = 0;
    setStreamPartId(null);
    setStreamText("");
    setMessages(
        produce((msgs) => {
            msgs.push({ id: assistantId, role: "assistant", parts: [] });
            while (msgs.length > MESSAGE_CAP) msgs.shift();
        }),
    );
    return assistantId;
}

/**
 * The `ctrl+x e for details` affordance appended to a failure banner. Derived from the SAME
 * `leaderSeq("e")` that app.tsx binds to open the details dialog, so the printed label can never
 * drift from the real key (it re-resolves the leader from config, exactly as the binding does).
 */
function detailsHint(): string {
    return `${sequenceLabel(leaderSeq("e"))} for details`;
}

/** Surface a store fault of the turn as a non-fatal notice — the turn itself may have succeeded. */
function reportAppendError(e: DbError | undefined): void {
    if (e) notify({ kind: "warn", text: `Could not save the turn to the thread (${e.type}).` });
}

/**
 * Close every tool call still open when a turn ends, then clear the pairing map. A turn that ends
 * before a tool's `tool-finished` arrives (abort mid-tool, or a failure that races the sink) would
 * otherwise strand the chip at `running` forever at idle — the same "close the open chip honestly"
 * the REPL printer does in its own `finishTurn`. The close goes through {@link applyFrame} as a
 * `tool-finished` with the `error` outcome, the terminal state that the live chip shows. It carries
 * no detail, thus the part keeps the one `tool-started` set.
 *
 * A reload of the same turn gives the call `incomplete`, which the harness records at dispatch. The
 * live surface keeps `error`, because the chip at idle must not read as running.
 *
 * The duration is absent, and deliberately so. No `tool-finished` arrived, thus no call reported
 * what it took. The elapsed time since the start stamp measures the ROUND, because the loop emits
 * every `tool-started` of a round together — so a multi-call round would strand several chips each
 * asserting one identical figure. That is the false claim `durationMs` on the event exists to
 * remove, and an unmeasured call states nothing rather than a number it did not earn.
 */
function drainOpenTools(): void {
    const id = currentAssistantId;
    if (id !== null) {
        for (const toolUseId of openTools.keys()) {
            const call = turnToolCall(id, toolUseId);
            if (call !== undefined) applyFrame({ type: "tool-finished", toolUseId, name: call.toolName, outcome: "error", source: TOP_LEVEL_SOURCE });
        }
    }
    openTools.clear();
    deepestSubAgentDepth = 0;
}

/**
 * Stamp what the finished assistant turn COST: its wall-clock duration and, when the run reported
 * one, its token rollup (the `usage` of the harness message). One write for both because they are
 * stamped at the same three moments and read on the same meta line — splitting them would be two
 * `produce` passes over the store for one settlement. Fresh field writes via `produce` so Solid
 * reconciles the edit; no-op if the message is gone.
 *
 * An absent `turnUsage` is left absent rather than written as `undefined`: nothing reported is not
 * zero spent, and the field's absence is what the meta line reads to render no figure at all.
 */
function stampTurnCost(assistantId: string, startedAt: number, turnUsage: TurnUsage | undefined): void {
    const durationMs = Date.now() - startedAt;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === assistantId);
            if (!msg) return;
            msg.durationMs = durationMs;
            if (turnUsage) msg.usage = turnUsage;
        }),
    );
}

/**
 * Remove the just-minted empty assistant bubble on a pre-run failure and clear the streaming signals
 * that pointed at it. `prepare_failed`/`thread_gone`/`agent_unresolved` bail BEFORE `runAgent`, so this
 * assistant message never got a part (no deltas, no tools by construction) — leaving it mounted would
 * render a blank assistant turn beneath the error banner.
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
 * Flag the assistant message an aborted turn streamed output into as `interrupted` — the muted marker
 * a message block renders as a suffix. This is the live abort path's write; a transcript reload derives
 * the same flag from the persisted message, so both surfaces render one marker. Only ever called for an
 * aborted turn that produced content (a no-output abort drops the shell instead), so the flag never
 * rides an empty message. A fresh field write via `produce` so Solid reconciles the edit; no-op if the
 * message is gone.
 */
function markInterrupted(assistantId: string): void {
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === assistantId);
            if (msg) msg.interrupted = true;
        }),
    );
}

/**
 * Whether the in-flight assistant has produced NOTHING yet: no streamed text, and no part other than
 * an empty text part. Every tool call and every card lands as a part, and so does an empty delta,
 * which is the only case of a part with no content. The structural half of {@link canRetract}, reused
 * by {@link finishTurn}'s abort branch to decide whether an aborted turn left an empty shell to drop.
 * Reads the reactive `streamText`/`messages`, so it re-evaluates in a tracking scope.
 */
function isEmptyAssistantShell(assistantId: string | null): boolean {
    if (!assistantId) return false;
    if (streamText() !== "") return false;
    const msg = messages.find((m) => m.id === assistantId);
    return msg !== undefined && msg.parts.every((p) => p.type === "text" && p.text === "");
}

/**
 * Whether the just-sent message can still be retracted for editing: a turn is busy, its assistant has
 * produced nothing (see {@link isEmptyAssistantShell}), and no retract is already in flight. The retract
 * up-arrow binding reads this for its `enabled`, and {@link retract} re-checks it after the abort settles
 * (a delta can race the press). Folding {@link retractInFlight} in here disables the binding for the whole
 * retract sequence, so a second up-arrow during the settlement window cannot re-enter and run the durable
 * removal a second time. Read inside a tracking scope for reactivity.
 */
export function canRetract(): boolean {
    return chatStatus() === "busy" && isEmptyAssistantShell(currentAssistantId) && !retractInFlight;
}

/**
 * The banner line for a failed turn. An auth-kind provider failure gets a dedicated remedy because
 * the generic rendering buries the one fact that matters — a human has to re-authenticate: in
 * cliproxy mode that names the configured provider and the two ways back in (relaunch, where the
 * launch gate re-authenticates inline, or the forced setup re-login); in direct mode the credential
 * is the user's own env key, so the remedy names the variable instead. Any non-auth failure falls
 * back to the generic cause rendering. Exported for its unit tests.
 *
 * Both modes always have a provider slug to name: {@link resolveModelConnection} requires one for a
 * `direct` connection and defaults a `cliproxy` one to `anthropic`, so there is no slug-less branch
 * to guard. Only the ACCOUNT KIND behind the slug can be unknown (a slug we never recorded — see
 * {@link providerKindForSlug}), and that costs the forced-re-login hint, not the message.
 */
export function turnFailureMessage(cause: unknown): string {
    if (!findAuthCause(cause)) return `The turn failed: ${describeCause(cause)} — ${detailsHint()}`;
    const connection = resolveModelConnection();
    if (connection.mode === "direct") {
        return `The ${connection.provider} endpoint rejected your API key — check ${MODEL_API_KEY_VAR}, then restart the chat. — ${detailsHint()}`;
    }
    return deadLoginMessage(connection.provider);
}

/** The cliproxy remedy for a dead login: the launch gate signs in again, so the user restarts. */
function deadLoginMessage(provider: string): string {
    const kind = providerKindForSlug(provider);
    const relogin = kind ? ` (or run \`inflexa setup --provider ${kind}\`)` : "";
    return `Your ${provider} login has expired or been revoked — restart the chat to sign in again${relogin}. — ${detailsHint()}`;
}

/**
 * Replace the generic banner of a failed cliproxy turn when the proxy's credential state explains the
 * failure. A dead login and a rate limit both reach the harness as a retryable provider error, so only
 * the proxy can tell them apart. The read is an exec round trip, so the generic banner shows first, and
 * the swap happens only if that banner still shows: a new turn or a dismissal wins over a late answer.
 */
function refineProviderFailure(shown: string): void {
    const connection = resolveModelConnection();
    if (connection.mode !== "cliproxy") return;
    void readCredentialVerdict().then((verdict) => {
        if (verdict.isErr()) {
            getLogger("chat").debug({ reason: verdict.error.type }, "credential state unavailable");
            return;
        }
        if (untrack(errorMsg) !== shown) return;
        switch (verdict.value.kind) {
            case "login_dead":
                setErrorMsg(deadLoginMessage(connection.provider));
                return;
            case "rate_limited":
                setErrorMsg(
                    `${connection.provider} is rate-limiting this account — the proxy retries after ${verdict.value.retryAt.toLocaleTimeString()}. Try again then. — ${detailsHint()}`,
                );
                return;
            case "unknown":
                return;
            default: {
                const unhandled: never = verdict.value;
                throw new Error(`unhandled CredentialVerdict: ${JSON.stringify(unhandled)}`);
            }
        }
    });
}

/**
 * Show the engine's `fallbackText` on a turn whose final text never streamed. An empty buffer means
 * no delta arrived since the last seal, so the FINAL assistant message's text never streamed and
 * `fallbackText` cannot duplicate anything on screen. (`fallbackText` is `finalText(result.messages)` —
 * the last assistant message's text — and the buffer empties only when a non-text part follows its
 * deltas.) The fallback goes through {@link applyFrame} as one delta, thus it lands below the part
 * that interrupted the prose, in emission order.
 */
function applyFallbackText(fallbackText: string): void {
    if (streamText().length === 0 && fallbackText.trim().length > 0) applyFrame({ type: "text-delta", text: fallbackText, source: TOP_LEVEL_SOURCE });
}

/**
 * Reduce the engine's {@link TurnOutcome} onto the store for the CURRENT turn (the caller's C1 guard
 * has already dropped a superseded turn's outcome, so `assistantId` still identifies a live message):
 * flush the streamed text (or the engine's `fallbackText` on a delta-less turn), close any open tool
 * chip, stamp what the turn cost (its duration and, when the run reported one, its token rollup),
 * surface an append fault non-fatally, and set the coarse status.
 * `filtered`/`failed`/`prepare_failed`/`thread_gone`/`agent_unresolved` also raise the error banner
 * with an actionable line; `aborted` returns to idle with no error (the user cancelled), having flushed
 * what streamed. `prepare_failed`/`thread_gone`/`agent_unresolved` bail before the loop, so they pop the
 * empty assistant bubble instead.
 */
function finishTurn(outcome: TurnOutcome, assistantId: string, startedAt: number): void {
    // The turn is settling: drop any still-pending asks so the docked prompt can never outlive its
    // turn. Each terminal re-emit already settled its own entry during the turn; this is the final
    // sweep for the abort/failure path where a terminal re-emission may never arrive.
    clearAsks();
    // The turn is ending — clear any armed interrupt window so it never carries into idle or the next turn.
    disarmInterrupt();
    // The turn-end SWEEP of the pending package adds (the package-store-management
    // spec): each approved `store add` of this turn only ENQUEUED. The
    // 10-second gate of the transfer poll flushes a long turn's set early,
    // and this call covers what that gate has not taken yet, so no approved
    // add outlives its turn unflushed. The child is detached, so a flight
    // that takes minutes holds nothing of the next turn; an empty pending
    // set spawns nothing.
    void import("../../modules/libs/store.ts").then((store) => store.startPendingFlushChild());
    switch (outcome.kind) {
        case "ok":
            applyFallbackText(outcome.fallbackText);
            commitStream();
            drainOpenTools();
            stampTurnCost(assistantId, startedAt, outcome.turnUsage);
            reportAppendError(outcome.appendError);
            setChatStatus("idle");
            return;
        case "filtered":
            // A refusal flushes what it carried the way `ok` does (the reply may hold partial
            // prose), then raises the banner: the turn ended without an answer, and only a
            // model change can unblock it, so the user must see why it stopped.
            applyFallbackText(outcome.fallbackText);
            commitStream();
            drainOpenTools();
            stampTurnCost(assistantId, startedAt, outcome.turnUsage);
            // No raw cause rides on `filtered`; keep a structured stand-in so the details
            // dialog shows the endpoint's word rather than an empty view.
            setLastTurnFailure({
                type: "content_filter",
                ...(outcome.rawFinishReason !== undefined ? { rawFinishReason: outcome.rawFinishReason } : {}),
                message: "The model declined this request and stopped the turn.",
            });
            setErrorMsg(
                `The model declined this request and stopped the turn (content filter). Switch the chat model ("Switch chat model" in the command palette), then send the message again. — ${detailsHint()}`,
            );
            reportAppendError(outcome.appendError);
            setChatStatus("error");
            return;
        case "aborted":
            // An aborted turn that produced nothing leaves NO empty assistant shell — the user message
            // alone stands, matching the reload (an abort persists no assistant row). One that streamed
            // output flushes it and carries the `interrupted` marker. Either way `aborted` returns to
            // idle with no error banner — the user cancelled, not a failure.
            if (isEmptyAssistantShell(assistantId)) {
                dropEmptyAssistant(assistantId);
            } else {
                commitStream();
                drainOpenTools();
                stampTurnCost(assistantId, startedAt, outcome.turnUsage);
                markInterrupted(assistantId);
            }
            reportAppendError(outcome.appendError);
            setChatStatus("idle");
            return;
        case "failed":
            commitStream();
            drainOpenTools();
            stampTurnCost(assistantId, startedAt, outcome.turnUsage);
            setLastTurnFailure(outcome.cause);
            {
                const shown = turnFailureMessage(outcome.cause);
                setErrorMsg(shown);
                if (!findAuthCause(outcome.cause)) refineProviderFailure(shown);
            }
            reportAppendError(outcome.appendError);
            setChatStatus("error");
            return;
        case "prepare_failed":
            dropEmptyAssistant(assistantId);
            setLastTurnFailure(outcome.cause);
            setErrorMsg(`Could not start the turn (is Postgres reachable?): ${describeCause(outcome.cause)} — ${detailsHint()}`);
            setChatStatus("error");
            return;
        case "thread_gone":
            dropEmptyAssistant(assistantId);
            // No raw cause rides on `thread_gone`; retain a structured stand-in so the details dialog
            // shows the same reason the banner does rather than an empty view.
            setLastTurnFailure({ type: "thread_gone", message: "This conversation thread is no longer available." });
            setErrorMsg(`This conversation thread is no longer available. — ${detailsHint()}`);
            setChatStatus("error");
            return;
        case "agent_unresolved":
            dropEmptyAssistant(assistantId);
            // No raw cause rides on `agent_unresolved`; keep a structured stand-in shaped like the
            // resolver's own `UnregisteredThreadType` so the details dialog shows the refused type rather
            // than an empty view. A retry cannot change which agents this build registered, so the banner
            // names the type and stops rather than suggesting one.
            setLastTurnFailure({
                type: "unregistered_thread_type",
                threadType: outcome.threadType,
                message: `No agent is registered for "${outcome.threadType}" threads in this build.`,
            });
            setErrorMsg(`No agent is registered for "${outcome.threadType}" threads in this build. — ${detailsHint()}`);
            setChatStatus("error");
            return;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled turn outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * Injectable edges so {@link loadMessages} is unit-testable offline (no Postgres, no booted runtime)
 * — mirrors {@link SendSeams}. Production callers omit the second argument and get the real booted
 * runtime + `ThreadHistory` page reads + the harness replay; tests pass fakes whose page loads resolve
 * on the test's schedule, so an interleaving of two rapid loads is exercisable.
 */
export type LoadSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** Every turn of the thread. Real: `createThreadHistory(pool).loadAll`. */
    readonly loadAll: (pool: Pool, threadId: string) => ReturnType<ThreadHistory["loadAll"]>;
    /**
     * Replay the harness's stored display projections as harness messages, which the store mounts
     * unchanged.
     *
     * Synchronous, and takes nothing but the rows: the harness records what a turn displayed when it
     * displays it, so replay reads that projection and consults nothing else. There is no pool to
     * query, no workspace root to resolve, no tool roster to rebuild a detail from, and nothing that
     * can fail — which is why this seam carries no card/detail resolver and no `Promise`.
     */
    readonly toCortex: (messages: Parameters<typeof storedMessagesToCortex>[0]) => ChatMessage[];
};

const realLoadSeams: LoadSeams = {
    runtime: harnessRuntime,
    loadAll: (pool, threadId) => createThreadHistory(pool).loadAll(threadId),
    toCortex: storedMessagesToCortex,
};

// Monotonic token ordering EVERY asynchronous write to the message store. Two producers write it —
// `loadMessages` (a replay of the durable pg thread) and `send` (the live turn) — and both interleave
// freely: two rapid session swaps race their page reads, and a load started at the boot-ready edge is
// still awaiting Postgres when the submit gate opens on that same edge. Each claims the token at entry
// and re-checks it after every await, so the newest operation STARTED wins regardless of which finishes
// last.
//
// The direction is deliberate: a turn supersedes a load. The load replays state the turn is about to
// append to, while the turn carries the user's live input — so dropping the turn would cost the user
// their message, whereas dropping the load costs only a re-read: `send` re-fires it after the turn
// finishes (the thread now carries the appended turn, so the reload is convergent — see `loadedSessionId`),
// and a later lifecycle edge would re-fire it anyway. `resetHotState` claims the token too, so a load
// started for a swapped-away session can never repopulate the cleared store.
//
// Module-private: only loadMessages / send / resetHotState touch it.
let loadGeneration = 0;

// The session id a transcript load has SUCCESSFULLY mounted into the store, or `null` when none has.
// A load superseded by a boot-edge submit never sets this (the turn bumps `loadGeneration`, dropping
// the load before its page resolves), so `send` re-fires the load after the turn to mount the prior
// history that dropped load would have. Keyed by session id so a stale value from a swapped-away
// session cannot suppress the new session's post-turn reload; `resetHotState` clears it on a swap.
let loadedSessionId: string | null = null;

/**
 * Load a session's transcript from the pg thread history, replacing whatever was mounted.
 * The thread id equals the session id. One `loadAll` read yields every turn; the trailing
 * {@link MESSAGE_CAP} slice keeps the newest MESSAGES, which is the window the TUI mounts. Reading
 * the whole thread costs no more than reading part of it — the store selects and parses every row of
 * a thread either way — so the window is taken here rather than negotiated with the store.
 *
 * A missing pg thread (legacy session, or the runtime not yet booted) renders empty — correct and
 * expected: the legacy SQLite transcript is frozen and not shown here.
 *
 * The store mounts the harness messages of the replay as they are: the renderers read the harness
 * parts, so a reloaded card renders through the same readers as the live one.
 *
 * Concurrency: each call claims a {@link loadGeneration} token at entry and re-checks it after every
 * await; a load superseded by a newer swap silently drops rather than writing a stale transcript.
 */
export async function loadMessages(sessionId: string, seams: LoadSeams = realLoadSeams): Promise<void> {
    const runtime = seams.runtime();
    if (!runtime) return;
    const myLoad = ++loadGeneration;

    const res = await seams.loadAll(runtime.pool, sessionId);
    if (myLoad !== loadGeneration) return; // a newer swap started while the read was in flight — drop it
    if (res.isErr()) {
        setErrorMsg(`Failed to load the conversation: ${res.error.type}`);
        setChatStatus("error");
        return;
    }

    // Re-checked with no await in between, deliberately: this is the invariant the generation token
    // exists for — a superseded load must never reach the store — and stating it at the write itself
    // keeps it true if an await is ever reintroduced above.
    if (myLoad !== loadGeneration) return;
    // The cap is in MESSAGES, matching the unit the live append caps by, and it lands after replay
    // because replay is what produces messages. Record the session this load mounted so `send` knows
    // the history is already on screen and skips its post-turn reload.
    //
    // No error branch: the replay cannot fail. It maps stored projections and touches neither the
    // database nor the filesystem, so the only failure this function still reports is the read's.
    setMessages(seams.toCortex(res.value.flat()).slice(-MESSAGE_CAP));
    loadedSessionId = sessionId;
}

// The in-flight chat request. Module-private: only `send`/`abort`/`resetHotState` touch it, so the
// controller's lifetime is owned alongside the state it cancels.
let abortController: AbortController | null = null;

// The in-flight turn's settlement, retained so a retract can await it: the engine closes the turn
// before the outcome returns, so awaiting the outcome IS awaiting the last durable write (the retract must
// remove the just-written orphan, never race ahead of it), and the outcome carries `opened`, which
// decides the durable step. Null when no turn is in flight. The RESOLVING side is a local closure
// in `send`, so a swap nulling this module ref never strands a waiter mid-await.
let turnSettled: Promise<TurnOutcome> | null = null;
// The in-flight turn's start timestamp, retained so the retract's downgrade path can hand `finishTurn`
// the duration base `send` otherwise owns as a local.
let turnStartedAt = 0;
// Threads whose durable tail-retract faulted and must be retried once before the next send appends.
// Keyed by thread id (== session id); SURVIVES a session swap (the orphan is on that thread regardless
// of which session is mounted), so `resetHotState` deliberately does not clear it. The retention is
// unbounded by design: an entry for a thread never sent to again lives for the process lifetime —
// accepted, since the cost is one string per abandoned thread. It does NOT survive the process: an
// orphan whose heal never got a send to ride on stays on the thread, where it reads as an unanswered
// question — harmless context, which is why the heal is an opportunistic retry rather than durable
// bookkeeping of its own.
const pendingRetract = new Set<string>();

// True from the moment an in-flight `retract` passes its entry gate until its `finally`. Folded into
// `canRetract` so the up-arrow binding disables for the whole sequence, and re-checked at `retract`'s
// own entry so a concurrent second call is a no-op. This flag — NOT the generation token — is what makes
// the durable tail removal run at most once: `runDurableRetract` is deliberately left un-token-gated so a
// session swap mid-retract cannot cancel it (the orphan must still be removed), which leaves re-entry as
// the one remaining path that would reach it twice — the second removal deleting the thread's NEW,
// already-answered tail after the first press removed the orphan. Guarding entry closes that path.
let retractInFlight = false;

/**
 * Clear all hot state for an in-place session swap: cancel any in-flight request, drop the streamed
 * buffer, the error, the messages, and the per-turn adapter state, and return the status to idle.
 * Idempotent.
 */
export function resetHotState(): void {
    // Claim the store-write token so a transcript load still awaiting Postgres for the OLD session
    // drops instead of repopulating the store we are about to clear.
    loadGeneration++;
    // The cleared store no longer holds any session's history, so forget which session was mounted —
    // otherwise a swap back to it could suppress the post-turn reload that would remount its history.
    loadedSessionId = null;
    abortController?.abort();
    // C1: null the token AFTER aborting so an in-flight turn's controller no longer matches its
    // captured `myTurn` — the outcome/late-event guards in `send` then drop everything that turn
    // still emits, covering a reset that is NOT followed by a new send (a new send would otherwise
    // replace the token and supersede the old turn on its own).
    abortController = null;
    currentAssistantId = null;
    currentSessionId = null;
    currentAnalysisId = null;
    turnMessages = [];
    openTools.clear();
    deepestSubAgentDepth = 0;
    // Forget the superseded turn's settlement/duration bases; the send that owns them still resolves
    // its own local promise, so a retract already awaiting it is never stranded by this null.
    turnSettled = null;
    turnStartedAt = 0;
    // Drop any pending asks so a swap/abort mid-decision never leaves a stale docked prompt.
    clearAsks();
    // Clear any armed interrupt window — a swap ends the turn it belonged to.
    disarmInterrupt();
    setStreamPartId(null);
    setStreamText("");
    setErrorMsg(null);
    setLastTurnFailure(null);
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
    /**
     * Re-mount the thread after the turn when the initial transcript load was superseded by this
     * turn's boot-edge submit (see {@link send}). Defaults to {@link loadMessages} with the production
     * load seams; tests inject a fake so the convergent reload is observable offline.
     */
    readonly reloadTranscript?: (sessionId: string) => Promise<void>;
    /**
     * Guarded heal of a pending removal a prior retract left for this thread — retried once before this
     * send appends (see {@link retract}). Defaults to {@link healTailOrphan}, which re-reads the tail and
     * declines unless it is still the lone user turn the failed retract left; tests inject a fake to
     * observe the heal offline.
     */
    readonly healRetract?: (pool: Pool, threadId: string) => ResultAsync<HealOutcome, DbError>;
};

const realSendSeams: SendSeams = { runtime: harnessRuntime, runChatTurn, healRetract: healTailOrphan };

/**
 * Send a user turn through the shared harness turn engine. Owns the turn-scoped
 * {@link AbortController} so {@link abort} (and a session swap) can cancel it. Flow: guard a booted
 * runtime → push the user message → open the assistant turn → drive `runChatTurn` with a per-turn
 * streaming wrapper whose deltas feed {@link applyEmitEvent} → reduce the outcome onto the store. The
 * thread id equals the session id, and the session carries a length-1 `callPath` identifying the TUI
 * surface so a chat-launched run stamps `cortex_runs.thread_id`.
 *
 * TURN-GENERATION GUARD: the fresh {@link AbortController} instance IS this turn's identity
 * token. A session swap or {@link resetHotState} replaces (or nulls) the module `abortController`
 * mid-flight — while the OLD turn is still unwinding (its last pg round-trip; a tool ignoring
 * its signal), a NEW turn can already be streaming into a new session. So every event this turn emits
 * flows through one guarded sink that drops it once the token no longer matches, and the outcome is
 * dropped on the same check — a superseded turn NEVER touches the new turn's streaming signals,
 * status, error, or messages. Its writes already ran (correctly) inside the engine on the old
 * thread; the only remaining work is UI-visible, so dropping it is exactly right.
 */
export function send(opts: { sessionId: string; analysisId: string; userText: string }, seams: SendSeams = realSendSeams): Promise<void> {
    // Held against run-outcome records for the WHOLE turn, because the engine writes each round
    // inside `runChatTurn`, from the opening to the close: releasing earlier would let a record splice between
    // this turn's rows. Turns are NOT serialized against each other — that ordering already has an
    // answer in the generation and abort tokens — and with no record pending the body runs
    // synchronously, so the turn's hot state is armed before the first yield exactly as before.
    return runTurnWrite(opts.sessionId, () => sendLocked(opts, seams));
}

async function sendLocked(opts: { sessionId: string; analysisId: string; userText: string }, seams: SendSeams): Promise<void> {
    setErrorMsg(null);
    setLastTurnFailure(null);
    const runtime = seams.runtime();
    if (!runtime) {
        // The app's boot gate should refuse a submit before this; a defensive terminal state beats a crash.
        setErrorMsg("The chat runtime is not ready yet — wait for boot to finish.");
        setChatStatus("error");
        return;
    }

    // Claim the store-write token BEFORE any awaited or store-writing step in this send. `Chat` fires
    // `loadMessages` the instant boot reaches `ready` — the same instant `handleSubmit`'s gate opens — so
    // a message pre-typed during the boot animation lands while that load is still awaiting its page read.
    // Without this claim the load's trailing `setMessages` would replace the store wholesale, deleting the
    // user's message and the in-flight assistant turn and stranding `currentAssistantId` on a message no
    // longer mounted (every later part would then silently no-op). Same hazard on an in-place session swap.
    // Claimed ahead of the heal below so the heal's await sits inside this turn's token-owned sequence.
    const myTurnLoad = ++loadGeneration;

    // Heal a pending durable retract for this thread before this turn appends: a prior retract's tail
    // removal faulted, possibly leaving an orphan turn on the thread. Retry it ONCE — success removes
    // the orphan; a second failure just proceeds (an unanswered orphan is harmless context, and a
    // transient database fault must never wedge the conversation). Rare by construction: the flag is set
    // only by a failed retract. The retry goes through the GUARDED heal, which declines when the tail is
    // an answered turn — the failure that scheduled it cannot tell a rolled-back retract from one whose
    // commit landed but lost its acknowledgement, and only the second read distinguishes them.
    if (pendingRetract.has(opts.sessionId)) {
        pendingRetract.delete(opts.sessionId);
        await (seams.healRetract ?? healTailOrphan)(runtime.pool, opts.sessionId).match(
            (result) => {
                if (result.kind !== "retracted")
                    getLogger("chat").debug({ threadId: opts.sessionId, kind: result.kind }, "pending retract heal removed nothing");
            },
            (e) => getLogger("chat").debug({ err: e, threadId: opts.sessionId }, "pending retract heal failed; proceeding with send"),
        );
        // The heal is awaited work inside this token-claimed sequence, so the swap re-check after it is
        // mandatory: during the await a session swap's `resetHotState` can claim a newer token and clear
        // the store. Bail quietly — the user swapped away mid-send. Falling through would push this
        // session's message straight into the swapped-in session's cleared store: `pushUserMessage` below
        // is a synchronous write with no further token check.
        if (loadGeneration !== myTurnLoad) return;
    }

    pushUserMessage(opts.userText);
    const assistantId = startAssistantTurn(opts.sessionId);
    // The scope of the report-children refresh that a report spawn of this turn pokes.
    currentAnalysisId = opts.analysisId;
    setChatStatus("busy");
    const startedAt = Date.now();

    abortController = new AbortController();
    // The controller instance is this turn's token. Captured once; the module `abortController`
    // may be reassigned/nulled by a swap or reset while this turn is in flight.
    const myTurn = abortController;

    // Retain this turn's settlement + duration base so a retract can await the engine (the close
    // lands before the outcome returns) and decide the durable step. `settleTurn` is a LOCAL closure so
    // it resolves the waiter regardless of a swap nulling the module `turnSettled` mid-flight.
    let settleTurn!: (o: TurnOutcome) => void;
    turnSettled = new Promise<TurnOutcome>((resolve) => {
        settleTurn = resolve;
    });
    turnStartedAt = startedAt;

    // Every event this turn produces — streamed deltas, tool lifecycle, cards — passes through here.
    // Once a swap/reset supersedes the turn (`abortController !== myTurn`), late events are dropped at
    // this one boundary, so a stale turn can never write the new turn's streaming signals or store.
    const emitForTurn = (event: EmitEventArg): void => {
        if (abortController === myTurn) applyEmitEvent(event);
    };

    // Per-turn streaming wrapper: forward each provider text delta into the adapter as a `text-delta`
    // event, so answers accumulate in `streamText` as they arrive. Only this top-level
    // loop runs on the wrapper — sub-agent loops were wired to the plain provider at assembly.
    const session = buildChatSession(opts.analysisId, opts.sessionId);

    // The engine is contractually non-rejecting — every failure returns a `TurnOutcome`. But `turnSettled`
    // is awaited by the retract path, so this promise MUST settle on EVERY exit: a contract-violating throw
    // that skipped `settleTurn` below would hang a waiting retract forever with the status stuck busy. Catch
    // a rejection, synthesize the established `failed` outcome — carrying the throw (typed `unknown`, since a
    // throw carries anything) as its `cause` — and fall through to the SAME settle + failure handling as a
    // real `failed` outcome, so the UI shows the failure banner rather than hanging.
    const outcome: TurnOutcome = await seams
        .runChatTurn({
            pool: runtime.pool,
            agents: runtime.agents,
            chat: (emit) => createStreamingChat(runtime.conversation.provider, (text) => void emit({ type: "text-delta", text })),
            session,
            emit: emitForTurn,
            signal: myTurn.signal,
            // The booted runtime's ONE recorder, forwarded into this turn's `runAgent` options. Without
            // it the loop silently falls back to the harness's no-op and the conversation agent's calls
            // never reach the ledger — see `RunChatTurnArgs.usageRecorder`.
            usageRecorder: runtime.usageRecorder,
            // Bind the ask seam to THIS turn's scope: a `ctx.ask` tool pauses on the runtime gateway
            // carrying the turn's analysis/thread, its abort signal, and its guarded emit sink, so the
            // gateway's `data-ask` emissions and its poll ride the same signal and sink as every other
            // turn event (a swap/reset that supersedes the turn drops them at `emitForTurn`).
            ask: (req, emit) =>
                runtime.askGateway.ask(req, {
                    analysisId: opts.analysisId,
                    userId: LOCAL_ASK_USER_ID,
                    threadId: opts.sessionId,
                    signal: myTurn.signal,
                    emit,
                }),
            analysisId: opts.analysisId,
            // The pg thread binds 1:1 to the session, so a plan launched here stamps its run.
            threadId: opts.sessionId,
            userInput: opts.userText,
        })
        // A rejection gives no sign that the opening landed, and a durable retract of a turn that did
        // not land would remove an earlier turn.
        .catch((cause: unknown): TurnOutcome => ({ kind: "failed", opened: false, cause }));

    // Settle the retained turn promise BEFORE the supersession guard: a retract IS a superseding writer
    // (it claimed the token to abort this turn) and must still observe this outcome — it awaits
    // `turnSettled` to read `opened` and decide the durable step. `settleTurn` is the local
    // closure, so this resolves even when a swap has nulled the module `turnSettled`.
    settleTurn(outcome);

    // C1: the turn was superseded while the engine unwound — drop the outcome whole. Its `appendError`
    // toast is dropped too: it would otherwise fire over the new session's UI, and the persistence
    // fault is already reflected on the old thread's state, not the surface's. The token re-check is
    // the same rule from the other producer's side: any store-writing operation started after this turn
    // owns the store now — a retract that claimed the token takes over this turn's teardown entirely.
    if (abortController !== myTurn || loadGeneration !== myTurnLoad) return;

    finishTurn(outcome, assistantId, startedAt);

    // Close the emit sink now the turn is settled. The supersession guard above only drops events from
    // a turn a swap/reset REPLACED; for a turn that simply finished, a tool that ignored its abort
    // signal (or any other late straggler) still satisfies `abortController === myTurn`, so without
    // this it would append to the finished message or flip a drained chip. Nulling the token the sink
    // matches on drops every such event at `emitForTurn`; the per-turn adapter state is cleared
    // alongside so nothing dangles at the finished turn.
    abortController = null;
    currentAssistantId = null;
    currentSessionId = null;
    currentAnalysisId = null;
    turnMessages = [];
    turnSettled = null;
    turnStartedAt = 0;

    // Retry a transcript load THIS turn superseded. `Chat` fires the initial load at the boot-ready
    // edge — the same instant the submit gate opens — so a message pre-typed while booting bumps
    // `loadGeneration` and drops that load before its first page resolves, leaving the prior history
    // unmounted until a manual session swap. The appended turn is now in the pg thread, so the reload
    // is convergent: it re-mounts the history plus this turn. Skipped when a load already completed for
    // this session (the history is already on screen) — the reload replaces the store wholesale, so
    // re-running it on every turn would needlessly remount and repaint the whole window.
    if (loadedSessionId !== opts.sessionId) {
        await (seams.reloadTranscript ?? loadMessages)(opts.sessionId);
    }
}

/** Cancel the in-flight chat request, if any (the abort keybinding). */
export function abort(): void {
    abortController?.abort();
    // Once the turn's abort is fired there is nothing left to interrupt, so disarm the double-press
    // window now — the status hint falls back to its resting form immediately rather than staying
    // accented through the engine's unwind. `finishTurn` disarms on settlement as a backstop; disarming
    // here on ctrl+c's abort path is equally correct for the same reason. Idempotent, so the two never clash.
    disarmInterrupt();
}

/**
 * Splice a retracted turn's user message and its empty assistant placeholder out of the live store,
 * clearing the streaming signals that pointed at the placeholder. The retract-path mirror of
 * {@link dropEmptyAssistant}: `canRetract` guaranteed the assistant held only its empty text part, so
 * removing both leaves the transcript exactly as it stood before the send.
 */
function spliceRetractedTurn(userId: string, assistantId: string): void {
    setStreamPartId(null);
    setStreamText("");
    setMessages(
        produce((msgs) => {
            for (let i = msgs.length - 1; i >= 0; i--) {
                const id = msgs[i]!.id;
                if (id === assistantId || id === userId) msgs.splice(i, 1);
            }
        }),
    );
}

/**
 * Close the emit sink + per-turn adapter state after a retract took over teardown. `send`'s own
 * cleanup was skipped (its C1 guard dropped once the retract claimed the token), so the retract closes
 * the sink here: nulling `abortController` drops any late straggler event at `emitForTurn`, and the
 * adapter ids are cleared so nothing dangles at the removed turn. Mirrors `send`'s post-turn cleanup.
 */
function closeTurnState(): void {
    disarmInterrupt();
    abortController = null;
    currentAssistantId = null;
    currentSessionId = null;
    currentAnalysisId = null;
    turnMessages = [];
    openTools.clear();
    deepestSubAgentDepth = 0;
    turnSettled = null;
    turnStartedAt = 0;
}

/**
 * Whether the aborted turn actually LANDED an orphan turn on the thread — the precondition for running
 * the durable retract. A kind that ran carries `opened`, and `prepare_failed`/`thread_gone`/`agent_unresolved`
 * wrote nothing. Removing the tail when none of this turn's rows are there would delete an EARLIER
 * turn's real history — hence the gate.
 */
function turnAppendLanded(outcome: TurnOutcome): boolean {
    switch (outcome.kind) {
        case "ok":
        case "filtered":
        case "aborted":
        case "failed":
            return outcome.opened;
        case "prepare_failed":
        case "thread_gone":
        case "agent_unresolved":
            return false;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled turn outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * Injectable edges so {@link retract}'s durable half is unit-testable offline — mirrors {@link SendSeams}.
 * Production callers omit the trailing argument and get the real booted runtime + the embedder's tail
 * retract; tests pass a fake `retractTurn` resolving on their schedule.
 */
export type RetractSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** Remove the thread's tail turn durably. Real: {@link retractTailTurn} over the turn's pool. */
    readonly retractTurn: (pool: Pool, threadId: string) => ResultAsync<RetractOutcome, DbError>;
};

const realRetractSeams: RetractSeams = { runtime: harnessRuntime, retractTurn: retractTailTurn };

/**
 * Run the durable tail removal and reduce its outcome. `retracted` removed the orphan; `empty-thread`/
 * `no-user-turn` removed nothing (the opening never landed, or an anomalous tail) — a benign no-op with
 * a debug log, never surfaced. A `DbError` is retained as a pending retry for the thread (the next send
 * heals it) and surfaced as an error notice — token-gated, since a swap that superseded the UI writes
 * has already moved the surface on. The conversation is never blocked on it.
 */
async function runDurableRetract(pool: Pool, threadId: string, myRetract: number, seams: RetractSeams): Promise<void> {
    await seams.retractTurn(pool, threadId).match(
        (result) => {
            switch (result.kind) {
                case "retracted":
                    return;
                case "empty-thread":
                case "no-user-turn":
                    getLogger("chat").debug({ threadId, kind: result.kind }, "tail retract removed nothing");
                    return;
                default: {
                    const _exhaustive: never = result;
                    throw new Error(`unhandled retract outcome: ${JSON.stringify(_exhaustive)}`);
                }
            }
        },
        (e) => {
            pendingRetract.add(threadId);
            if (loadGeneration === myRetract) notify({ kind: "error", text: `Could not retract the message from the thread (${e.type}).` });
        },
    );
}

/**
 * Take back the just-sent message for editing while the turn is in flight and the assistant has
 * produced nothing (see {@link canRetract}). The up-arrow binding gates on `canRetract` and invokes
 * this; `seedComposer` is the widget seam the UI supplies to put the original text back in the composer
 * (cursor placement is the widget's job), keeping this hook free of renderable refs.
 *
 * Sequence: claim the store-write token → `abort()` → await the turn's settlement → re-validate the
 * no-output window. A racing delta downgrades to a plain interrupt (message kept, notice, nothing
 * removed). Otherwise run the durable tail retract — SKIPPED when no orphan landed (the opening did not
 * land, or a prepare/thread bail) — and only then splice the live store and seed the composer, so the transcript
 * and the composer move together rather than either side of a database round-trip. Claiming
 * the token makes this a first-class store writer: a session swap that supersedes it mid-sequence drops
 * every remaining store write and the composer seed, while the durable removal — committed at the
 * keypress and thread-scoped — still completes against the old thread.
 *
 * Re-entrant-safe: {@link retractInFlight} guards entry, so a second press during the settlement window
 * is a no-op. That guard, not the generation token, is what keeps the durable removal once-only — the
 * token deliberately does NOT gate the durable step (a swap must not cancel it), so re-entry would be the
 * only way to run it twice (see the flag's declaration).
 */
export async function retract(seedComposer: (text: string) => void, seams: RetractSeams = realRetractSeams): Promise<void> {
    // The binding gates on `canRetract`, but re-check so a stray or racing call is still safe. This runs
    // BEFORE `retractInFlight` is set, so a first press sees its own flag clear and proceeds while a second
    // press during the settlement window sees the flag (folded into `canRetract`) and bails here.
    if (!canRetract()) return;
    retractInFlight = true;
    try {
        const runtime = seams.runtime();
        const settled = turnSettled;
        const assistantId = currentAssistantId;
        const threadId = currentSessionId;
        const startedAt = turnStartedAt;
        if (!runtime || !settled || !assistantId || !threadId) return;

        // The user message opening this turn sits directly before the assistant placeholder: capture its id
        // (to splice) and its text (to seed the composer) before the abort can move anything.
        const assistantIdx = messages.findIndex((m) => m.id === assistantId);
        const userMsg = assistantIdx > 0 ? messages[assistantIdx - 1] : undefined;
        if (!userMsg || userMsg.role !== "user") return;
        const userId = userMsg.id;
        const firstPart = userMsg.parts[0];
        const originalText = firstPart?.type === "text" ? firstPart.text : "";

        // Claim the store-write token: the retract becomes a first-class store writer a later load or
        // session swap can supersede, and the aborted turn's own `finishTurn` drops at `send`'s C1 guard —
        // so the teardown below is the sole writer for this turn.
        const myRetract = ++loadGeneration;

        // Fire the turn's abort so the engine unwinds and closes the turn.
        abortController?.abort();

        // Await settlement — the close has run by the time the engine returns, so the durable removal below
        // targets the just-written orphan rather than racing ahead of it.
        const outcome = await settled;

        // A text delta (or any part) can race the keypress. If output landed, DOWNGRADE to a plain
        // interrupt: keep the message, run the normal settle (flush + interrupted marker + idle) via
        // `finishTurn`, and remove nothing. Token-gated — a swap mid-await already cleared and re-owns the store.
        if (!isEmptyAssistantShell(assistantId)) {
            if (loadGeneration === myRetract) {
                finishTurn(outcome, assistantId, startedAt);
                closeTurnState();
                notify({ kind: "info", text: "Kept your message — the assistant had already started answering." });
            }
            return;
        }

        // A genuine no-output retract. The durable removal goes FIRST, while the transcript still shows the
        // message and the status still reads busy, so that the whole visible transition — message gone,
        // text back in the composer, idle — lands as one step below. Splicing first would instead put the
        // latency of a database round-trip between "your message disappeared" and "here it is back",
        // leaving the user staring at an empty focused composer and a transcript missing what they just
        // sent, with no indication which way it is going to resolve. The removal is thread-scoped and
        // already committed to at the keypress, so it runs even when a swap supersedes the UI writes —
        // but only when this turn's append actually landed an orphan to remove.
        if (turnAppendLanded(outcome)) {
            await runDurableRetract(runtime.pool, threadId, myRetract, seams);
        }

        // The visible half, token-gated: a swap during the removal above already cleared the store and
        // re-owns the surface, and the composer is shared across sessions, so seeding then would drop this
        // session's text into the swapped-in one. `closeTurnState` nulls the emit sink FIRST so a late
        // straggler event cannot re-append to the message being removed. The seed is a request, not a
        // command — the widget declines it if the user has started typing (see `retractLayer`).
        if (loadGeneration === myRetract) {
            closeTurnState();
            spliceRetractedTurn(userId, assistantId);
            seedComposer(originalText);
            setChatStatus("idle");
        }
    } finally {
        // Clear the in-flight guard on EVERY exit (early return, throw, or normal completion) so a later
        // legitimate retract is never permanently wedged. This `finally` is the flag's sole owner.
        retractInFlight = false;
    }
}

/** One openable the `o` binding or the "Browse artifacts…" picker can act on: the analysis scope + the entry. */
export type SessionOpenable = { analysisId: string; entry: OpenableEntry };

/**
 * The openable entries of one part, read through the shared readers that the card renderer uses: a
 * pixel-shaped presentation gives one entry, and a file reference gives one entry per file.
 */
function openableEntries(part: Part): OpenableEntry[] {
    switch (part.type) {
        case "data-presentation": {
            // The reader deep-copies the chart spec, and a store proxy cannot be cloned, thus the reader
            // gets the plain part that the proxy wraps.
            const view = readPresentation(unwrap(part));
            return view.shape === "card" ? [view.entry] : [];
        }
        case "data-file-reference":
            return readFileReference(part).entries;
        default:
            return [];
    }
}

/**
 * Every openable card entry currently in the transcript, NEWEST first (latest message + latest-emitted
 * part first), excluding the non-openable `unavailable` entries (a failed preview has nothing to open).
 * The `o` binding opens `[0]` (the most recent); the picker lists them all. `analysisId` is the analysis
 * of the open workspace, because the transcript of a session belongs to that analysis, and each entry
 * resolves against its workspace root. Read in a tracking scope — reactive on the message store.
 */
export function sessionOpenables(analysisId: string): SessionOpenable[] {
    const out: SessionOpenable[] = [];
    for (const message of [...messages].reverse()) {
        for (const part of [...message.parts].reverse()) {
            for (const entry of openableEntries(part).reverse()) {
                if (entry.target.kind !== "unavailable") out.push({ analysisId, entry });
            }
        }
    }
    return out;
}

/** The most recently emitted plan card in the mounted transcript, as the card renders it, or null when none exists. */
export function latestPlanCard(): { planId: string; title: string; steps: PlanCardStepView[] } | null {
    for (const message of [...messages].reverse()) {
        for (const part of [...message.parts].reverse()) {
            if (part.type === "data-plan") return readPlanCard(part);
        }
    }
    return null;
}

/**
 * The session's own sent prompts, NEWEST first — the entry list the composer's up/down history recall
 * steps through. Walks the mounted transcript for `user` turns, joining each one's text parts in order
 * (a live send makes exactly one; a thread replay can give several) and skipping any turn whose text
 * comes out empty.
 *
 * Runs of identical ADJACENT prompts collapse to a single entry, so re-sending the same text after a
 * failed turn costs one recall step rather than two. Identical prompts separated by a different one stay
 * DISTINCT — which is exactly why recall must address entries by a STORED position and never by searching
 * this list for the buffer's text: a search resolves every occurrence to the newest one, so stepping back
 * from an older duplicate would silently skip every entry between them.
 *
 * The exclusions are structural, not a filter kept here: {@link pushUserMessage} is called only by `send`,
 * so docked-ask answers and the `/quit` aliases never become user messages, and a retract splices its turn
 * out of the store. History therefore reaches exactly as far as the mounted window ({@link MESSAGE_CAP});
 * older turns stay in the thread, unmounted. Read in a tracking scope — reactive on the message store.
 */
/**
 * Whether {@link promptHistory} would return anything — the cheap existence check the recall binding asks
 * at CONFIG time, on every keystroke, to decide whether `up` has somewhere to go or should be left to the
 * editor. Returns at the first qualifying turn instead of building the whole list, so the common case costs
 * a step or two from the tail rather than a walk of the mounted window. The full list is built only when a
 * press actually moves the recall position. Read in a tracking scope — reactive on the message store.
 */
export function hasPromptHistory(): boolean {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const message = messages[mi];
        if (!message || message.role !== "user") continue;
        for (const part of message.parts) {
            if (part.type === "text" && part.text) return true;
        }
    }
    return false;
}

export function promptHistory(): string[] {
    const out: string[] = [];
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const message = messages[mi];
        if (!message || message.role !== "user") continue;
        let text = "";
        for (const part of message.parts) {
            if (part.type === "text") text = text ? `${text}\n${part.text}` : part.text;
        }
        // Adjacency is over PROMPTS, not raw messages: consecutive user turns are separated by their
        // assistant replies in the store, so the comparison is against the previously kept entry.
        if (!text || out[out.length - 1] === text) continue;
        out.push(text);
    }
    return out;
}
