import { randomUUIDv7 } from "bun";
import type { ResultAsync } from "neverthrow";
import { createEffect, createSignal, on } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import {
    applyChatFrame,
    checkChatPart,
    type ChatEvent,
    type ChatFrame,
    type ChatMessage,
    type ChatPartFrame,
    type MessagePart,
    type TokenUsageRollup,
    type ToolCallPart,
} from "@inflexa-ai/harness/contracts/index.js";

import type { MessageList, RetractResponse, ThreadSummary, TurnList, TurnSummary } from "../../api/conversation.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { abortTurn, createChatTurn, fetchMessages, fetchThread, fetchTurn, fetchTurns, retractTurn, type ChatTurnStream } from "../../client/conversation.ts";
import { describeCause } from "../../lib/cause.ts";
import { getLogger } from "../../lib/log.ts";
import { isSubAgentEvent, readFileReference, readPlanCard, readPresentation, subAgentActivityLabel } from "../../modules/harness/chat_printer.ts";
import { leaderSeq, sequenceLabel } from "../keymap.ts";
import { clearAsks, pushAsk, settleAsk } from "./asks.ts";
import { refreshReportChildren } from "./report_children.ts";
import { bootState } from "./boot.ts";
import { notify } from "./notice.ts";
import { chatStatus, setChatStatus } from "./status.ts";
import { publishThreadRow } from "./thread.ts";
import type { OpenableEntry, Part, PlanCardStepView } from "../../types/session.ts";

// The chat's hot state — the message list, the in-flight streaming buffer, and the last error —
// held here (not inside `app.tsx`) so the holder of the state is decoupled from its renderer, the
// same split as `status.ts`. The `Chat` component (`tui/components/chat.tsx`) renders it and drives
// the load on session/boot changes; the `Sidebar` reads `messageCount`; `app.tsx` only composes
// them. The transcript arrives two ways, BOTH writing this store directly: `send` posts one turn to
// the local server and feeds each frame of its stream through `applyServerFrame`, which builds the
// live message with the shared translation path of the harness, and `loadMessages` mounts the
// transcript that the server replays. One chat screen is mounted at a time, so a module singleton is
// correct. The coarse activity state stays in `status.ts`.

/**
 * One message as the store holds it: the harness message, whose parts can carry the screen state of
 * the live turn (see {@link Part}). A reload mounts the replayed harness messages unchanged.
 *
 * A `system` message is not a turn: the harness gives that role to a record of out-of-band work on
 * the thread (an analysis run's outcome, in an older thread), and to the divider of a compaction. The
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

const [messages, setMessages] = createStore<UIMessage[]>([]);
const [streamText, setStreamText] = createSignal("");
const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
// The detail lines behind the current failure banner, kept so the "turn error details" dialog can
// render the whole cause that the one-line banner collapses. The server sends them in the summary of
// the turn, and a refusal or a lost stream gives the one line of its client error. Cleared on every
// new turn.
const [lastTurnFailure, setLastTurnFailure] = createSignal<string[] | null>(null);

/** The conversation's messages — read in a tracking scope to react to appends/edits. */
export { messages };
/** The live streaming text for the in-flight part — read reactively. */
export { streamText };
/** The id of the part currently streaming, or `null` — read reactively. */
export { streamPartId };
/** The last chat error to surface as a banner, or `null` — read reactively. */
export { errorMsg };
/** The detail lines of the last failed turn, or `null` — read reactively for the details dialog. */
export { lastTurnFailure };

// The text of the banner when a state of the server raised it: no server answers, or the server drains or has
// no runtime. Such a banner says nothing about the conversation, thus the ready edge of the boot clears it
// (`watchServerStateErrors`). Compared by text, thus a later banner of a different cause is never cleared.
let serverStateBanner: string | null = null;

/** Raise a banner that a state of the server caused, and record it for the clear at the ready edge. */
function setServerStateError(text: string): void {
    setErrorMsg(text);
    serverStateBanner = text;
}

/** True when `e` says that no server answers, or that the server drains or has no runtime. */
function isServerStateError(e: ClientError): boolean {
    return e.type === "unreachable" || (e.type === "http" && (e.body.error === "unavailable" || e.body.error === "draining"));
}

/**
 * Clear the banner and the error state at each `ready` edge of the boot when a state of the server raised them.
 * A failure of the model stays. Call once from `App`, inside its reactive owner.
 */
export function watchServerStateErrors(): void {
    createEffect(
        on(
            () => bootState().phase,
            (phase) => {
                if (phase !== "ready") return;
                const banner = serverStateBanner;
                serverStateBanner = null;
                if (banner === null || errorMsg() !== banner) return;
                setErrorMsg(null);
                setLastTurnFailure(null);
                if (chatStatus() === "error") setChatStatus("idle");
            },
        ),
    );
}

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

// Per-turn adapter state. `currentAssistantId` is the message every frame appends parts to;
// `currentSessionId` and `currentAnalysisId` scope the report-children refresh that a spawn pokes
// and the retract of the turn; `openTools` pairs a `tool-finished` with its `tool-started` by tool-use
// id (storing only the start timestamp — a primitive). Module-private: only the send lifecycle touches
// them.
let currentAssistantId: string | null = null;
let currentSessionId: string | null = null;
let currentAnalysisId: string | null = null;
// The live turn as the shared translation path builds it: `applyChatFrame` takes it and gives the
// next one, and it holds harness parts only. The assistant message in the store mirrors it part for
// part, at the same index, because each frame changes one part in place or appends one. The store
// adds the screen state, and the text of the streaming part rides `streamText` until the part seals.
let turnMessages: ChatMessage[] = [];
const openTools = new Map<string, number>();
// The deepest sub-agent call depth seen while the current tool call has been open. Only a frame at
// least that deep may write the activity line, which is what "show the INNERMOST sub-agent" means:
// while a depth-3 agent is working, its depth-2 caller is merely waiting on it and should not
// overwrite the line with its own state. Reset whenever a tool call opens.
//
// Trade-off accepted: when the deepest sub-agent finishes, the bar stays raised for the rest of the
// call, so a shallower agent's later activity is not shown. The alternative — tracking each depth's
// liveness — buys a more accurate line in the tail of a call whose line disappears moments later
// anyway.
let deepestSubAgentDepth = 0;

// The source of the two frames that the adapter makes itself: the fallback text and the close of an
// open call. `applyChatFrame` reads only the depth of a source, and no part keeps the source of a
// frame, thus a path of one entry is the whole of what this value must give.
const TOP_LEVEL_SOURCE: ChatEvent["source"] = { agentId: "chat", callPath: ["chat"] };

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
 * How deep in the agent call chain `frame` was emitted — 1 for the top-level chat agent, higher for a
 * sub-agent, and 0 for a frame that carries no source.
 *
 * The depth selects the INNERMOST sub-agent when several nest: the deepest one is the agent that does
 * the work right now, while each of its callers only waits on it.
 *
 * Private to this file. {@link applySubAgentActivity} is the one caller, and the REPL printer — which
 * shares this file's other frame readers — never asks the question.
 */
function eventDepth(frame: ChatFrame): number {
    // `callPath` arrives over the wire, hence the `Array.isArray` guard: a malformed source reads as
    // top-level, not a throw.
    //
    // This repeats the read that `isSubAgentEvent` makes inside `chat_printer.ts`, which is a decision
    // and not an oversight: exporting that file's private `eventSource` for one outside function widens
    // the shared surface for less than the repeat costs. A widening of `EventSource` touches both.
    const src = frame.source;
    return src !== undefined && Array.isArray(src.callPath) ? src.callPath.length : 0;
}

/**
 * Route a sub-agent frame onto the activity line of the tool call it is running inside.
 *
 * ATTRIBUTION: the frame carries `{agentId, callPath}` and no tool-use id, so which call a sub-agent
 * belongs to is not stated on the wire. What is known is that a sub-agent runs INSIDE a tool call, so
 * the newest still-open call is the answer — exact whenever one tool is open, which is the shape of
 * every sub-agent-spawning tool today. With several open concurrently this attributes to the most
 * recent, and is wrong only in the line's placement, never in its content. Widening `EventSource`
 * with the originating tool-use id is the fix if that ever stops being good enough.
 *
 * A no-op when no tool is open: such a frame has nothing to be subordinate to, and putting it at
 * the transcript root is exactly the burial the routing rule exists to prevent.
 */
function applySubAgentActivity(frame: ChatFrame): void {
    const id = currentAssistantId;
    if (!id || openTools.size === 0) return;

    const depth = eventDepth(frame);
    if (depth < deepestSubAgentDepth) return;
    const label = subAgentActivityLabel(frame);
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
            // follows. The line is screen state of the store alone: the harness part of the call never
            // holds it.
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

/**
 * Reduce one frame of the chat stream of the server into the store. This is the TUI's counterpart to
 * the REPL printer: it consumes the harness `contracts/` vocabulary directly and writes the store
 * rather than a terminal.
 *
 *   - sub-agent traffic (deeper `callPath`) becomes the activity line of the running tool call, before
 *     any translation — the shared depth filter;
 *   - each other frame goes to {@link applyFrame}, which applies it with `applyChatFrame`: the one
 *     translation path of the harness. Thus the live message holds the parts that the reload of the
 *     turn gives, less the differences that the parity test of the harness names;
 *   - `tool-started`/`tool-finished` also open and close the call in `openTools`: the start stamp gives
 *     the fallback duration;
 *   - a data frame is checked with `checkChatPart` at receipt: an invalid part of a known type is
 *     dropped with a warning, and a part of a type that this build does not know passes unchanged;
 *   - a `data-ask` docks or settles its prompt, and a report spawn pokes the report-children listing;
 *   - `finish`/`error` end the stream, and the driver of the turn reads them, thus they apply nothing.
 *     Only a sub-agent gives an `iteration`, thus the routing above takes each one.
 *
 * Each frame is a fresh object that the client parsed from the stream, thus the store shares no
 * reference with a producer.
 */
export function applyServerFrame(frame: ChatFrame): void {
    // A frame outside a turn has no message to land in.
    const id = currentAssistantId;
    if (id === null) return;
    // Sub-agent traffic is ROUTED, not discarded. Its tool calls are far too numerous to become
    // transcript blocks — that would bury the conversation — but dropping it entirely made a long tool
    // call indistinguishable from a wedged one. It becomes one activity line on the tool block it is
    // running inside, and never reaches the translation below.
    if (isSubAgentEvent(frame)) {
        applySubAgentActivity(frame);
        return;
    }

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
            // the two frames is the round, and each call of a multi-call round
            // observes one identical figure.
            //
            // The bracket stays as the fallback for a harness that sends no
            // duration, which is the read that `ToolFinishedEvent` asks a host for.
            applyFrame(frame.durationMs === undefined && startedAt !== undefined ? { ...frame, durationMs: Date.now() - startedAt } : frame);
            return;
        }
        case "iteration":
        case "finish":
        case "error":
            return;
        default: {
            // The one check of a part: each reader past this point trusts the type of the part.
            const checked = checkChatPart(frame);
            if (!checked.ok) {
                getLogger("chat").warn({ type: frame.type, error: checked.error }, "chat part dropped: it failed the check of its type");
                return;
            }
            applyDataFrame(checked.frame);
            return;
        }
    }
}

/** Apply a data frame, then run the side effect of an ask or of a report spawn. */
function applyDataFrame(frame: ChatPartFrame): void {
    applyFrame(frame);
    if (frame.type === "data-ask") {
        // The ask part reconciles under one id: `pending` opens the card and docks the prompt; a
        // terminal re-emission folds latest-wins onto the same card and drains the queue entry.
        if (frame.status === "pending") {
            pushAsk({ askId: frame.id, title: frame.title, command: frame.command, ...(frame.detail !== undefined ? { detail: frame.detail } : {}) });
        } else {
            settleAsk(frame.id);
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
 * and pop it on a refusal.
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
function reportStoreFault(storeFailed: boolean | undefined): void {
    if (storeFailed === true) notify({ kind: "warn", text: "Could not save the turn to the thread." });
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
function stampTurnCost(assistantId: string, startedAt: number, turnUsage: TokenUsageRollup | undefined): void {
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
 * Remove the just-minted empty assistant bubble on a refusal and clear the streaming signals that
 * pointed at it. A refusal comes before the turn opened, so this assistant message never got a part
 * (no deltas, no tools by construction) — leaving it mounted would render a blank assistant turn
 * beneath the error banner.
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
 * Show the engine's `fallbackText` on a turn whose final text never streamed. An empty buffer means
 * no delta arrived since the last seal, so the FINAL assistant message's text never streamed and
 * `fallbackText` cannot duplicate anything on screen. (`fallbackText` is the last assistant message's
 * text, and the buffer empties only when a non-text part follows its deltas.) The fallback goes
 * through {@link applyFrame} as one delta, thus it lands below the part that interrupted the prose, in
 * emission order.
 */
function applyFallbackText(fallbackText: string): void {
    if (streamText().length === 0 && fallbackText.trim().length > 0) applyFrame({ type: "text-delta", text: fallbackText, source: TOP_LEVEL_SOURCE });
}

/** What the client knows about a turn that ended: the summary of the server, or what its last frame said. */
type TurnEnd = Pick<TurnSummary, "status" | "opened" | "turnUsage" | "fallbackText" | "storeFailed" | "failure">;

/**
 * How a turn ended, as the client learns it:
 * - `ended` — the turn ran, and the server gave its summary. A summary that could not be read is
 *   rebuilt from the terminal frame of the stream, with no `opened`;
 * - `refused` — the server refused the turn before it opened, thus nothing of it landed;
 * - `lost` — the stream broke before its terminal frame, and the summary could not be read.
 */
type TurnResult =
    | { readonly kind: "ended"; readonly end: TurnEnd }
    | { readonly kind: "refused"; readonly error: ClientError }
    | { readonly kind: "lost"; readonly detail: string };

/**
 * Reduce how the turn ended onto the store for the CURRENT turn (the caller's C1 guard has already
 * dropped a superseded turn's result, so `assistantId` still identifies a live message): flush the
 * streamed text (or the engine's `fallbackText` on a delta-less turn), close any open tool chip of a
 * turn that ended, stamp what the turn cost (its duration and, when the run reported one, its token
 * rollup), surface a store fault non-fatally, and set the coarse status. `filtered`, `failed`, a
 * refusal, and a lost stream also raise the error banner with an actionable line; `aborted` returns to
 * idle with no error (the user cancelled), having flushed what streamed. A refusal comes before the turn
 * opened, so it pops the empty assistant bubble instead.
 */
function finishTurn(result: TurnResult, assistantId: string, startedAt: number): void {
    // The turn is settling: drop any still-pending asks so the docked prompt can never outlive its
    // turn. Each terminal re-emit already settled its own entry during the turn; this is the final
    // sweep for the abort/failure path where a terminal re-emission may never arrive.
    clearAsks();
    // The turn is ending — clear any armed interrupt window so it never carries into idle or the next turn.
    disarmInterrupt();
    switch (result.kind) {
        case "ended":
            finishEndedTurn(result.end, assistantId, startedAt);
            return;
        case "refused": {
            dropEmptyAssistant(assistantId);
            const gone = result.error.type === "http" && result.error.body.error === "not_found";
            const line = gone ? "This conversation thread is no longer available." : `Could not start the turn: ${describeClientError(result.error)}`;
            setLastTurnFailure([line]);
            if (isServerStateError(result.error)) setServerStateError(`${line} — ${detailsHint()}`);
            else setErrorMsg(`${line} — ${detailsHint()}`);
            setChatStatus("error");
            return;
        }
        case "lost":
            // A disconnect does not stop the turn on the server, thus an open call gets no outcome here: an
            // `error` would contradict what the server records, and the poll mounts that record.
            commitStream();
            openTools.clear();
            setLastTurnFailure([result.detail]);
            setServerStateError(
                `The connection to the turn was lost: ${result.detail}. The turn can still run on the server, and the chat reloads it from there. — ${detailsHint()}`,
            );
            setChatStatus("error");
            return;
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled turn result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/** The {@link finishTurn} branch of a turn that ran, by its final status. */
function finishEndedTurn(end: TurnEnd, assistantId: string, startedAt: number): void {
    switch (end.status) {
        case "done":
            applyFallbackText(end.fallbackText ?? "");
            commitStream();
            drainOpenTools();
            stampTurnCost(assistantId, startedAt, end.turnUsage);
            reportStoreFault(end.storeFailed);
            setChatStatus("idle");
            return;
        case "filtered":
            // A refusal flushes what it carried the way `done` does (the reply may hold partial
            // prose), then raises the banner: the turn ended without an answer, and only a
            // model change can unblock it, so the user must see why it stopped.
            applyFallbackText(end.fallbackText ?? "");
            commitStream();
            drainOpenTools();
            stampTurnCost(assistantId, startedAt, end.turnUsage);
            setLastTurnFailure(end.failure?.detailLines ?? ["The model declined this request and stopped the turn."]);
            setErrorMsg(
                `The model declined this request and stopped the turn (content filter). Switch the chat model ("Switch chat model" in the command palette), then send the message again. — ${detailsHint()}`,
            );
            reportStoreFault(end.storeFailed);
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
                stampTurnCost(assistantId, startedAt, end.turnUsage);
                markInterrupted(assistantId);
            }
            reportStoreFault(end.storeFailed);
            setChatStatus("idle");
            return;
        case "failed":
        case "running": {
            // `running` is a summary read while the server still holds the turn open, after its stream
            // ended. Nothing more arrives on this stream, thus the surface ends the turn as a failure.
            commitStream();
            drainOpenTools();
            stampTurnCost(assistantId, startedAt, end.turnUsage);
            const message = end.failure?.message ?? "The turn ended with no outcome.";
            setLastTurnFailure(end.failure?.detailLines ?? [message]);
            setErrorMsg(`${message} — ${detailsHint()}`);
            reportStoreFault(end.storeFailed);
            setChatStatus("error");
            return;
        }
        default: {
            const _exhaustive: never = end.status;
            throw new Error(`unhandled turn status: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * How {@link loadMessages} reads a transcript. Tests replace it, so an interleaving of two rapid loads
 * is exercisable offline. Production callers omit the argument.
 */
export type LoadOpts = {
    /** The row of a thread, for its `updatedAt`, or `null` when it has no live row. Real: {@link fetchThread}. */
    readonly fetchThread: (analysisId: string, threadId: string) => ResultAsync<ThreadSummary | null, ClientError>;
    /** The whole transcript of a thread, as the server replays it. Real: {@link fetchMessages}. */
    readonly fetchMessages: (analysisId: string, threadId: string) => ResultAsync<MessageList, ClientError>;
};

/** The production {@link LoadOpts}. */
export const DEFAULT_LOAD_OPTS: LoadOpts = {
    fetchThread: (analysisId, threadId) => fetchThread(analysisId, threadId),
    fetchMessages: (analysisId, threadId) => fetchMessages(analysisId, threadId),
};

// Monotonic token ordering EVERY asynchronous write to the message store. Two producers write it —
// `loadMessages` (a replay of the durable pg thread) and `send` (the live turn) — and both interleave
// freely: two rapid session swaps race their page reads, and a load started at the boot-ready edge is
// still awaiting the server when the submit gate opens on that same edge. Each claims the token at entry
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
// Module-private: only loadMessages / pollOpenThread / send / resetHotState touch it.
let loadGeneration = 0;

// The session id a transcript load has SUCCESSFULLY mounted into the store, or `null` when none has.
// A load superseded by a boot-edge submit never sets this (the turn bumps `loadGeneration`, dropping
// the load before its page resolves), so `send` re-fires the load after the turn to mount the prior
// history that dropped load would have. Keyed by session id so a stale value from a swapped-away
// session cannot suppress the new session's post-turn reload; `resetHotState` clears it on a swap.
let loadedSessionId: string | null = null;

// The thread whose transcript the store shows, and its `updatedAt` from a read made BEFORE the transcript
// read: a write between the two reads then shows as a change at the next check, and is never lost.
// `undefined` when that row read failed, thus the next check reads the transcript again. `null` when no
// read mounted a transcript. A different client writes the thread, and the server pushes nothing, thus
// this stamp is how the poll and the send know that the screen holds less than the model reads.
let mountedThread: { readonly threadId: string; readonly updatedAt: string | null | undefined } | null = null;

// The sends that have not returned yet, a superseded one included. A load claims a newer token than a send,
// and a send whose token is gone drops its turn, thus the poll never claims one while this is above 0.
let sendsInFlight = 0;

const [otherTurn, setOtherTurn] = createSignal(false);
/**
 * True while a turn runs on the open thread and this client sends none: the turn of a different client,
 * which the poll reads (`GET {T}/turns`). Read reactively for the header.
 */
export const otherClientTurn = otherTurn;

/**
 * Load a session's transcript from the server (`GET {T}/messages`), replacing whatever was mounted.
 * The thread id equals the session id. The server gives the whole transcript; the trailing
 * {@link MESSAGE_CAP} slice keeps the newest MESSAGES, which is the window the TUI mounts.
 *
 * A thread with no row (404: a freshly minted id whose first turn has not landed) renders empty —
 * correct and expected.
 *
 * The store mounts the harness messages of the replay as they are: the renderers read the harness
 * parts, so a reloaded card renders through the same readers as the live one.
 *
 * Concurrency: each call claims a {@link loadGeneration} token at entry and re-checks it after every
 * await; a load superseded by a newer swap silently drops rather than writing a stale transcript.
 */
export async function loadMessages(analysisId: string, sessionId: string, opts: LoadOpts = DEFAULT_LOAD_OPTS): Promise<void> {
    const myLoad = ++loadGeneration;
    const row = await opts.fetchThread(analysisId, sessionId);
    if (myLoad !== loadGeneration) return; // a newer swap started while the read was in flight — drop it
    await mountTranscript(analysisId, sessionId, row.isOk() ? (row.value?.updatedAt ?? null) : undefined, myLoad, opts, "report");
}

/**
 * Read the transcript and mount it under the token `myLoad`, then record the stamp that a read before it
 * gave. `report` raises the load banner on a failed read. `quiet` leaves the screen as it is, for a read
 * that a later poll or a later send makes again.
 *
 * The write goes through `reconcile` by message id: a message that did not change keeps its object, thus
 * its block does not mount again, and a read again after a turn of a different client repaints the new
 * messages alone.
 */
async function mountTranscript(
    analysisId: string,
    sessionId: string,
    updatedAt: string | null | undefined,
    myLoad: number,
    opts: LoadOpts,
    onFailure: "report" | "quiet",
): Promise<void> {
    const res = await opts.fetchMessages(analysisId, sessionId);
    if (myLoad !== loadGeneration) return; // a newer swap started while the read was in flight — drop it
    if (res.isErr() && !(res.error.type === "http" && res.error.status === 404)) {
        if (onFailure === "report") {
            const text = `Failed to load the conversation: ${describeClientError(res.error)}`;
            if (isServerStateError(res.error)) setServerStateError(text);
            else setErrorMsg(text);
            setChatStatus("error");
        }
        return;
    }

    // Re-checked with no await in between, deliberately: this is the invariant the generation token
    // exists for — a superseded load must never reach the store — and stating it at the write itself
    // keeps it true if an await is ever reintroduced above.
    if (myLoad !== loadGeneration) return;
    // The cap is in MESSAGES, matching the unit the live append caps by. Record the session this load
    // mounted so `send` knows the history is already on screen and skips its post-turn reload.
    setMessages(reconcile(res.isOk() ? res.value.messages.slice(-MESSAGE_CAP) : [], { key: "id" }));
    loadedSessionId = sessionId;
    mountedThread = { threadId: sessionId, updatedAt };
}

/** True when the store shows the transcript of `threadId` and a row read since then gave a different `updatedAt`. */
function movedSinceMount(threadId: string, row: ThreadSummary | null): boolean {
    return mountedThread !== null && mountedThread.threadId === threadId && mountedThread.updatedAt !== (row?.updatedAt ?? null);
}

/**
 * The reads of {@link pollOpenThread}: the reads of a transcript load, and the turns of the thread. Tests
 * replace each one. Production callers omit the argument.
 */
export type ThreadPollOpts = LoadOpts & {
    /** The turns of a thread, the running ones first. Real: `GET {T}/turns` with a page of one. */
    readonly fetchTurns: (analysisId: string, threadId: string) => ResultAsync<TurnList, ClientError>;
};

/** The production {@link ThreadPollOpts}. */
export const DEFAULT_THREAD_POLL_OPTS: ThreadPollOpts = {
    ...DEFAULT_LOAD_OPTS,
    // The server lists the running turns first, thus a page of one says if any runs.
    fetchTurns: (analysisId, threadId) => fetchTurns(analysisId, threadId, { page: 0, perPage: 1 }),
};

/**
 * Read the open thread at a tick of the poll: give its row to the rail, publish {@link otherClientTurn}, and
 * mount the transcript again when the thread changed since the last mount. A different client writes the thread, and the server pushes
 * nothing, thus without this read the screen shows less than the model reads at the next turn.
 *
 * Reads nothing more while a send of this client is in flight: that turn writes the thread itself, and the
 * next tick after it mounts the transcript that the server holds. Mounts only over the transcript of the same
 * thread, thus a read that a session swap outran never writes a different session.
 */
export async function pollOpenThread(analysisId: string, threadId: string, opts: ThreadPollOpts = DEFAULT_THREAD_POLL_OPTS): Promise<void> {
    // Observed, not claimed: a poll that finds nothing new must not supersede a load in flight.
    const seen = loadGeneration;
    const turns = await opts.fetchTurns(analysisId, threadId);
    const row = await opts.fetchThread(analysisId, threadId);
    // The rail of the thread is not the message store: a send of this client does not hold it.
    if (row.isOk()) publishThreadRow(threadId, row.value);
    // A swap, a load, or a send took the store while the reads were in flight.
    if (seen !== loadGeneration || sendsInFlight > 0) return;
    setOtherTurn(turns.isOk() && turns.value.turns.some((turn) => turn.status === "running"));
    if (row.isErr() || !movedSinceMount(threadId, row.value)) return;
    const myLoad = ++loadGeneration;
    await mountTranscript(analysisId, threadId, row.value?.updatedAt ?? null, myLoad, opts, "quiet");
}

// The in-flight turn's local token. Module-private: only `send`/`abort`/`resetHotState` touch it, so the
// controller's lifetime is owned alongside the state it cancels. Its abort sends the abort of the turn
// to the server.
let abortController: AbortController | null = null;

// The in-flight turn's settlement, retained so a retract can await it: the server closes the turn
// before its stream ends, so awaiting the result IS awaiting the last durable write (the retract must
// remove the just-written orphan, never race ahead of it), and the result carries `opened`, which
// decides the durable step. Null when no turn is in flight. The RESOLVING side is a local closure
// in `send`, so a swap nulling this module ref never strands a waiter mid-await.
let turnSettled: Promise<TurnResult> | null = null;
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
 * Clear all hot state for an in-place session swap: cancel any in-flight turn, drop the streamed
 * buffer, the error, the messages, and the per-turn adapter state, and return the status to idle.
 * Idempotent.
 */
export function resetHotState(): void {
    // Claim the store-write token so a transcript load still awaiting the server for the OLD session
    // drops instead of repopulating the store we are about to clear.
    loadGeneration++;
    // The cleared store no longer holds any session's history, so forget which session was mounted —
    // otherwise a swap back to it could suppress the post-turn reload that would remount its history.
    loadedSessionId = null;
    mountedThread = null;
    setOtherTurn(false);
    abortController?.abort();
    // C1: null the token AFTER aborting so an in-flight turn's controller no longer matches its
    // captured `myTurn` — the result/late-frame guards in `send` then drop everything that turn
    // still streams, covering a reset that is NOT followed by a new send (a new send would otherwise
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
    serverStateBanner = null;
    setLastTurnFailure(null);
    setChatStatus("idle");
    setMessages([]);
}

/**
 * How {@link send} reaches the server. Tests replace each call, so a turn runs offline (no server, no
 * model, no credits). Production callers omit the argument.
 */
export type SendOpts = {
    /** Start the turn: `POST {A}/chat`. Real: {@link createChatTurn}. */
    readonly startTurn: (analysisId: string, threadId: string, message: string) => ResultAsync<ChatTurnStream, ClientError>;
    /** Stop the turn on the server: `POST {T}/turns/:turnId/abort`. Real: the client `abortTurn`. */
    readonly abortTurn: (analysisId: string, threadId: string, turnId: string) => ResultAsync<unknown, ClientError>;
    /** The summary of the ended turn: `GET {T}/turns/:turnId`. Real: {@link fetchTurn}. */
    readonly fetchTurn: (analysisId: string, threadId: string, turnId: string) => ResultAsync<TurnSummary, ClientError>;
    /**
     * Re-mount the thread after the turn when the initial transcript load was superseded by this
     * turn's boot-edge submit (see {@link send}). Real: {@link loadMessages}.
     */
    readonly reloadTranscript: (analysisId: string, sessionId: string) => Promise<void>;
    /**
     * Guarded heal of a pending removal a prior retract left for this thread — retried once before this
     * send appends (see {@link retract}). It removes the tail turn only while it has no assistant row.
     * Real: `POST {T}/retract` with `ifOrphan`.
     */
    readonly healRetract: (analysisId: string, threadId: string) => ResultAsync<RetractResponse, ClientError>;
    /**
     * The reads of the check before the turn: the row of the thread, then its transcript when a different
     * client wrote the thread since the last mount. Real: {@link DEFAULT_LOAD_OPTS}.
     */
    readonly transcript: LoadOpts;
};

/** The production {@link SendOpts}. */
export const DEFAULT_SEND_OPTS: SendOpts = {
    startTurn: (analysisId, threadId, message) => createChatTurn(analysisId, { threadId, message }),
    abortTurn: (analysisId, threadId, turnId) => abortTurn(analysisId, threadId, turnId),
    fetchTurn: (analysisId, threadId, turnId) => fetchTurn(analysisId, threadId, turnId),
    reloadTranscript: (analysisId, sessionId) => loadMessages(analysisId, sessionId),
    healRetract: (analysisId, threadId) => retractTurn(analysisId, threadId, { ifOrphan: true }),
    transcript: DEFAULT_LOAD_OPTS,
};

/**
 * Run one turn on the server and drive its stream: each frame goes to `onFrame`, the abort of `signal`
 * sends the abort of the turn, and the summary of the turn ends it. The turn does not stop when the
 * client stops reading, thus the abort is the one way to stop it, and the stream is read to its end.
 *
 * It never rejects: each failure is a {@link TurnResult}.
 */
async function driveTurn(
    turn: { analysisId: string; threadId: string; userText: string; signal: AbortSignal; onFrame: (frame: ChatFrame) => void },
    opts: SendOpts,
): Promise<TurnResult> {
    const started = await opts.startTurn(turn.analysisId, turn.threadId, turn.userText);
    if (started.isErr()) return { kind: "refused", error: started.error };
    const { turnId, frames } = started.value;

    const sendAbort = (): void => {
        void opts.abortTurn(turn.analysisId, turn.threadId, turnId).match(
            () => undefined,
            (e) => getLogger("chat").warn({ turnId, err: describeClientError(e) }, "the abort of the turn did not reach the server"),
        );
    };
    // An abort that came while the turn was opening has no id to name until now.
    if (turn.signal.aborted) sendAbort();
    else turn.signal.addEventListener("abort", sendAbort, { once: true });

    let terminal: ChatFrame | null = null;
    let broken: string | null = null;
    for await (const item of frames) {
        if (item.isErr()) {
            // A frame that is not JSON is skipped; a broken connection is the last item of the stream.
            if (item.error.type === "bad_json") getLogger("chat").warn({ turnId, detail: item.error.detail }, "chat frame dropped: it is not JSON");
            else broken = describeClientError(item.error);
            continue;
        }
        const frame = item.value;
        if (frame.type === "finish" || frame.type === "error") terminal = frame;
        else turn.onFrame(frame);
    }
    turn.signal.removeEventListener("abort", sendAbort);

    const summary = await opts.fetchTurn(turn.analysisId, turn.threadId, turnId);
    if (summary.isOk() && summary.value.status !== "running") return { kind: "ended", end: summary.value };
    // The summary is the one source of the outcome. When it cannot be read, the terminal frame still
    // tells how the turn ended. A `finish` frame ends `done`, `filtered`, and `aborted` turns alike, and
    // only this client's own abort tells them apart.
    if (terminal?.type === "finish") {
        return {
            kind: "ended",
            end: { status: turn.signal.aborted ? "aborted" : "done", ...(terminal.turnUsage === undefined ? {} : { turnUsage: terminal.turnUsage }) },
        };
    }
    if (terminal?.type === "error")
        return { kind: "ended", end: { status: "failed", failure: { message: terminal.message, detailLines: [terminal.message] } } };
    return {
        kind: "lost",
        detail: broken ?? (summary.isErr() ? describeClientError(summary.error) : "the stream ended while the turn still runs on the server"),
    };
}

/**
 * Send a user turn through the local server. Owns the turn-scoped {@link AbortController} so
 * {@link abort} (and a session swap) can cancel it. Flow: push the user message → open the assistant
 * turn → `POST {A}/chat` and feed each frame of its stream to {@link applyServerFrame} → reduce the
 * result onto the store. The thread id equals the session id.
 *
 * TURN-GENERATION GUARD: the fresh {@link AbortController} instance IS this turn's identity token. A
 * session swap or {@link resetHotState} replaces (or nulls) the module `abortController` mid-flight —
 * while the OLD turn is still unwinding on the server, a NEW turn can already be streaming into a new
 * session. So every frame this turn streams flows through one guarded sink that drops it once the token
 * no longer matches, and the result is dropped on the same check — a superseded turn NEVER touches the
 * new turn's streaming signals, status, error, or messages. Its writes already ran (correctly) on the
 * server on the old thread; the only remaining work is UI-visible, so dropping it is exactly right.
 *
 * Before the turn, the transcript is read again when a different client wrote the thread since the last
 * mount, thus the screen holds what the model reads.
 */
export async function send(turn: { sessionId: string; analysisId: string; userText: string }, opts: SendOpts = DEFAULT_SEND_OPTS): Promise<void> {
    sendsInFlight += 1;
    try {
        await sendTurn(turn, opts);
    } finally {
        sendsInFlight -= 1;
    }
}

/** The body of {@link send}, which counts it in {@link sendsInFlight} on each exit. */
async function sendTurn(turn: { sessionId: string; analysisId: string; userText: string }, opts: SendOpts): Promise<void> {
    setErrorMsg(null);
    setLastTurnFailure(null);

    // Claim the store-write token BEFORE any awaited or store-writing step in this send. `Chat` fires
    // `loadMessages` the instant boot reaches `ready` — the same instant `handleSubmit`'s gate opens — so
    // a message pre-typed during the boot animation lands while that load is still awaiting its read.
    // Without this claim the load's trailing `setMessages` would replace the store wholesale, deleting the
    // user's message and the in-flight assistant turn and stranding `currentAssistantId` on a message no
    // longer mounted (every later part would then silently no-op). Same hazard on an in-place session swap.
    // Claimed ahead of the heal below so the heal's await sits inside this turn's token-owned sequence.
    const myTurnLoad = ++loadGeneration;

    // Heal a pending durable retract for this thread before this turn appends: a prior retract's tail
    // removal faulted, possibly leaving an orphan turn on the thread. Retry it ONCE — success removes
    // the orphan; a second failure just proceeds (an unanswered orphan is harmless context, and a
    // transient fault must never wedge the conversation). Rare by construction: the flag is set
    // only by a failed retract. The retry goes through the GUARDED heal, which declines when the tail is
    // an answered turn — the failure that scheduled it cannot tell a rolled-back retract from one whose
    // commit landed but lost its acknowledgement, and only the second read distinguishes them.
    if (pendingRetract.has(turn.sessionId)) {
        pendingRetract.delete(turn.sessionId);
        await opts.healRetract(turn.analysisId, turn.sessionId).match(
            (result) => {
                if (result.kind !== "retracted")
                    getLogger("chat").debug({ threadId: turn.sessionId, kind: result.kind }, "pending retract heal removed nothing");
            },
            (e) => getLogger("chat").debug({ err: describeClientError(e), threadId: turn.sessionId }, "pending retract heal failed; proceeding with send"),
        );
        // The heal is awaited work inside this token-claimed sequence, so the swap re-check after it is
        // mandatory: during the await a session swap's `resetHotState` can claim a newer token and clear
        // the store. Bail quietly — the user swapped away mid-send. Falling through would push this
        // session's message straight into the swapped-in session's cleared store: `pushUserMessage` below
        // is a synchronous write with no further token check.
        if (loadGeneration !== myTurnLoad) return;
    }

    // A different client can have written the thread since the last mount. With no mount of this thread
    // there is nothing to compare, and the post-turn reload below mounts it. The mount runs under this
    // turn's token, thus it neither supersedes this turn nor survives a swap, and each await is followed
    // by the same re-check as the heal above.
    if (mountedThread?.threadId === turn.sessionId) {
        const row = await opts.transcript.fetchThread(turn.analysisId, turn.sessionId);
        if (loadGeneration !== myTurnLoad) return;
        if (row.isOk() && movedSinceMount(turn.sessionId, row.value)) {
            await mountTranscript(turn.analysisId, turn.sessionId, row.value?.updatedAt ?? null, myTurnLoad, opts.transcript, "quiet");
            if (loadGeneration !== myTurnLoad) return;
        }
    }

    pushUserMessage(turn.userText);
    const assistantId = startAssistantTurn(turn.sessionId);
    // The scope of the report-children refresh that a report spawn of this turn pokes, and of a retract.
    currentAnalysisId = turn.analysisId;
    setChatStatus("busy");
    const startedAt = Date.now();

    abortController = new AbortController();
    // The controller instance is this turn's token. Captured once; the module `abortController`
    // may be reassigned/nulled by a swap or reset while this turn is in flight.
    const myTurn = abortController;

    // Retain this turn's settlement + duration base so a retract can await the turn (the close lands
    // before the stream ends) and decide the durable step. `settleTurn` is a LOCAL closure so it
    // resolves the waiter regardless of a swap nulling the module `turnSettled` mid-flight.
    let settleTurn!: (r: TurnResult) => void;
    turnSettled = new Promise<TurnResult>((resolve) => {
        settleTurn = resolve;
    });
    turnStartedAt = startedAt;

    // `driveTurn` is contractually non-rejecting — every failure returns a `TurnResult`. But `turnSettled`
    // is awaited by the retract path, so this promise MUST settle on EVERY exit: a contract-violating throw
    // that skipped `settleTurn` below would hang a waiting retract forever with the status stuck busy.
    const result: TurnResult = await driveTurn(
        {
            analysisId: turn.analysisId,
            threadId: turn.sessionId,
            userText: turn.userText,
            signal: myTurn.signal,
            // Every frame this turn streams passes through here. Once a swap/reset supersedes the turn
            // (`abortController !== myTurn`), late frames are dropped at this one boundary, so a stale turn
            // can never write the new turn's streaming signals or store.
            onFrame: (frame) => {
                if (abortController === myTurn) applyServerFrame(frame);
            },
        },
        opts,
    ).catch((cause: unknown): TurnResult => ({ kind: "lost", detail: describeCause(cause) }));

    // Settle the retained turn promise BEFORE the supersession guard: a retract IS a superseding writer
    // (it claimed the token to abort this turn) and must still observe this result — it awaits
    // `turnSettled` to read `opened` and decide the durable step. `settleTurn` is the local
    // closure, so this resolves even when a swap has nulled the module `turnSettled`.
    settleTurn(result);

    // C1: the turn was superseded while it unwound — drop the result whole. Its store-fault notice is
    // dropped too: it would otherwise fire over the new session's UI. The token re-check is the same rule
    // from the other producer's side: any store-writing operation started after this turn owns the store
    // now — a retract that claimed the token takes over this turn's teardown entirely.
    if (abortController !== myTurn || loadGeneration !== myTurnLoad) return;

    finishTurn(result, assistantId, startedAt);

    // The turn is settled. Nulling the token drops any later straggler at the guarded sink; the per-turn
    // adapter state is cleared alongside so nothing dangles at the finished turn.
    abortController = null;
    currentAssistantId = null;
    currentSessionId = null;
    currentAnalysisId = null;
    turnMessages = [];
    turnSettled = null;
    turnStartedAt = 0;

    // Retry a transcript load THIS turn superseded. `Chat` fires the initial load at the boot-ready
    // edge — the same instant the submit gate opens — so a message pre-typed while booting bumps
    // `loadGeneration` and drops that load before its read resolves, leaving the prior history
    // unmounted until a manual session swap. The appended turn is now in the pg thread, so the reload
    // is convergent: it re-mounts the history plus this turn. Skipped when a load already completed for
    // this session (the history is already on screen) — the reload replaces the store wholesale, so
    // re-running it on every turn would needlessly remount and repaint the whole window.
    if (loadedSessionId !== turn.sessionId) {
        await opts.reloadTranscript(turn.analysisId, turn.sessionId);
    }
}

/** Cancel the in-flight turn, if any (the abort keybinding): the abort of its token sends the abort of the turn to the server. */
export function abort(): void {
    abortController?.abort();
    // Once the turn's abort is fired there is nothing left to interrupt, so disarm the double-press
    // window now — the status hint falls back to its resting form immediately rather than staying
    // accented through the turn's unwind. `finishTurn` disarms on settlement as a backstop; disarming
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
 * Close the frame sink + per-turn adapter state after a retract took over teardown. `send`'s own
 * cleanup was skipped (its C1 guard dropped once the retract claimed the token), so the retract closes
 * the sink here: nulling `abortController` drops any late straggler frame at the guarded sink, and the
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
 * Whether the aborted turn LANDED an orphan turn on the thread — the precondition for the durable
 * retract. A summary says it in `opened`. A refusal wrote nothing. A summary rebuilt from the terminal
 * frame and a lost stream do not know, thus the retract goes through the guarded form, which removes
 * the tail only while it has no assistant row. Removing the tail when none of this turn's rows are there
 * would delete an EARLIER turn's real history — hence the gate.
 */
function turnLanding(result: TurnResult): "landed" | "none" | "unknown" {
    switch (result.kind) {
        case "ended":
            return result.end.opened === undefined ? "unknown" : result.end.opened ? "landed" : "none";
        case "refused":
            return "none";
        case "lost":
            return "unknown";
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled turn result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * How {@link retract} removes the tail turn on the server. Tests replace it, resolving on their
 * schedule. Production callers omit the argument.
 */
export type RetractOpts = {
    /** `POST {T}/retract`. With `ifOrphan`, only a tail turn with no assistant row. Real: {@link retractTurn}. */
    readonly retractTurn: (analysisId: string, threadId: string, ifOrphan: boolean) => ResultAsync<RetractResponse, ClientError>;
};

/** The production {@link RetractOpts}. */
export const DEFAULT_RETRACT_OPTS: RetractOpts = { retractTurn: (analysisId, threadId, ifOrphan) => retractTurn(analysisId, threadId, { ifOrphan }) };

/**
 * Run the durable tail removal and reduce its outcome. `retracted` removed the orphan; each other kind
 * removed nothing (the opening never landed, an anomalous tail, or an answered tail) — a benign no-op
 * with a debug log, never surfaced. A client error is retained as a pending retry for the thread (the
 * next send heals it) and surfaced as an error notice — token-gated, since a swap that superseded the
 * UI writes has already moved the surface on. The conversation is never blocked on it.
 */
async function runDurableRetract(analysisId: string, threadId: string, ifOrphan: boolean, myRetract: number, opts: RetractOpts): Promise<void> {
    await opts.retractTurn(analysisId, threadId, ifOrphan).match(
        (result) => {
            if (result.kind !== "retracted") getLogger("chat").debug({ threadId, kind: result.kind }, "tail retract removed nothing");
        },
        (e) => {
            pendingRetract.add(threadId);
            if (loadGeneration === myRetract) notify({ kind: "error", text: `Could not retract the message from the thread (${describeClientError(e)}).` });
        },
    );
}

/**
 * Take back the just-sent message for editing while the turn is in flight and the assistant has
 * produced nothing (see {@link canRetract}). The up-arrow binding gates on `canRetract` and invokes
 * this; `seedComposer` is the widget callback the UI supplies to put the original text back in the composer
 * (cursor placement is the widget's job), keeping this hook free of renderable refs.
 *
 * Sequence: claim the store-write token → `abort()` → await the turn's settlement → re-validate the
 * no-output window. A racing delta downgrades to a plain interrupt (message kept, notice, nothing
 * removed). Otherwise run the durable tail retract — SKIPPED when no orphan landed — and only then
 * splice the live store and seed the composer, so the transcript and the composer move together rather
 * than either side of a server round-trip. Claiming the token makes this a first-class store writer: a
 * session swap that supersedes it mid-sequence drops every remaining store write and the composer seed,
 * while the durable removal — committed at the keypress and thread-scoped — still completes against the
 * old thread.
 *
 * Re-entrant-safe: {@link retractInFlight} guards entry, so a second press during the settlement window
 * is a no-op. That guard, not the generation token, is what keeps the durable removal once-only — the
 * token deliberately does NOT gate the durable step (a swap must not cancel it), so re-entry would be the
 * only way to run it twice (see the flag's declaration).
 */
export async function retract(seedComposer: (text: string) => void, opts: RetractOpts = DEFAULT_RETRACT_OPTS): Promise<void> {
    // The binding gates on `canRetract`, but re-check so a stray or racing call is still safe. This runs
    // BEFORE `retractInFlight` is set, so a first press sees its own flag clear and proceeds while a second
    // press during the settlement window sees the flag (folded into `canRetract`) and bails here.
    if (!canRetract()) return;
    retractInFlight = true;
    try {
        const settled = turnSettled;
        const assistantId = currentAssistantId;
        const threadId = currentSessionId;
        const analysisId = currentAnalysisId;
        const startedAt = turnStartedAt;
        if (!settled || !assistantId || !threadId || !analysisId) return;

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

        // Fire the turn's abort so the server unwinds and closes the turn.
        abortController?.abort();

        // Await settlement — the close has run by the time the stream ends, so the durable removal below
        // targets the just-written orphan rather than racing ahead of it.
        const result = await settled;

        // A text delta (or any part) can race the keypress. If output landed, DOWNGRADE to a plain
        // interrupt: keep the message, run the normal settle (flush + interrupted marker + idle) via
        // `finishTurn`, and remove nothing. Token-gated — a swap mid-await already cleared and re-owns the store.
        if (!isEmptyAssistantShell(assistantId)) {
            if (loadGeneration === myRetract) {
                finishTurn(result, assistantId, startedAt);
                closeTurnState();
                notify({ kind: "info", text: "Kept your message — the assistant had already started answering." });
            }
            return;
        }

        // A genuine no-output retract. The durable removal goes FIRST, while the transcript still shows the
        // message and the status still reads busy, so that the whole visible transition — message gone,
        // text back in the composer, idle — lands as one step below. Splicing first would instead put the
        // latency of a server round-trip between "your message disappeared" and "here it is back",
        // leaving the user staring at an empty focused composer and a transcript missing what they just
        // sent, with no indication which way it is going to resolve. The removal is thread-scoped and
        // already committed to at the keypress, so it runs even when a swap supersedes the UI writes —
        // but only when this turn's opening landed, or may have landed, an orphan to remove.
        const landing = turnLanding(result);
        if (landing !== "none") await runDurableRetract(analysisId, threadId, landing === "unknown", myRetract, opts);

        // The visible half, token-gated: a swap during the removal above already cleared the store and
        // re-owns the surface, and the composer is shared across sessions, so seeding then would drop this
        // session's text into the swapped-in one. `closeTurnState` nulls the frame sink FIRST so a late
        // straggler frame cannot re-append to the message being removed. The seed is a request, not a
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
