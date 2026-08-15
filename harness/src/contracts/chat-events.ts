/**
 * Cortex-native chat-stream events — the harness wire vocabulary.
 *
 * Distinct from the 15 `data-*` chat parts (`chat-parts.ts`): those are UI
 * presentation payloads a tool emits; these are the agent-loop stream events
 * the harness chat route frames as Cortex-native SSE. Together they are the
 * sole Cortex↔frontend wire contract — there is no AI SDK UI Message Stream
 * Protocol and no translation layer.
 *
 * Every event carries `source` — the agent call chain at the point of
 * emission, derived from the harness `Session.callPath`.
 */

import type { TokenUsageRollup } from "./usage.js";

/**
 * Provenance stamped on every chat-stream event: the emitting agent and the
 * call chain that reached it (e.g. `["conversation-agent"]`, or
 * `["conversation-agent", "literature-reviewer"]` for a sub-agent).
 */
export interface EventSource {
    agentId: string;
    callPath: string[];
}

/** A run of assistant text. Deltas accumulate into the turn's reply. */
export interface TextDeltaEvent {
    type: "text-delta";
    text: string;
    source: EventSource;
}

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

/** A tool call has been dispatched. */
export interface ToolStartedEvent {
    type: "tool-started";
    /** The Anthropic `tool_use` block id — pairs with `tool-finished`. */
    toolUseId: string;
    /** The tool name. */
    name: string;
    /** See {@link ToolCallDetail}. Absent — never empty — when none was produced. */
    detail?: ToolCallDetail;
    source: EventSource;
}

/** A tool call has resolved. */
export interface ToolFinishedEvent {
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
}

/**
 * The agent loop produced its terminal reply — the turn is complete.
 *
 * Both rollups are absent whenever no covered call reported usage; neither is
 * ever an all-zero figure. A turn that dies instead of finishing emits
 * `ChatErrorEvent` and therefore no rollup at all — the usage-record ledger,
 * not this event, is the complete account of what a turn spent.
 */
export interface FinishEvent {
    type: "finish";
    source: EventSource;
    /** What this loop's own LLM calls used, the forced wrap-up included. */
    usage?: TokenUsageRollup;
    /**
     * The whole turn's total — this loop's calls plus every descendant loop's
     * (sub-agent tools included). Present only on the turn's root loop.
     */
    turnUsage?: TokenUsageRollup;
}

/** The turn failed. `reason` is a machine-readable code when one applies. */
export interface ChatErrorEvent {
    type: "error";
    /** Human-readable, scrubbed error message. */
    message: string;
    /** Machine-readable failure code, e.g. `"budget_exceeded"`. */
    reason?: string;
    source: EventSource;
}

/** The discriminated union of all Cortex-native chat-stream events. */
export type CortexChatEvent = TextDeltaEvent | ToolStartedEvent | ToolFinishedEvent | FinishEvent | ChatErrorEvent;
