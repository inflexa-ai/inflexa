/**
 * `runAgent` — the harness agent loop.
 *
 * A pure-async function: it owns the message loop and nothing else.
 * Durability (`runStep`) and the event sink (`emit`) are injected, so the
 * same body runs in the chat HTTP route (in-process, `passthroughStep`)
 * and inside DBOS workflow steps (`DBOS.runStep`). Each LLM call is its own
 * durable step, so recovery resumes mid-loop rather than re-issuing every
 * prior call.
 *
 * It guarantees four message-shape invariants (see the spec):
 *   1. Assistant content blocks — signed `thinking` included — are appended
 *      verbatim. No flattening.
 *   2. Every `tool_use` from one assistant message produces `tool_result`
 *      blocks in exactly one following `user` message, no interleaved text.
 *   3. Parallel `tool_use` is dispatched and assembled in array order.
 *   4. The messages array is append-only — prior messages never mutated.
 *
 * The working message type is Anthropic-shaped `MessageParam` (`LoopMessage`)
 * — the array holds assistant replies and the `user` tool-result messages
 * the loop appends. The spec calls this the `Message[]` the loop returns.
 *
 * Step names follow a documented contract — `llm-${i}` and
 * `tool-${name}-${toolUseId}` — consumed by DBOS replay caching and
 * workflow-transcript reconstruction (see the harness-thread-store spec).
 */

import type { Tool as AnthropicTool, TextBlockParam, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import { classifyProviderError } from "../providers/errors.js";
import { resultStep } from "./run-step.js";
import type { AgentChat, ChatRequest, Message } from "../providers/types.js";
import { isToolError, type Tool, type ToolContext } from "../tools/define-tool.js";
import { recordAgentRun } from "./metrics.js";
import type { AgentDefinition, EmitFn, EventSource, LoopMessage, RunStep } from "./types.js";

/**
 * The terminal signal of a `runAgent` run.
 *
 * `reason` is the real terminal `stop_reason` on a clean stop, or
 * `"max_iterations"` when the runaway guard fired the tool-less wrap-up.
 * `cappedOut` is true on that wrap-up path. `truncationRecoveries` counts
 * how many `max_tokens` soft-errors the loop recovered from (see the harness-agent-loop spec).
 */
export interface AgentFinish {
    readonly reason: NonNullable<Message["stop_reason"]> | "max_iterations";
    readonly cappedOut: boolean;
    readonly truncationRecoveries: number;
}

/** The result of one `runAgent` run: the message array plus the terminal signal. */
export interface RunAgentResult {
    readonly messages: LoopMessage[];
    readonly finish: AgentFinish;
}

/**
 * Steering turn appended after a truncated prose reply (no tool_use), so the
 * model resumes within the next iteration rather than the loop stopping.
 */
const TRUNCATED_PROSE_STEER = "Your previous reply was cut off at the output-token limit — continue concisely, or finish via your terminal tool.";

/**
 * Synthesized `tool_result` for a truncated trailing `tool_use`. The call is
 * refused (its input may be silently incomplete), never executed — generic
 * wording, no tool names (see the harness-agent-loop spec).
 */
const TRUNCATED_TOOL_USE_ERROR =
    "Your previous tool call was cut off at the output-token limit and was not executed. Retry with a smaller payload, writing in incremental pieces.";

/**
 * Step-name formatters — let workflow callers customize the cache keys
 * `runStep` sees. The default keeps the documented chat-path contract
 * (`llm-${i}` / `tool-${name}-${toolUseId}`); the durable executeAnalysis
 * workflow overrides this to fold in an `attempt` suffix so a resumed
 * workflow's LLM call hits a fresh cache slot (NOTES #3 — the 402 resume
 * mechanism).
 */
export interface StepNameFormatter {
    llm(iteration: number): string;
    tool(toolName: string, toolUseId: string): string;
}

export const DEFAULT_STEP_NAME_FORMATTER: StepNameFormatter = {
    llm: (i) => `llm-${i}`,
    tool: (name, id) => `tool-${name}-${id}`,
};

/** The injected per-call dependencies of `runAgent`. */
export interface RunAgentOptions {
    /**
     * The LLM seam. The loop calls `chat` — one request, one collapsed
     * `Message`. Streaming, when wanted, is a property of the `AgentChat`
     * passed in (see `createStreamingChat`); the loop itself is agnostic.
     */
    readonly provider: AgentChat;
    /** Cancellation — propagated to every provider and tool call. */
    readonly signal: AbortSignal;
    /** The flat orchestration-event sink. */
    readonly emit: EmitFn;
    /** Durability seam — `passthroughStep` for chat, `DBOS.runStep` in workflows. */
    readonly runStep: RunStep;
    /**
     * Optional step-name formatters. Defaults match the chat-path contract;
     * the durable workflow swaps this in to inject an attempt suffix so
     * resumed runs do not return a cached 402 error from the prior attempt.
     */
    readonly formatStepName?: StepNameFormatter;
    /**
     * Predicate marking an error that MUST abort the loop instead of being
     * folded into an `is_error` `tool_result`. A `bodyContext` tool runs
     * unwrapped in the workflow body, so a `DBOS.runStep` inside its `execute`
     * can throw a workflow-lifecycle error (cancellation) straight into
     * `dispatchTool`'s catch — swallowing that would let the loop issue one
     * more billed LLM call after cancellation was already decided. The durable
     * caller passes the DBOS cancellation check here; the default never fires,
     * keeping the pure loop free of any durability-runtime import.
     */
    readonly isFatalLoopError?: (err: unknown) => boolean;
}

/**
 * Drive one agent to a terminal reply. Returns the full message array —
 * the `initial` messages plus every assistant reply and tool-result
 * message appended over the loop — and the terminal `finish` signal.
 *
 * `max_tokens` is a recoverable soft-error, not a stop (see the harness-agent-loop spec): a
 * truncated trailing `tool_use` is refused (never executed) and fed back as
 * a retryable error, a truncated prose turn is steered and continued, and
 * the loop continues. Recovery is bounded by `maxIterations`.
 */
export async function runAgent(agent: AgentDefinition, initial: readonly LoopMessage[], session: AgentSession, opts: RunAgentOptions): Promise<RunAgentResult> {
    const { provider, signal, emit, runStep } = opts;
    const formatStepName = opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER;
    const isFatalLoopError = opts.isFatalLoopError ?? (() => false);
    const messages: LoopMessage[] = [...initial];

    // Provenance for every emitted event — the agent call chain at this
    // nesting level. Derived from the `Session`; nothing branches on it.
    const source: EventSource = {
        agentId: session.provenance.agentId ?? agent.id,
        callPath: session.provenance.callPath,
    };

    // The stable, cacheable request prefix: system block + tool defs.
    // Anthropic `cache_control` markers are cumulative — a marker on the
    // system block and on the LAST tool caches "system + every tool".
    const system: TextBlockParam[] = [
        {
            type: "text",
            text: agent.systemPrompt,
            cache_control: { type: "ephemeral" },
        },
    ];
    const toolDefs: AnthropicTool[] = agent.tools.map((tool, i) => ({
        name: tool.id,
        description: tool.description,
        input_schema: tool.jsonSchema as AnthropicTool["input_schema"],
        ...(i === agent.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    const toolsById = new Map<string, Tool>(agent.tools.map((t) => [t.id, t]));

    // Per-tool-call context. `ctx.runStep` namespaces a tool's own durable work
    // under the tool's step name, so the loop keeps the step-naming policy.
    const toolCtx = (tu: ToolUseBlock): ToolContext => ({
        session,
        signal,
        emit,
        runStep: (name, fn) => runStep(`${formatStepName.tool(tu.name, tu.id)}:${name}`, fn),
    });

    let iterations = 0;
    let truncationRecoveries = 0;

    for (let i = 0; i < agent.maxIterations; i++) {
        iterations = i + 1;
        const request: ChatRequest = {
            system,
            messages,
            tools: toolDefs,
        };
        const reply = await resultStep(runStep)(formatStepName.llm(i), () => provider.chat(request, session, signal));
        // Invariant 1: append the assistant content array verbatim.
        messages.push({ role: "assistant", content: reply.content });

        const toolUses = reply.content.filter((block): block is ToolUseBlock => block.type === "tool_use");

        // `max_tokens` is a recoverable soft-error (see the harness-agent-loop spec), not a stop. Only
        // the final content block can be truncated.
        if (reply.stop_reason === "max_tokens") {
            truncationRecoveries++;
            await emit({ type: "iteration", source, index: i, final: false });
            if (toolUses.length === 0) {
                // Truncated prose — steer and continue.
                messages.push({ role: "user", content: TRUNCATED_PROSE_STEER });
                continue;
            }
            // The trailing tool_use is truncated: refuse it (its input may be
            // silently incomplete), dispatch any earlier complete tool_uses, and
            // append all results in array order to keep the tool_use↔tool_result
            // invariant. Then continue.
            const trailing = toolUses[toolUses.length - 1]!;
            const earlier = toolUses.slice(0, -1);
            for (const tu of earlier) {
                await emit({ type: "tool-started", source, toolUseId: tu.id, name: tu.name, input: tu.input });
            }
            const results = await dispatchTools(earlier, toolsById, toolCtx, isFatalLoopError, runStep, formatStepName.tool);
            for (let idx = 0; idx < earlier.length; idx++) {
                const tu = earlier[idx]!;
                await emit({
                    type: "tool-finished",
                    source,
                    toolUseId: tu.id,
                    name: tu.name,
                    isError: results[idx]!.is_error === true,
                });
            }
            results.push(errorResult(trailing.id, TRUNCATED_TOOL_USE_ERROR));
            messages.push({ role: "user", content: results });
            continue;
        }

        if (reply.stop_reason !== "tool_use") {
            await emit({ type: "iteration", source, index: i, final: true });
            recordAgentRun({ agentId: agent.id, iterations, cappedOut: false });
            return {
                messages,
                finish: {
                    reason: reply.stop_reason ?? "end_turn",
                    cappedOut: false,
                    truncationRecoveries,
                },
            };
        }
        await emit({ type: "iteration", source, index: i, final: false });

        for (const tu of toolUses) {
            await emit({ type: "tool-started", source, toolUseId: tu.id, name: tu.name, input: tu.input });
        }

        const results = await dispatchTools(toolUses, toolsById, toolCtx, isFatalLoopError, runStep, formatStepName.tool);

        for (let idx = 0; idx < toolUses.length; idx++) {
            const tu = toolUses[idx]!;
            await emit({
                type: "tool-finished",
                source,
                toolUseId: tu.id,
                name: tu.name,
                isError: results[idx]!.is_error === true,
            });
        }
        // Invariant 2: one `user` message carrying every tool_result, directly
        // after the assistant `tool_use` message.
        messages.push({ role: "user", content: results });
    }

    // maxIterations exhausted. One tool-less call forces `stop_reason:
    // end_turn` — a real text answer instead of a thrown error.
    const wrapUp = await resultStep(runStep)(formatStepName.llm(agent.maxIterations), () => provider.chat({ system, messages, tools: [] }, session, signal));
    messages.push({ role: "assistant", content: wrapUp.content });
    await emit({ type: "iteration", source, index: agent.maxIterations, final: true });
    recordAgentRun({ agentId: agent.id, iterations, cappedOut: true });
    return {
        messages,
        finish: { reason: "max_iterations", cappedOut: true, truncationRecoveries },
    };
}

/**
 * Dispatch a turn's `tool_use` blocks to `tool_result`s, assembled by
 * original index so the ordering invariant (2 & 3) holds regardless of
 * execution order. Partitioned per the harness-tools spec: wrapped tools run concurrently
 * (each reserves one function-ID synchronously at `.map` time, keeping
 * parallel dispatch replay-deterministic); `bodyContext` tools run
 * sequentially and unwrapped in the workflow body so their internal `recv`
 * is legal (they reserve multiple function-IDs across awaits, so concurrent
 * ones would race the counter).
 */
async function dispatchTools(
    toolUses: readonly ToolUseBlock[],
    toolsById: Map<string, Tool>,
    toolCtx: (tu: ToolUseBlock) => ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
    runStep: RunStep,
    toolStepName: (toolName: string, toolUseId: string) => string,
): Promise<ToolResultBlockParam[]> {
    const results = new Array<ToolResultBlockParam>(toolUses.length);
    const wrapped: { tu: ToolUseBlock; idx: number }[] = [];
    const bodyCtx: { tu: ToolUseBlock; idx: number }[] = [];
    toolUses.forEach((tu, idx) => {
        const target = toolsById.get(tu.name)?.bodyContext === true ? bodyCtx : wrapped;
        target.push({ tu, idx });
    });

    await Promise.all(
        wrapped.map(({ tu, idx }) =>
            runStep(toolStepName(tu.name, tu.id), () => dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError)).then((r) => {
                results[idx] = r;
            }),
        ),
    );

    for (const { tu, idx } of bodyCtx) {
        results[idx] = await dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError);
    }

    return results;
}

/**
 * Run one `tool_use` block to a `tool_result`. The loop's error boundary and
 * the sole place a tool `Result` is unwrapped: a Zod-invalid input is rejected
 * before `execute` runs; an `ok` value becomes the result content; an `err`,
 * or a thrown failure caught here, becomes an `is_error` result the model can
 * read and react to — a tool failure never aborts the loop. A `bodyContext`
 * tool's workflow-lifecycle throw (cancellation) is re-raised via
 * `isFatalLoopError` rather than swallowed.
 */
async function dispatchTool(
    tu: ToolUseBlock,
    toolsById: Map<string, Tool>,
    ctx: ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
): Promise<ToolResultBlockParam> {
    const tool = toolsById.get(tu.name);
    if (tool === undefined) {
        return errorResult(tu.id, `unknown tool: ${tu.name}`);
    }

    const parsed = tool.inputSchema.safeParse(tu.input);
    if (!parsed.success) {
        return errorResult(tu.id, `input validation failed: ${formatZodIssues(parsed.error)}`);
    }

    try {
        const output = await tool.execute(parsed.data, ctx);
        if (output.isErr()) return errorResult(tu.id, toolErrorContent(output.error));
        return successResult(tu.id, output.value);
    } catch (err) {
        if (isFatalLoopError(err)) throw err;
        return errorResult(tu.id, toolErrorContent(err));
    }
}

function successResult(toolUseId: string, value: unknown): ToolResultBlockParam {
    return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: JSON.stringify(value ?? null),
    };
}

/**
 * The `{ error, retryable }` body of an `is_error` result, from either a
 * tool's `err(ToolError)` or a thrown failure. A `ToolError` is used verbatim;
 * anything else is classified by origin (`classifyProviderError` keys off the
 * `cause` chain — a billing 402, a transient 5xx, a connection drop).
 */
function toolErrorContent(value: unknown): string {
    if (isToolError(value)) {
        return JSON.stringify({ error: value.error, retryable: value.retryable });
    }
    const { retryable } = classifyProviderError(value);
    const error = value instanceof Error ? value.message : String(value);
    return JSON.stringify({ error, retryable });
}

function errorResult(toolUseId: string, content: string): ToolResultBlockParam {
    return {
        type: "tool_result",
        tool_use_id: toolUseId,
        is_error: true,
        content,
    };
}

/**
 * The concatenated text of the loop's final assistant message — the
 * "answer" a `runAgent` run produces. Used by loop-driving tools that
 * surface a sub-agent's report as their own result.
 */
export function finalText(messages: readonly LoopMessage[]): string {
    const last = messages.at(-1);
    if (last === undefined || last.role !== "assistant") return "";
    if (typeof last.content === "string") return last.content;
    return last.content
        .filter((block): block is { type: "text"; text: string } & typeof block => block.type === "text")
        .map((block) => block.text)
        .join("");
}

/** Flatten a Zod parse failure into one human-readable line. */
function formatZodIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `${path}: ${issue.message}`;
        })
        .join("; ");
}
