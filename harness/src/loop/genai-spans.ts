/**
 * OpenTelemetry GenAI spans for the agent loop: `invoke_agent` around a run of
 * `runAgent`, and `execute_tool` around each tool call that it dispatches. The AI
 * SDK traces the model calls (`providers/ai-sdk.ts`). It never sees the loop or
 * the tools, because the harness runs both itself.
 *
 * No span carries a tool argument, stdout, or model text. A failed tool call
 * carries its error message and, for a sandbox exec, the tail of stderr, each
 * capped to fit the attribute cut of the trace store.
 */

import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { ToolCallPart } from "ai";

import type { AgentSession } from "../auth/types.js";
import type { ToolExecFailure, ToolFailure } from "../tools/define-tool.js";
import type { ToolOutcome } from "./tool-outcome.js";

/** The cap of the status description of a failed tool call, in bytes. */
const STATUS_MESSAGE_BYTES = 1_024;

/**
 * The cap of the stderr tail: the last 2,048 bytes or 80 lines, whichever is
 * shorter. It is the rule of the Kubernetes termination message, and it fits
 * the 2,048-byte attribute cut of Tempo.
 */
const STDERR_TAIL_BYTES = 2_048;
const STDERR_TAIL_LINES = 80;

/** How one tool call ended: the outcome that the agent received, and the failure when the call failed. */
export interface ToolCallEnd {
    readonly outcome: ToolOutcome;
    readonly failure?: ToolFailure;
}

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

/**
 * Run one tool call under an `execute_tool` span that records how the call ended.
 * A failure sets the status to ERROR even when the outcome is `ok`, because a
 * tool can return a failure to the agent as data.
 */
export function traceToolCall<T>(call: Pick<ToolCallPart, "toolName" | "toolCallId">, run: () => Promise<T>, endOf: (value: T) => ToolCallEnd): Promise<T> {
    const attributes = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.toolName, "gen_ai.tool.call.id": call.toolCallId };
    return withSpan(`execute_tool ${call.toolName}`, attributes, async (span) => {
        const value = await run();
        const { outcome, failure } = endOf(value);
        span.setAttribute("inflexa.tool.outcome", outcome);
        if (failure !== undefined) recordToolFailure(span, failure);
        else if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
        return value;
    });
}

function recordToolFailure(span: Span, failure: ToolFailure): void {
    span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(failure.message === undefined ? {} : { message: utf8Head(failure.message, STATUS_MESSAGE_BYTES) }),
    });
    span.setAttribute("error.type", failure.type);
    if (failure.exec !== undefined) span.setAttributes(execFailureAttributes(failure.exec));
}

function execFailureAttributes(exec: ToolExecFailure): Attributes {
    const tail = utf8Tail(lastLines(exec.stderr, STDERR_TAIL_LINES), STDERR_TAIL_BYTES);
    return {
        "inflexa.sandbox.outcome": exec.outcome,
        "inflexa.sandbox.timed_out": exec.timedOut,
        "inflexa.sandbox.stderr_bytes": exec.stderrBytes,
        "inflexa.sandbox.stderr_head_only": exec.stderrHeadOnly,
        ...(exec.exitCode === null ? {} : { "inflexa.sandbox.exit_code": exec.exitCode }),
        ...(exec.syntheticReason === undefined ? {} : { "inflexa.sandbox.synthetic_reason": exec.syntheticReason }),
        ...(tail.length === 0 ? {} : { "inflexa.sandbox.stderr_tail": tail }),
    };
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

/** The last `maxLines` lines of `text`. A final newline ends the last line, and it does not start a new one. */
function lastLines(text: string, maxLines: number): string {
    let cut = text.endsWith("\n") ? text.length - 1 : text.length;
    for (let line = 0; line < maxLines; line++) {
        if (cut <= 0) return text;
        cut = text.lastIndexOf("\n", cut - 1);
        if (cut === -1) return text;
    }
    return text.slice(cut + 1);
}

/**
 * The first `maxBytes` bytes of `text` as UTF-8, cut before a character that
 * does not fit whole. The slice before the encode bounds the allocation: one
 * UTF-16 code unit encodes to at least one byte.
 */
function utf8Head(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    const bytes = Buffer.from(text.slice(0, maxBytes), "utf8");
    let end = maxBytes;
    while (end > 0 && isContinuationByte(bytes[end])) end--;
    return bytes.subarray(0, end).toString("utf8");
}

/** The last `maxBytes` bytes of `text` as UTF-8, cut after a character that does not fit whole. */
function utf8Tail(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    const bytes = Buffer.from(text.slice(-maxBytes), "utf8");
    let start = bytes.length - maxBytes;
    while (start < bytes.length && isContinuationByte(bytes[start])) start++;
    return bytes.subarray(start).toString("utf8");
}

function isContinuationByte(byte: number | undefined): boolean {
    return byte !== undefined && (byte & 0xc0) === 0x80;
}
