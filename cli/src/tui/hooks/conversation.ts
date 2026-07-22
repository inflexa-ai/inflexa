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
    type RetractOutcome,
    type ThreadHistory,
} from "@inflexa-ai/harness";

import { describeCause, findAuthCause } from "../../lib/cause.ts";
import { getLogger } from "../../lib/log.ts";
import { resolveModelConnection } from "../../modules/harness/config.ts";
import { MODEL_API_KEY_VAR, providerKindForSlug } from "../../modules/infra/setup.ts";
import { workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { isSubAgentEvent, readAskPart, readPlanCard, readRunCard } from "../../modules/harness/chat_printer.ts";
import { readFileReference, readPresentation, readReportPreview, readReportPreviewFailed } from "../../modules/harness/artifact_open.ts";
import { buildChatSession, healTailOrphan, retractTailTurn, runChatTurn, type HealOutcome, type TurnOutcome } from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { leaderSeq, sequenceLabel } from "../keymap.ts";
import { harnessRuntime } from "./boot.ts";
import { clearAsks, pushAsk, settleAsk } from "./asks.ts";
import { notify } from "./notice.ts";
import { chatStatus, setChatStatus } from "./status.ts";
import type { AskCardPart, OpenableCardPart, OpenableEntry, Part, PlanCardPart, PresentationPart, TextPart, ToolCallPart } from "../../types/session.ts";

// The chat's hot state — the message list, the in-flight streaming buffer, and the last error —
// held here (not inside `app.tsx`) so the holder of the state is decoupled from its renderer, the
// same split as `status.ts`. The `Chat` component (`tui/components/chat.tsx`) renders it and drives
// the load on session/boot changes; the `Sidebar` reads `messageCount`; `app.tsx` only composes
// them. The transcript arrives two ways, BOTH writing this store directly (no bus for the harness
// path): `send` runs one shared turn and feeds every harness event through
// `applyEmitEvent`, and `loadMessages` replays the pg thread on open. One chat screen is mounted at
// a time, so a module singleton is correct. The coarse activity state stays in `status.ts`.

/** One chat turn as the UI holds it: the message identity plus its parts. */
export type UIMessage = {
    id: string;
    role: "user" | "assistant";
    parts: Part[];
    /** Assistant-only turn duration in ms, set when the turn finishes; undefined otherwise. */
    durationMs?: number;
    /**
     * Live-only marker: an aborted turn streamed output into this assistant message before the user
     * interrupted it. Set on an interrupted turn that produced content (a message block renders a muted
     * "interrupted" suffix); never set on a no-output abort (that empty shell is dropped instead), and
     * never persisted — an aborted turn stores no assistant message, so a reload never carries it.
     */
    interrupted?: boolean;
};

// The most-recent turns the UI mounts. Layout cost scales with mounted message count (the scrollbox
// clips painting, not layout), so we cap what's mounted rather than virtualize — 200 turns ≈ 100
// exchanges, comfortably more than a screenful. Older turns stay in the pg thread; just not mounted.
//
// One constant, two units by design: it caps the LIVE store by MESSAGES (`pushUserMessage`/
// `startAssistantTurn` shift once the store exceeds it) and doubles as `loadPage`'s `perPage`, which
// counts TURNS. That coupling is load-bearing: `loadPage` clamps `perPage` to 200, so MESSAGE_CAP
// must never exceed 200 — a larger value would silently drop the turns past the clamp on each page,
// and `loadMessages` would mount a window missing the thread's tail rather than error.
const MESSAGE_CAP = 200;

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
// `currentSessionId` fills the persisted-part ceremony fields; `openTools` pairs a `tool-finished`
// with its `tool-started` by tool-use id (storing only the start timestamp — a primitive — so the
// copy-on-receive rule holds by construction). Module-private: only the send lifecycle touches them.
let currentAssistantId: string | null = null;
let currentSessionId: string | null = null;
// The analysis this turn belongs to — stamped onto every openable-card part so its references resolve
// against the right workspace root at open time (the card stores the reference, never a resolved path).
let currentAnalysisId: string | null = null;
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
                        // `streamPartId` only ever names a text part: `startAssistantTurn` mints it and
                        // `beginStreamSegment` (the mid-turn remint) re-points it, and both push a
                        // fresh text part — no other writer touches it. So the found part is a TextPart;
                        // the spread keeps its id/session/message ceremony and swaps in the sealed text.
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
 * Close the open streaming text segment BEFORE a non-text part (a tool chip, a card, a tagged
 * mention) joins the turn, so the transcript renders in emission order rather than merging post-part
 * prose above the part it followed (mid-turn interleaving). Two cases:
 *
 *   - prose is pending → seal it into its part via {@link commitStream} (which nulls `streamPartId`),
 *     so the interrupting part appends AFTER the sealed prose;
 *   - the buffer is empty but `streamPartId` still names a part → that part is the turn's pre-minted
 *     (or a reopened-but-unwritten) EMPTY text segment. Splice it out and null `streamPartId`, so the
 *     interrupting part is not preceded by an invisible empty part and any resumed prose / ok-fallback
 *     opens a FRESH segment AFTER it.
 *
 * The empty-drop keeps a tool/card-FIRST turn — the agent's most common shape, whose first loop
 * iteration is a bare tool_use — in parity with {@link cortexToUiMessage}'s in-order reload. Without
 * it the pre-minted `parts[0]` survives ahead of the interrupting part and every later delta (and the
 * ok-fallback) lands in it, rendering the prose ABOVE the tool live while a reload (preserving stored
 * row order) renders it below.
 */
function closeStreamSegment(): void {
    if (streamText().length > 0) {
        commitStream();
        return;
    }
    const pid = streamPartId();
    if (pid === null) return;
    setStreamPartId(null);
    const id = currentAssistantId;
    if (!id) return;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (!msg) return;
            const idx = msg.parts.findIndex((p) => p.id === pid);
            if (idx !== -1) msg.parts.splice(idx, 1);
        }),
    );
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
 * Begin a fresh streaming text segment on the in-flight assistant message and point `streamPartId` at
 * it. Called when a `text-delta` resumes after {@link closeStreamSegment} sealed or dropped the prior
 * segment: the resumed prose becomes its OWN part, appended AFTER the tool/card that
 * interrupted it, so live rendering matches {@link cortexToUiMessage}'s in-order reload. Minted lazily
 * (only on a real delta, never eagerly on flush) so a turn that ends on a card leaves no trailing
 * empty text part.
 */
function beginStreamSegment(): void {
    const id = currentAssistantId;
    if (!id) return;
    const partId = randomUUIDv7();
    setStreamPartId(partId);
    appendPart({ id: partId, sessionId: currentSessionId ?? "", messageId: id, type: "text", text: "", createdAt: Date.now() });
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
                // The findIndex predicate already matched `type === "tool-call"`, so the part at idx is
                // a ToolCallPart; the cast only restates that for the spread (findIndex widens it back
                // to Part). Fresh object so Solid reconciles the status/duration edit.
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

/**
 * Fold a terminal `data-ask` re-emission onto the live transcript: overwrite the existing ask card's
 * status in place (same `askId` — the part re-emits `pending` → a terminal status under one id, so this
 * is latest-wins with no duplicate), or append a fresh terminal card when none exists. The append path
 * covers an answer-side re-emission that arrives with no prior `pending` (e.g. the pending card was
 * dropped when the store reset mid-turn). A fresh object so Solid reconciles the status edit.
 */
function reconcileAskCard(ask: ReturnType<typeof readAskPart>): void {
    const id = currentAssistantId;
    if (!id) return;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (!msg) return;
            const idx = msg.parts.findIndex((p) => p.type === "ask-card" && p.askId === ask.askId);
            if (idx !== -1) {
                // The findIndex predicate already matched `type === "ask-card"`, so the part at idx is an
                // AskCardPart; the cast only restates that for the spread. Fresh object so Solid reconciles.
                msg.parts[idx] = { ...(msg.parts[idx] as AskCardPart), status: ask.status };
            } else {
                msg.parts.push({
                    id: randomUUIDv7(),
                    type: "ask-card",
                    askId: ask.askId,
                    title: ask.title,
                    command: ask.command,
                    ...(ask.detail !== undefined ? { detail: ask.detail } : {}),
                    status: ask.status,
                });
            }
        }),
    );
}

/**
 * Echo the user's typed reject feedback onto the live ask card so the transcript shows what they said.
 * The ledger and the model-facing denial carry the feedback on their own; this write is presentation
 * only. It SPREADS the existing part and adds `feedback`, so whatever status a terminal re-emit
 * ({@link reconcileAskCard}) already folded in survives — and, symmetrically, that reconcile spreads the
 * existing part and overrides only `status`, so a `feedback` already noted survives it. The two writes
 * therefore converge on the same card regardless of which lands first: the gateway's terminal re-emit
 * (the poll's `data-ask`) and this answer-side echo race, and both are order-independent by construction.
 * A no-op when no card matches — e.g. the pending card was dropped by a mid-turn reset.
 */
export function noteAskFeedback(askId: string, feedback: string): void {
    const id = currentAssistantId;
    if (!id) return;
    setMessages(
        produce((msgs) => {
            const msg = msgs.find((m) => m.id === id);
            if (!msg) return;
            const idx = msg.parts.findIndex((p) => p.type === "ask-card" && p.askId === askId);
            // The findIndex predicate already matched `type === "ask-card"`, so the part at idx is an
            // AskCardPart; the cast only restates that for the spread. Fresh object so Solid reconciles.
            if (idx !== -1) msg.parts[idx] = { ...(msg.parts[idx] as AskCardPart), feedback };
        }),
    );
}

/** The harness `EmitFn` event union — one event the agent loop, provider, or a tool streams. */
type EmitEventArg = Parameters<EmitFn>[0];

/**
 * Reduce one harness turn event into the store. This is the TUI's counterpart to the
 * REPL printer: it consumes the harness `contracts/` vocabulary directly (never the cli bus event
 * shapes) and writes the store rather than a terminal.
 *
 *   - sub-agent traffic (deeper `callPath`) is dropped — the shared depth filter;
 *   - `text-delta` accumulates in `streamText`; it seals into its part at turn completion AND whenever
 *     a non-text part interrupts, so prose emitted after a tool/card renders as its own segment BELOW
 *     that part (in-order interleaving). When a tool/card is the turn's FIRST event the pre-minted
 *     empty text part is dropped, so the interrupting part is not preceded by an empty segment and any
 *     later prose opens fresh below it — matching the reload path;
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
            // A delta with no active streaming part means a preceding non-text part (tool/card) closed
            // the prior segment (sealing its prose, or dropping an empty one) — begin a fresh text part
            // so the resumed prose renders AFTER that part, matching the reload path's in-order
            // interleaving. Lazy: minting only on a real delta leaves no trailing empty part when a
            // turn ends on a card.
            if (streamPartId() === null) beginStreamSegment();
            setStreamText((prev) => prev + event.text);
            return;
        case "done":
        case "iteration":
            // Stream terminal marker / loop iteration boundary — orchestration, not transcript content.
            // Deliberately NO flush here: the turn's final segment is sealed by finishTurn, not by these.
            return;
        case "tool-started": {
            // Close the open text segment before this chip: seal any prose streamed before it into its
            // own part, or drop the pre-minted empty part when nothing streamed yet (a tool-first turn),
            // so the chip renders in emission order and is never preceded by an empty part.
            closeStreamSegment();
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
            // Close the open text segment before the chip resolves — seals pending prose (matters on
            // the unpaired-finish path, where updateToolPart appends a fresh finished part that must
            // land after it) or drops an empty pre-minted part (a tool-first turn).
            closeStreamSegment();
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
            // Close the open text segment so the card/mention this becomes renders after it, in
            // emission order: seals preceding prose or drops an empty pre-minted part (a card-first turn).
            closeStreamSegment();
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
        case "data-presentation":
            appendPart(presentationPart(data, currentAnalysisId ?? ""));
            return;
        case "data-file-reference":
            appendPart(fileReferencePart(data, currentAnalysisId ?? ""));
            return;
        case "data-report-preview":
            appendPart(reportPreviewPart(data, currentAnalysisId ?? ""));
            return;
        case "data-report-preview-failed":
            appendPart(reportPreviewFailedPart(data, currentAnalysisId ?? ""));
            return;
        case "data-ask": {
            // The ask part reconciles under one id: `pending` opens the card and docks the prompt; a
            // terminal re-emission folds latest-wins onto the same card and drains the queue entry.
            const ask = readAskPart(data);
            if (ask.status === "pending") {
                appendPart({
                    id: randomUUIDv7(),
                    type: "ask-card",
                    askId: ask.askId,
                    title: ask.title,
                    command: ask.command,
                    ...(ask.detail !== undefined ? { detail: ask.detail } : {}),
                    status: "pending",
                });
                pushAsk({ askId: ask.askId, title: ask.title, command: ask.command, ...(ask.detail !== undefined ? { detail: ask.detail } : {}) });
            } else {
                reconcileAskCard(ask);
                settleAsk(ask.askId);
            }
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

// The display-card builders — SHARED by the live reducer ({@link applyEmitEvent}) and the reload path
// ({@link cortexToUiMessage}), so a reloaded transcript renders byte-identical cards to the live turn.
// Each mints a fresh part id and reads through the `artifact_open` readers, which copy every primitive at
// receipt (copy-on-receive): the live path passes the harness event's `data`, the reload path passes the
// flat reconstructed part (the readers narrow off any loose record), and both yield the same part.

/** Build the part for a `data-presentation`: text-shaped → an inline presentation part; `echart`/`svg` → an openable card. */
function presentationPart(data: unknown, analysisId: string): PresentationPart | OpenableCardPart {
    const view = readPresentation(data);
    if (view.shape === "inline") {
        return { id: randomUUIDv7(), type: "presentation", ...(view.title !== undefined ? { title: view.title } : {}), body: view.body };
    }
    return { id: randomUUIDv7(), type: "openable-card", analysisId, ...(view.title !== undefined ? { title: view.title } : {}), entries: [view.entry] };
}

/** Build the openable-card part for a `data-file-reference` (one entry per file, plus a gallery folder). */
function fileReferencePart(data: unknown, analysisId: string): OpenableCardPart {
    const view = readFileReference(data);
    return {
        id: randomUUIDv7(),
        type: "openable-card",
        analysisId,
        ...(view.title !== undefined ? { title: view.title } : {}),
        entries: view.entries,
        ...(view.folderPath !== undefined ? { folderPath: view.folderPath } : {}),
    };
}

/** Build the openable-card part for a `data-report-preview`. */
function reportPreviewPart(data: unknown, analysisId: string): OpenableCardPart {
    const view = readReportPreview(data);
    return { id: randomUUIDv7(), type: "openable-card", analysisId, ...(view.title !== undefined ? { title: view.title } : {}), entries: [view.entry] };
}

/** Build the degraded openable-card part for a `data-report-preview-failed` (naming the reason, nothing to open). */
function reportPreviewFailedPart(data: unknown, analysisId: string): OpenableCardPart {
    const view = readReportPreviewFailed(data);
    return { id: randomUUIDv7(), type: "openable-card", analysisId, entries: [view.entry] };
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

/**
 * The `ctrl+x e for details` affordance appended to a failure banner. Derived from the SAME
 * `leaderSeq("e")` that app.tsx binds to open the details dialog, so the printed label can never
 * drift from the real key (it re-resolves the leader from config, exactly as the binding does).
 */
function detailsHint(): string {
    return `${sequenceLabel(leaderSeq("e"))} for details`;
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
 * Flag the assistant message an aborted turn streamed output into as `interrupted` — a live-only
 * marker a message block renders as a muted suffix. Only ever called for an aborted turn that produced
 * content (a no-output abort drops the shell instead), so the flag never rides an empty message. A
 * fresh field write via `produce` so Solid reconciles the edit; no-op if the message is gone.
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
 * Whether the in-flight assistant has produced NOTHING yet: no streamed text, no open tool, and its
 * only part is the pre-minted empty text segment {@link startAssistantTurn} mints. The structural half
 * of {@link canRetract}, reused by {@link finishTurn}'s abort branch to decide whether an aborted turn
 * left an empty shell to drop. Reads the reactive `streamText`/`messages`, so it re-evaluates in a
 * tracking scope; `openTools` is a plain read (it only ever changes alongside a store write that has
 * already re-triggered the scope).
 */
function isEmptyAssistantShell(assistantId: string | null): boolean {
    if (!assistantId) return false;
    if (streamText() !== "") return false;
    if (openTools.size > 0) return false;
    const msg = messages.find((m) => m.id === assistantId);
    if (!msg || msg.parts.length !== 1) return false;
    const only = msg.parts[0];
    return only?.type === "text" && only.text === "";
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
    const kind = providerKindForSlug(connection.provider);
    const relogin = kind ? ` (or run \`inflexa setup --provider ${kind}\`)` : "";
    return `Your ${connection.provider} login has expired or been revoked — restart the chat to sign in again${relogin}. — ${detailsHint()}`;
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
    // The turn is settling: drop any still-pending asks so the docked prompt can never outlive its
    // turn. Each terminal re-emit already settled its own entry during the turn; this is the final
    // sweep for the abort/failure path where a terminal re-emission may never arrive.
    clearAsks();
    // The turn is ending — clear any armed interrupt window so it never carries into idle or the next turn.
    disarmInterrupt();
    switch (outcome.kind) {
        case "ok":
            // An empty buffer means no delta arrived since the last seal, so the FINAL assistant
            // message's text never streamed and `fallbackText` cannot duplicate anything on screen.
            // (`fallbackText` is `finalText(result.messages)` — the last assistant message's text —
            // and deltas for it are only cleared by a non-text part arriving after them.)
            if (streamText().length === 0 && outcome.fallbackText.trim().length > 0) {
                // `commitStream` writes into the part `streamPartId` names and no-ops when it is null.
                // A mid-turn `closeStreamSegment` — every tool chip, plan card, run card — nulls it, so
                // without reopening a segment the fallback would be assigned and immediately discarded.
                // Reopening also puts it in emission order, below the part that interrupted the prose,
                // which is where a transcript reload renders it.
                if (streamPartId() === null) beginStreamSegment();
                setStreamText(outcome.fallbackText);
            }
            commitStream();
            drainOpenTools();
            stampDuration(assistantId, startedAt);
            reportAppendError(outcome.appendError);
            setChatStatus("idle");
            return;
        case "aborted":
            // An aborted turn that produced nothing leaves NO empty assistant shell — the user message
            // alone stands, matching the reload (an abort persists no assistant message). One that
            // streamed output flushes it and carries a live-only `interrupted` marker. Either way
            // `aborted` returns to idle with no error banner — the user cancelled, not a failure.
            if (isEmptyAssistantShell(assistantId)) {
                dropEmptyAssistant(assistantId);
            } else {
                commitStream();
                drainOpenTools();
                stampDuration(assistantId, startedAt);
                markInterrupted(assistantId);
            }
            reportAppendError(outcome.appendError);
            setChatStatus("idle");
            return;
        case "failed":
            commitStream();
            drainOpenTools();
            stampDuration(assistantId, startedAt);
            setLastTurnFailure(outcome.cause);
            setErrorMsg(turnFailureMessage(outcome.cause));
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
export function cortexToUiMessage(m: CortexMsg, sessionId: string, analysisId = ""): UIMessage {
    // TODO(extend): content-fidelity gap, deliberately deferred. Any non-user role collapses onto
    // "assistant" here because UIMessage.role is a two-value union — a `system` turn loses its framing
    // and reads as the assistant. Widen UIMessage.role (and MessageBlock) to carry system turns
    // honestly when the transcript needs to distinguish them.
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
            case "data-presentation":
                // The reconstructed part is FLAT (fields spread under `part.type`); the readers narrow off
                // any loose record, so the same builders the live path uses map it to a byte-identical card.
                parts.push(presentationPart(part, analysisId));
                break;
            case "data-file-reference":
                parts.push(fileReferencePart(part, analysisId));
                break;
            case "data-report-preview":
                parts.push(reportPreviewPart(part, analysisId));
                break;
            case "data-report-preview-failed":
                parts.push(reportPreviewFailedPart(part, analysisId));
                break;
            default:
                // Observe a reconstructed part the UI has no first-class renderer for as a one-line tagged
                // mention — never swallowed. (The recognized display cards are handled in the cases above.)
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
    // The card resolver reaches the pool + workspace tree to rebuild plan/run cards from the persisted
    // tool_use rows; `unwrapOrThrow` inside it THROWS on a storage fault, so `contentToCortexMessages`
    // is bridged to a Result in `loadMessages` (neverthrow-first: a harness throw becomes our error state).
    // An unresolvable workspace root (moved/deleted anchor) degrades preview cards to chips rather than
    // failing the whole history load (the local-state desync rule).
    toCortex: (pool, analysisId, messages) =>
        workspaceRootForAnalysisId(analysisId).match(
            (root) => contentToCortexMessages(messages, createCardResolver(pool, analysisId, root)),
            () => contentToCortexMessages(messages, async () => null),
        ),
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
 * The thread id equals the session id. `loadPage` paginates by whole TURNS; page 0 reveals
 * the turn `total`. When the thread spans more than one page we take the last TWO pages (reusing page
 * 0 when it is one of them, never re-reading it) and concatenate their rows so a thread that has just
 * crossed a page boundary still mounts a full window — fetching only the last page would strand the
 * store on the boundary's remainder (a 201-turn thread would show the single 201st turn). The
 * concatenated rows map to UIMessages, then a trailing {@link MESSAGE_CAP} slice keeps the newest
 * MESSAGES. Note the unit shift: pages window TURNS, the trailing slice caps MESSAGES (the live-append
 * cap's unit). A missing pg thread (legacy session, or the runtime not yet booted) renders empty —
 * correct and expected: the legacy SQLite transcript is frozen and not shown here.
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
    const firstPage = firstRes.value;

    // The window is the last one or two TURN pages. `total` counts turns; `MESSAGE_CAP` is the per-page
    // turn budget (clamped to 200 inside `loadPage`). One page holds the whole thread; past that, pages
    // [lastPage-1, lastPage] give a full newest window across the boundary. Page 0 is already in hand,
    // so it is reused (never re-read) when it is one of the two — the only overlap possible, since 0 is
    // in the window iff lastPage === 1.
    const lastPage = Math.max(0, Math.ceil(firstPage.total / MESSAGE_CAP) - 1);
    const windowPages = lastPage === 0 ? [0] : [lastPage - 1, lastPage];

    const rowPages: (typeof firstPage.messages)[] = [];
    for (const p of windowPages) {
        if (p === 0) {
            rowPages.push(firstPage.messages);
            continue;
        }
        const res = await seams.loadPage(runtime.pool, sessionId, p, MESSAGE_CAP);
        if (myLoad !== loadGeneration) return;
        if (res.isErr()) {
            setErrorMsg(`Failed to load the conversation: ${res.error.type}`);
            setChatStatus("error");
            return;
        }
        rowPages.push(res.value.messages);
    }
    const rows = rowPages.flat();

    const mapped = await ResultAsync.fromPromise(seams.toCortex(runtime.pool, analysisId, rows), (e): unknown => e);
    if (myLoad !== loadGeneration) return;
    mapped.match(
        // Trailing cap is in MESSAGES (see the unit note in {@link loadMessages}'s doc and on
        // MESSAGE_CAP): two full turn pages can carry more than MESSAGE_CAP messages, so keep only the
        // newest MESSAGE_CAP so the mounted window matches the live-append cap. Record the session this
        // load mounted so `send` knows the history is already on screen and skips its post-turn reload.
        (cortex) => {
            setMessages(cortex.map((m) => cortexToUiMessage(m, sessionId, analysisId)).slice(-MESSAGE_CAP));
            loadedSessionId = sessionId;
        },
        (cause) => {
            setErrorMsg(`Failed to load the conversation: ${describeCause(cause)}`);
            setChatStatus("error");
        },
    );
}

// The in-flight chat request. Module-private: only `send`/`abort`/`resetHotState` touch it, so the
// controller's lifetime is owned alongside the state it cancels.
let abortController: AbortController | null = null;

// The in-flight turn's settlement, retained so a retract can await it: the engine's `appendTurn` runs
// before the outcome returns, so awaiting the outcome IS awaiting the durable append (the retract must
// remove the just-appended orphan, never race ahead of it), and the outcome carries the append fault
// that decides the durable step. Null when no turn is in flight. The RESOLVING side is a local closure
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
    openTools.clear();
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
    readonly reloadTranscript?: (sessionId: string, analysisId: string) => Promise<void>;
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
 * mid-flight — while the OLD turn is still unwinding (`appendTurn`'s pg round-trip; a tool ignoring
 * its signal), a NEW turn can already be streaming into a new session. So every event this turn emits
 * flows through one guarded sink that drops it once the token no longer matches, and the outcome is
 * dropped on the same check — a superseded turn NEVER touches the new turn's streaming signals,
 * status, error, or messages. Its `appendTurn` already ran (correctly) inside the engine on the old
 * thread; the only remaining work is UI-visible, so dropping it is exactly right.
 */
export async function send(opts: { sessionId: string; analysisId: string; userText: string }, seams: SendSeams = realSendSeams): Promise<void> {
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

    pushUserMessage(opts.sessionId, opts.userText);
    const assistantId = startAssistantTurn(opts.sessionId);
    // Stamp the turn's analysis so openable-card parts carry the scope their references resolve against.
    currentAnalysisId = opts.analysisId;
    setChatStatus("busy");
    const startedAt = Date.now();

    abortController = new AbortController();
    // The controller instance is this turn's token. Captured once; the module `abortController`
    // may be reassigned/nulled by a swap or reset while this turn is in flight.
    const myTurn = abortController;

    // Retain this turn's settlement + duration base so a retract can await the engine (the `appendTurn`
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
    const chat = createStreamingChat(runtime.conversation.provider, (text) => void emitForTurn({ type: "text-delta", text }));
    const session = buildChatSession("tui-chat", opts.analysisId, opts.sessionId);

    // The engine is contractually non-rejecting — every failure returns a `TurnOutcome`. But `turnSettled`
    // is awaited by the retract path, so this promise MUST settle on EVERY exit: a contract-violating throw
    // that skipped `settleTurn` below would hang a waiting retract forever with the status stuck busy. Catch
    // a rejection, synthesize the established `failed` outcome — carrying the throw (typed `unknown`, since a
    // throw carries anything) as its `cause` — and fall through to the SAME settle + failure handling as a
    // real `failed` outcome, so the UI shows the failure banner rather than hanging.
    const outcome: TurnOutcome = await seams
        .runChatTurn({
            pool: runtime.pool,
            conversationAgent: runtime.conversationAgent,
            chat,
            history: createThreadHistory(runtime.pool),
            session,
            emit: emitForTurn,
            signal: myTurn.signal,
            // Bind the ask seam to THIS turn's scope: a `ctx.ask` tool pauses on the runtime gateway
            // carrying the turn's analysis/thread, its abort signal, and its guarded emit sink, so the
            // gateway's `data-ask` emissions and its poll ride the same signal and sink as every other
            // turn event (a swap/reset that supersedes the turn drops them at `emitForTurn`).
            ask: (req) => runtime.askGateway.ask(req, { analysisId: opts.analysisId, threadId: opts.sessionId, signal: myTurn.signal, emit: emitForTurn }),
            analysisId: opts.analysisId,
            // The pg thread binds 1:1 to the session, so a plan launched here stamps its run.
            threadId: opts.sessionId,
            userInput: opts.userText,
        })
        .catch((cause: unknown): TurnOutcome => ({ kind: "failed", cause }));

    // Settle the retained turn promise BEFORE the supersession guard: a retract IS a superseding writer
    // (it claimed the token to abort this turn) and must still observe this outcome — it awaits
    // `turnSettled` to read the append fault and decide the durable step. `settleTurn` is the local
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
        await (seams.reloadTranscript ?? loadMessages)(opts.sessionId, opts.analysisId);
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
    openTools.clear();
    turnSettled = null;
    turnStartedAt = 0;
}

/**
 * Whether the aborted turn actually LANDED an orphan turn on the thread — the precondition for running
 * the durable retract. `ok`/`aborted`/`failed` reach `runAgent` and append unconditionally, so their
 * orphan is on the tail iff the append did not fault; `prepare_failed`/`thread_gone` bail BEFORE
 * `appendTurn`, so no orphan exists. Removing the tail when none of this turn's rows are there would
 * delete an EARLIER turn's real history — hence the gate.
 */
function turnAppendLanded(outcome: TurnOutcome): boolean {
    switch (outcome.kind) {
        case "ok":
        case "aborted":
        case "failed":
            return outcome.appendError === undefined;
        case "prepare_failed":
        case "thread_gone":
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
 * `no-user-turn` removed nothing (the append never landed, or an anomalous tail) — a benign no-op with
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
 * removed). Otherwise run the durable tail retract — SKIPPED when no orphan landed (append faulted, or a
 * prepare/thread bail) — and only then splice the live store and seed the composer, so the transcript
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

        // Fire the turn's abort so the engine unwinds and its unconditional `appendTurn` lands.
        abortController?.abort();

        // Await settlement — the append has run by the time the engine returns, so the durable removal below
        // targets the just-appended orphan rather than racing ahead of it.
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
 * Every openable card entry currently in the transcript, NEWEST first (latest message + latest-emitted
 * part first), excluding the non-openable `unavailable` entries (a failed preview has nothing to open).
 * The `o` binding opens `[0]` (the most recent); the picker lists them all. Read in a tracking scope —
 * reactive on the message store.
 */
export function sessionOpenables(): SessionOpenable[] {
    const out: SessionOpenable[] = [];
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const parts = messages[mi]!.parts;
        for (let pi = parts.length - 1; pi >= 0; pi--) {
            const part = parts[pi]!;
            if (part.type !== "openable-card") continue;
            for (let ei = part.entries.length - 1; ei >= 0; ei--) {
                const entry = part.entries[ei]!;
                if (entry.target.kind !== "unavailable") out.push({ analysisId: part.analysisId, entry });
            }
        }
    }
    return out;
}

/** The most recently emitted plan card in the mounted transcript, or null when none exists. */
export function latestPlanCard(): PlanCardPart | null {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const message = messages[mi];
        if (!message) continue;
        for (let pi = message.parts.length - 1; pi >= 0; pi--) {
            const part = message.parts[pi];
            if (part?.type === "plan-card") return part;
        }
    }
    return null;
}
