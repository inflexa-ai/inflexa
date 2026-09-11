/**
 * The GenAI spans of the harness, after the OpenTelemetry GenAI semantic
 * conventions: a `chat` span for each provider call, an `invoke_agent` span for
 * each `runAgent`, and an `execute_tool` span for each tool call that runs. A
 * chat turn and a durable run render the same tree:
 *
 *     invoke_agent {agent}
 *       chat {model}
 *       execute_tool {tool}
 *         invoke_agent {sub-agent}      (a tool that runs a loop of its own)
 *
 * Inside a DBOS workflow the loop runs each model call and each step-mode tool
 * call as a DBOS step, and DBOS opens a span for the step. The loop runs that
 * body in `supersedeStepSpan` (`otel-spans.ts`), which drops the DBOS span and
 * hands its parent to the GenAI span, so each call is one span in both paths.
 *
 * The spans carry identity, timing, outcome, and the token counts of each call.
 * They never carry a prompt, a completion, tool arguments, a tool result, or an
 * error message: the text is durable in Postgres already, and a provider error
 * message can quote a response body. A failure carries its class in
 * `error.type` and nothing more.
 *
 * Replay: a DBOS step that replays returns its recorded value and never runs its
 * body, and each span opens inside the body, so a replayed call emits nothing.
 *
 * With no tracer provider registered the API hands out non-recording spans, and
 * each helper costs one no-op object.
 *
 * The attribute names are local constants: `@opentelemetry/semantic-conventions`
 * marks its `gen_ai.*` exports as moved to the GenAI conventions repository, and
 * it spells the cache-write count `cache_creation` where the current
 * conventions say `gen_ai.usage.cache_write.input_tokens`.
 */

import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { LanguageModel } from "ai";

import type { AgentSession } from "../auth/types.js";
import type { ToolOutcome } from "../contracts/chat-events.js";
import { extractStatus, isProviderError, type ProviderError } from "../providers/errors.js";
import type { ChatResponse, ChatUsage } from "../providers/types.js";
import { ATTR_INFLEXA_ATTEMPT, ATTR_INFLEXA_RUN_ID, ATTR_INFLEXA_STEP_ID } from "./otel-spans.js";
import { ResultError } from "./result.js";

const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_REQUEST_STREAM = "gen_ai.request.stream";
const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
const GEN_AI_TOOL_TYPE = "gen_ai.tool.type";
const SERVER_ADDRESS = "server.address";
const SERVER_PORT = "server.port";
const ERROR_TYPE = "error.type";
const HTTP_RESPONSE_STATUS_CODE = "http.response.status_code";

/** Each count of `ChatUsage`, by the attribute that carries it. An unreported count sets no attribute. */
const USAGE_ATTRIBUTES: ReadonlyArray<readonly [string, keyof ChatUsage]> = [
    ["gen_ai.usage.input_tokens", "inputTokens"],
    ["gen_ai.usage.output_tokens", "outputTokens"],
    ["gen_ai.usage.cache_read.input_tokens", "cacheReadInputTokens"],
    ["gen_ai.usage.cache_write.input_tokens", "cacheCreationInputTokens"],
    ["gen_ai.usage.reasoning.output_tokens", "reasoningTokens"],
];

/** The iterations of a `runAgent`, the tool-less wrap-up excluded. */
const ATTR_AGENT_ITERATIONS = "inflexa.agent.iterations";
/** Whether a `runAgent` exhausted `maxIterations` and took the forced wrap-up. */
const ATTR_AGENT_CAPPED_OUT = "inflexa.agent.capped_out";
/** How a tool call ended: `ok`, `error`, or `denied` (the user refused it, which is not a failure). */
const ATTR_TOOL_OUTCOME = "inflexa.tool.outcome";
/** The delay before the next attempt of a retried provider call, in milliseconds. */
const ATTR_RETRY_DELAY_MS = "inflexa.retry.delay_ms";

/**
 * The `error.type` values these spans report:
 *
 * - a chat call: the `ProviderError` kind (`auth`, `budget`, `tenant-blocked`,
 *   `provider`); the HTTP status, when the failure has one, rides beside it in
 *   `http.response.status_code`.
 * - an agent run that throws: the same kind when a provider failure ended it,
 *   else the name of the thrown error, else `_OTHER`.
 * - a tool call whose result the model reads as an error: `tool_error`.
 *
 * A cancellation (`AbortError`) sets none: it is the caller's decision.
 */
const TOOL_ERROR = "tool_error";
const OTHER_ERROR = "_OTHER";

function tracer() {
    return trace.getTracer("cortex.harness.genai");
}

/** The span name and the attributes that each call of one provider carries from its start. */
export interface ChatTarget {
    readonly spanName: string;
    readonly attributes: Attributes;
}

/**
 * Describe the calls of one provider. The AI SDK provider id of `model` up to
 * its first dot gives `gen_ai.provider.name` (`anthropic.messages` is
 * `anthropic`): the wire the harness speaks, which is what the conventions ask
 * for when a gateway relays the call. The host and port of `endpoint` give
 * `server.address` and `server.port`.
 */
export function chatTarget(model: LanguageModel, requestModel: string | undefined, endpoint: string | undefined): ChatTarget {
    const providerName = providerNameOf(model);
    return {
        spanName: requestModel === undefined ? "chat" : `chat ${requestModel}`,
        attributes: {
            [GEN_AI_OPERATION_NAME]: "chat",
            ...(providerName === undefined ? {} : { [GEN_AI_PROVIDER_NAME]: providerName }),
            ...(requestModel === undefined ? {} : { [GEN_AI_REQUEST_MODEL]: requestModel }),
            // Both provider entry points stream on the wire.
            [GEN_AI_REQUEST_STREAM]: true,
            ...serverAttributes(endpoint),
        },
    };
}

function providerNameOf(model: LanguageModel): string | undefined {
    if (typeof model === "string") return undefined;
    const family = model.provider.split(".")[0];
    // The one installed family whose AI SDK id differs from the conventions' name.
    return family === "amazon-bedrock" ? "aws.bedrock" : family;
}

function serverAttributes(endpoint: string | undefined): Attributes {
    if (endpoint === undefined || !URL.canParse(endpoint)) return {};
    const url = new URL(endpoint);
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
    return { [SERVER_ADDRESS]: url.hostname, ...(port === undefined ? {} : { [SERVER_PORT]: port }) };
}

/** The `chat` span of one provider call. Each member that ends the span ends it once; a later one is a no-op. */
export interface ChatSpan {
    /** Bind `fn` to this span: the wire call that `fn` makes runs under it, so each outbound request names it as the parent. */
    readonly bind: <F extends (...args: never[]) => unknown>(fn: F) => F;
    /** Record one retry as a span event: the attempt that failed, the delay before the next one, and the HTTP status of the failure. */
    readonly retry: (attempt: number, delayMs: number, error: unknown) => void;
    /** Record the reply and end the span. */
    readonly succeed: (response: ChatResponse) => void;
    /** Record the class of a failed call and end the span. */
    readonly fail: (failure: ProviderError) => void;
    /**
     * End the span if nothing ended it: the caller cancelled the call, or it
     * stopped reading the stream. The conventions ask for the finish reason
     * `error` for a generation that did not finish.
     */
    readonly close: () => void;
}

/** Start the `chat` span of one call, as a child of the active span. */
export function startChatSpan(target: ChatTarget): ChatSpan {
    const span = tracer().startSpan(target.spanName, { kind: SpanKind.CLIENT, attributes: target.attributes });
    const active = trace.setSpan(context.active(), span);
    let open = true;
    const end = (attributes: Attributes, failed: boolean): void => {
        if (!open) return;
        open = false;
        span.setAttributes(attributes);
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
    };
    return {
        bind: (fn) => context.bind(active, fn),
        retry: (attempt, delayMs, error) => {
            span.addEvent("retry", { [ATTR_INFLEXA_ATTEMPT]: attempt, [ATTR_RETRY_DELAY_MS]: Math.round(delayMs), ...statusAttribute(error) });
        },
        succeed: (response) => end(responseAttributes(response), false),
        fail: (failure) => end({ [GEN_AI_RESPONSE_FINISH_REASONS]: ["error"], [ERROR_TYPE]: failure.type, ...statusAttribute(failure.cause) }, true),
        close: () => end({ [GEN_AI_RESPONSE_FINISH_REASONS]: ["error"] }, false),
    };
}

function statusAttribute(error: unknown): Attributes {
    const status = extractStatus(error);
    return status === undefined ? {} : { [HTTP_RESPONSE_STATUS_CODE]: status };
}

function responseAttributes(response: ChatResponse): Attributes {
    const attributes: Attributes = { [GEN_AI_RESPONSE_FINISH_REASONS]: [response.finishReason] };
    // Only the model the endpoint itself reported: `requestedModelId` already rides as the request model.
    if (response.servedModelId !== undefined) attributes[GEN_AI_RESPONSE_MODEL] = response.servedModelId;
    for (const [key, field] of USAGE_ATTRIBUTES) {
        const count = response.usage?.[field];
        if (count !== undefined) attributes[key] = count;
    }
    return attributes;
}

/** What the loop records on its own `invoke_agent` span while it runs. */
export interface AgentSpan {
    readonly iterated: (iterations: number) => void;
}

interface AgentRunResult {
    readonly finish: { readonly reason: string; readonly cappedOut: boolean };
}

/**
 * Run one agent loop under an `invoke_agent` span. The run and the plan step
 * of the session's run frame ride as `inflexa.run_id` and `inflexa.step_id`; a
 * chat turn has no run frame and carries neither. The span records the finish
 * reason and the cap of the result, or the class of the error the loop threw.
 */
export async function traceAgentRun<T extends AgentRunResult>(agentName: string, session: AgentSession, run: (span: AgentSpan) => Promise<T>): Promise<T> {
    const span = tracer().startSpan(`invoke_agent ${agentName}`, {
        kind: SpanKind.INTERNAL,
        attributes: { [GEN_AI_OPERATION_NAME]: "invoke_agent", [GEN_AI_AGENT_NAME]: agentName, ...runFrameAttributes(session) },
    });
    try {
        const result = await context.with(trace.setSpan(context.active(), span), () =>
            run({ iterated: (iterations) => span.setAttribute(ATTR_AGENT_ITERATIONS, iterations) }),
        );
        span.setAttributes({ [GEN_AI_RESPONSE_FINISH_REASONS]: [result.finish.reason], [ATTR_AGENT_CAPPED_OUT]: result.finish.cappedOut });
        return result;
    } catch (err) {
        span.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, ["error"]);
        recordThrown(span, err);
        throw err;
    } finally {
        span.end();
    }
}

function runFrameAttributes(session: AgentSession): Attributes {
    const frame = session.runFrame;
    if (frame === undefined) return {};
    return { [ATTR_INFLEXA_RUN_ID]: frame.runId, ...(frame.stepId === undefined ? {} : { [ATTR_INFLEXA_STEP_ID]: frame.stepId }) };
}

/** The identity of one tool call on its `execute_tool` span. */
export interface ToolCallIdentity {
    readonly toolName: string;
    readonly toolCallId: string;
    /** The agent whose loop dispatched the call. */
    readonly agentName: string;
}

/** Run one tool call under an `execute_tool` span that records its outcome. */
export async function traceToolCall<T>(call: ToolCallIdentity, run: () => Promise<T>, outcomeOf: (value: T) => ToolOutcome): Promise<T> {
    const span = tracer().startSpan(`execute_tool ${call.toolName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
            [GEN_AI_OPERATION_NAME]: "execute_tool",
            [GEN_AI_TOOL_NAME]: call.toolName,
            [GEN_AI_TOOL_CALL_ID]: call.toolCallId,
            // The model names the function and its arguments, and the harness runs it.
            [GEN_AI_TOOL_TYPE]: "function",
            [GEN_AI_AGENT_NAME]: call.agentName,
        },
    });
    try {
        const value = await context.with(trace.setSpan(context.active(), span), run);
        const outcome = outcomeOf(value);
        span.setAttribute(ATTR_TOOL_OUTCOME, outcome);
        if (outcome === "error") {
            span.setAttribute(ERROR_TYPE, TOOL_ERROR);
            span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return value;
    } catch (err) {
        recordThrown(span, err);
        throw err;
    } finally {
        span.end();
    }
}

function recordThrown(span: Span, err: unknown): void {
    if ((err instanceof Error || err instanceof DOMException) && err.name === "AbortError") return;
    span.setAttribute(ERROR_TYPE, errorTypeOf(err));
    span.setStatus({ code: SpanStatusCode.ERROR });
}

function errorTypeOf(err: unknown): string {
    // A failed model call reaches the loop's caller as the `ProviderError` that `unwrapOrThrow` wrapped.
    const value = err instanceof ResultError ? err.value : err;
    if (isProviderError(value)) return value.type;
    if (value instanceof Error && value.name !== "Error") return value.name;
    return OTHER_ERROR;
}
