/**
 * OpenTelemetry GenAI spans for the agent loop: `invoke_agent` around a run of
 * `runAgent`, and `execute_tool` around each tool call that it dispatches. The AI
 * SDK traces the model calls (`providers/ai-sdk.ts`). It never sees the loop or
 * the tools, because the harness runs both itself.
 *
 * An `execute_tool` span is ERROR when our code fails the call. A failure that a
 * tool returns as data, for example a sandbox command that exits non-zero, is
 * normal iteration of the agent, and its span stays OK.
 */

import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { ToolCallPart } from "ai";

import type { AgentSession } from "../auth/types.js";
import type { ToolOutcome } from "./tool-outcome.js";

interface AgentRun {
    readonly finish: { readonly reason: string; readonly cappedOut: boolean };
}

/** Run one agent loop under an `invoke_agent` span. */
export function traceAgentRun<T extends AgentRun>(agentName: string, session: AgentSession, run: () => Promise<T>): Promise<T> {
    const attributes = { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agentName, ...runFrameAttributes(session) };
    return withSpan(`invoke_agent ${agentName}`, attributes, async (span) => {
        const result = await run();
        span.setAttributes({ "gen_ai.response.finish_reasons": [result.finish.reason], "inflexa.agent.capped_out": result.finish.cappedOut });
        return result;
    });
}

/** Run one tool call under an `execute_tool` span that records how the call ended. */
export function traceToolCall<T>(call: Pick<ToolCallPart, "toolName" | "toolCallId">, run: () => Promise<T>, outcomeOf: (value: T) => ToolOutcome): Promise<T> {
    const attributes = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.toolName, "gen_ai.tool.call.id": call.toolCallId };
    return withSpan(`execute_tool ${call.toolName}`, attributes, async (span) => {
        const value = await run();
        const outcome = outcomeOf(value);
        span.setAttribute("inflexa.tool.outcome", outcome);
        if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
        return value;
    });
}

/** The cap of `inflexa.tool.error`, in characters. */
const TOOL_ERROR_MAX_CHARS = 1_000;

/**
 * Record an exception that a tool threw on the active `execute_tool` span.
 * `error.type` is the code of the error when it has one, else its name.
 */
export function recordToolException(err: Error): void {
    const span = trace.getActiveSpan();
    if (span === undefined) return;
    span.recordException(err);
    span.setAttribute("error.type", errorTypeOf(err));
}

/**
 * Label a tool failure that is not an exception on the active `execute_tool`
 * span. `message` is text that our tool wrote, never text from the model.
 */
export function labelToolFailure(type: string, message?: string): void {
    const span = trace.getActiveSpan();
    if (span === undefined) return;
    span.setAttribute("error.type", type);
    if (message !== undefined) span.setAttribute("inflexa.tool.error", message.slice(0, TOOL_ERROR_MAX_CHARS));
}

/**
 * Label a tool call whose input failed validation on the active `execute_tool`
 * span. `issues` is the shape of the failure, with no value of the input.
 */
export function labelToolValidationFailure(issues: readonly string[]): void {
    const span = trace.getActiveSpan();
    if (span === undefined) return;
    span.setAttributes({ "error.type": "validation", "inflexa.tool.validation.issues": [...issues] });
}

function errorTypeOf(err: Error): string {
    const code = "code" in err ? err.code : undefined;
    if ((typeof code === "string" && code !== "") || typeof code === "number") return String(code);
    return err.name === "" ? "_OTHER" : err.name;
}

function withSpan<T>(name: string, attributes: Attributes, run: (span: Span) => Promise<T>): Promise<T> {
    return trace.getTracer("@inflexa-ai/harness").startActiveSpan(name, { attributes }, async (span) => {
        try {
            return await run(span);
        } catch (err) {
            // A cancellation is the caller's decision, not a failure.
            const cancelled = err instanceof Error && err.name === "AbortError";
            if (!cancelled) {
                span.setStatus({ code: SpanStatusCode.ERROR });
                if (err instanceof Error) span.recordException(err);
            }
            throw err;
        } finally {
            span.end();
        }
    });
}

function runFrameAttributes({ runFrame }: AgentSession): Attributes {
    if (runFrame === undefined) return {};
    return { "inflexa.run_id": runFrame.runId, ...(runFrame.stepId === undefined ? {} : { "inflexa.step_id": runFrame.stepId }) };
}
