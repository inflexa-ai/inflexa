/**
 * Chat-stream events — the harness wire vocabulary.
 *
 * Distinct from the `data-*` chat parts (`chat-parts.ts`): those are UI
 * presentation payloads a tool emits; these are the agent-loop stream events
 * the host chat route frames as SSE. Together they are the sole
 * host↔frontend wire contract — there is no AI SDK UI Message Stream
 * Protocol and no translation layer.
 *
 * Every event carries `source` — the agent call chain at the point of
 * emission, derived from the harness `Session.callPath`.
 */

import type { ChatPart } from "./chat-parts.js";
import type { TokenUsageRollup } from "./usage.js";

/**
 * Provenance stamped on every chat-stream event: the emitting agent and the
 * call chain that reached it (e.g. `["conversation-agent"]`, or
 * `["conversation-agent", "literature-reviewer"]` for a sub-agent).
 */
export type EventSource = {
    agentId: string;
    callPath: string[];
    /** The id of the tool call that runs this loop. For a data profile, the workflow id of its attempt. */
    invocationId?: string;
};

/** A run of assistant text. Deltas accumulate into the turn's reply. */
export type TextDeltaEvent = {
    type: "text-delta";
    text: string;
    source: EventSource;
};

/**
 * How a tool call ended.
 *
 * Three states, not a boolean: a user who rejects an approval made a decision,
 * and reporting that decision as a fault misdescribes it. The loop already
 * separates the two in its control flow — a denial ends the turn, an error is
 * one the model reads and retries around — so the observation channel carries
 * the same distinction. One field rather than two booleans, because two would
 * admit the impossible "not an error, but denied".
 */
export type ToolOutcome = "ok" | "error" | "denied";

/**
 * How a RECORDED call ended — the three live outcomes plus `incomplete`.
 *
 * `incomplete` is the state a live event cannot carry and a record cannot avoid:
 * the harness observed a dispatch and no completion, because the turn was cut off
 * mid-call. A `tool-finished` is never incomplete, which is why this widens
 * {@link ToolOutcome} rather than replacing it.
 *
 * It is a fourth value of ONE field rather than a second field beside the outcome,
 * for the same reason the outcome is three-way instead of `isError` plus `denied`:
 * a call has exactly one terminal state, and splitting that across two fields both
 * admits impossible pairs and leaves every consumer to invent the meaning of the
 * combination. A consumer switches on this one field, and a consumer that forgets
 * a case fails to compile rather than silently reporting a success.
 */
export type ToolCallOutcome = ToolOutcome | "incomplete";

/**
 * One line naming what a tool call is doing, produced by the tool's own
 * `describeCall` or `describeResult` hook and normalized at the emit site.
 *
 * Opaque display text. A consumer renders it and derives nothing from it — no
 * splitting, no keying on separators. The contract is harness-owned so it can
 * widen when a renderer needs structure; parsing it would recreate the schema
 * coupling the hook exists to remove. Absent when the tool declares no hook, or
 * when the detail could not be produced.
 */
export type ToolCallDetail = string;

/**
 * A sub-agent loop started a request to its model. Only a sub-agent gives this frame, thus a consumer that
 * keeps the root frames only (`isRootFrame`) never sees it. A host reads it as "the sub-agent thinks".
 */
export type IterationEvent = {
    type: "iteration";
    source: EventSource;
};

/** A tool call has been dispatched. */
export type ToolStartedEvent = {
    type: "tool-started";
    /** The Anthropic `tool_use` block id — pairs with `tool-finished`. */
    toolUseId: string;
    /** The tool name. */
    name: string;
    /** See {@link ToolCallDetail}. Absent — never empty — when none was produced. */
    detail?: ToolCallDetail;
    source: EventSource;
};

/** A tool call has resolved. */
export type ToolFinishedEvent = {
    type: "tool-finished";
    toolUseId: string;
    name: string;
    /** How the call ended. See {@link ToolOutcome}. */
    outcome: ToolOutcome;
    /**
     * See {@link ToolCallDetail}. It can differ from the detail the matching
     * `tool-started` carried: a tool that describes its own result names the
     * outcome here, and a call that produced none carries the started detail
     * again.
     */
    detail?: ToolCallDetail;
    /**
     * The time in milliseconds around this call's own dispatch. Absent — never
     * zero — when the harness took no measurement.
     *
     * A host must read it as `event.durationMs ?? (its own bracket)`. The bracket
     * of a host spans the whole round, because the loop emits every start before
     * it dispatches anything. Thus the fallback is correct only for one call.
     */
    durationMs?: number;
    source: EventSource;
};

/**
 * The agent loop produced its terminal reply — the turn is complete.
 *
 * Both rollups are absent whenever no covered call reported usage; neither is
 * ever an all-zero figure. A turn that dies instead of finishing emits
 * `ChatErrorEvent` and therefore no rollup at all — the usage-record ledger,
 * not this event, is the complete account of what a turn spent.
 */
export type FinishEvent = {
    type: "finish";
    source: EventSource;
    /** What this loop's own LLM calls used, the forced wrap-up included. */
    usage?: TokenUsageRollup;
    /**
     * The whole turn's total — this loop's calls plus every descendant loop's
     * (sub-agent tools included). Present only on the turn's root loop.
     */
    turnUsage?: TokenUsageRollup;
};

/** The turn failed. `reason` is a machine-readable code when one applies. */
export type ChatErrorEvent = {
    type: "error";
    /** Human-readable, scrubbed error message. */
    message: string;
    /**
     * Machine-readable failure code. For a turn that a `suspend` error failed, it
     * is the suspend reason of the host, carried unread (`suspensionOfFailure`).
     */
    reason?: string;
    source: EventSource;
};

/**
 * The id that the stored display gives a message of the turn. The frames after it belong to that message, up to
 * the next `message-start` of the same role.
 */
export type MessageStartEvent = {
    type: "message-start";
    messageId: string;
    role: "user" | "assistant";
    source: EventSource;
};

/** The discriminated union of all chat-stream events. */
export type ChatEvent = TextDeltaEvent | IterationEvent | ToolStartedEvent | ToolFinishedEvent | FinishEvent | ChatErrorEvent | MessageStartEvent;

/**
 * A `data-*` part as a frame, with the source of its emitter when the emitter stamped one. A part whose type the
 * part registry does not know rides as the emitter sent it — a newer emitter can lead the registry — so the frame
 * also admits that record shape. The `data-` prefix stays required, so the loop-event narrowings exclude it.
 */
export type ChatPartFrame = (ChatPart & { source?: EventSource }) | ({ type: `data-${string}`; source?: EventSource } & Record<string, unknown>);

/** One frame of a chat stream or a run stream: a loop event or a `data-*` part. */
export type ChatFrame = ChatEvent | ChatPartFrame;
