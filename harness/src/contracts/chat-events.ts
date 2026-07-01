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

/** A tool call has been dispatched. */
export interface ToolStartedEvent {
    type: "tool-started";
    /** The Anthropic `tool_use` block id — pairs with `tool-finished`. */
    toolUseId: string;
    /** The tool name. */
    name: string;
    source: EventSource;
}

/** A tool call has resolved. */
export interface ToolFinishedEvent {
    type: "tool-finished";
    toolUseId: string;
    name: string;
    /** True when the tool produced an `is_error` result. */
    isError: boolean;
    source: EventSource;
}

/** The agent loop produced its terminal reply — the turn is complete. */
export interface FinishEvent {
    type: "finish";
    source: EventSource;
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
