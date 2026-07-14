import { jsonSchema, tool as aiTool, type FinishReason, type ToolSet, type ToolCallPart, type ToolResultPart, type ModelMessage } from "ai";
import type { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import { classifyProviderError } from "../providers/errors.js";
import { DEFAULT_PROMPT_CACHE, promptCacheProviderOptions } from "../providers/prompt-cache.js";
import { resultStep } from "./run-step.js";
import type { AgentChat, ChatRequest, PromptCachePolicy } from "../providers/types.js";
import { isToolError, type Tool, type ToolContext } from "../tools/define-tool.js";
import { addChatUsage, recordAgentRun, type AgentRunUsage } from "./metrics.js";
import type { AgentDefinition, EmitFn, EventSource, LoopMessage, RunStep } from "./types.js";

export interface AgentFinish {
    readonly reason: FinishReason | "max_iterations";
    readonly cappedOut: boolean;
    readonly truncationRecoveries: number;
}

export interface RunAgentResult {
    readonly messages: LoopMessage[];
    readonly finish: AgentFinish;
}

const TRUNCATED_PROSE_STEER = "Your previous reply was cut off at the output-token limit; continue concisely, or finish via your terminal tool.";

const TRUNCATED_TOOL_USE_ERROR =
    "Your previous tool call was cut off at the output-token limit and was not executed. Retry with a smaller payload, writing in incremental pieces.";

export interface StepNameFormatter {
    llm(iteration: number): string;
    tool(toolName: string, toolUseId: string): string;
}

export const DEFAULT_STEP_NAME_FORMATTER: StepNameFormatter = {
    llm: (i) => `llm-${i}`,
    tool: (name, id) => `tool-${name}-${id}`,
};

export interface RunAgentOptions {
    readonly provider: AgentChat;
    readonly signal: AbortSignal;
    readonly emit: EmitFn;
    readonly runStep: RunStep;
    readonly formatStepName?: StepNameFormatter;
    readonly isFatalLoopError?: (err: unknown) => boolean;
    /**
     * Prompt-cache policy for every LLM call this run makes. Defaults to
     * `DEFAULT_PROMPT_CACHE` (5m) — an agent loop always re-sends its prefix, so
     * it breaks even by the second iteration. A host whose endpoint ignores or
     * charges badly for cache directives passes `"off"`.
     *
     * The policy lives here, on the run, rather than on the provider, precisely
     * so it applies to loops and *not* to the one-shot LLM calls made elsewhere
     * (report generation, target-assessment steps): those would pay the
     * cache-write premium for a cache nothing ever reads back.
     */
    readonly promptCache?: PromptCachePolicy;
}

export async function runAgent(agent: AgentDefinition, initial: readonly LoopMessage[], session: AgentSession, opts: RunAgentOptions): Promise<RunAgentResult> {
    const { provider, signal, emit, runStep } = opts;
    const formatStepName = opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER;
    const isFatalLoopError = opts.isFatalLoopError ?? (() => false);
    if (agent.tools.length > 0 && !provider.capabilities.toolCalling) {
        throw new Error(`Provider/model cannot run tool-required agent "${agent.id}"`);
    }

    const messages: LoopMessage[] = [...initial];
    const source: EventSource = {
        agentId: session.provenance.agentId ?? agent.id,
        callPath: session.provenance.callPath,
    };
    const toolsById = new Map<string, Tool>(agent.tools.map((t) => [t.id, t]));
    const toolDefs: ToolSet = Object.fromEntries(
        agent.tools.map((t) => [
            t.id,
            aiTool({
                description: t.description,
                inputSchema: jsonSchema(t.jsonSchema),
            }),
        ]),
    );

    const toolCtx = (tu: ToolCallPart): ToolContext => ({
        session,
        signal,
        emit,
        runStep: (name, fn) => runStep(`${formatStepName.tool(tu.toolName, tu.toolCallId)}:${name}`, fn),
    });

    let iterations = 0;
    let truncationRecoveries = 0;

    // Resolved once, not per iteration: an identical options object across every
    // call is itself part of the cache contract — the request prefix has to be
    // byte-identical to be read back.
    const providerOptions = promptCacheProviderOptions(opts.promptCache ?? DEFAULT_PROMPT_CACHE);
    const usage: AgentRunUsage = {};

    for (let i = 0; i < agent.maxIterations; i++) {
        iterations = i + 1;
        const request: ChatRequest = {
            system: agent.systemPrompt,
            messages,
            tools: toolDefs,
            providerOptions,
        };
        const reply = await resultStep(runStep)(formatStepName.llm(i), () => provider.chat(request, session, signal));
        addChatUsage(usage, reply.usage);
        messages.push(reply.message);

        const toolCalls = toolCallParts(reply.message);
        if (reply.finishReason === "length") {
            truncationRecoveries++;
            await emit({ type: "iteration", source, index: i, final: false });
            if (toolCalls.length === 0) {
                messages.push({ role: "user", content: TRUNCATED_PROSE_STEER });
                continue;
            }
            const trailing = toolCalls[toolCalls.length - 1]!;
            const earlier = toolCalls.slice(0, -1);
            for (const tu of earlier) {
                await emit({ type: "tool-started", source, toolUseId: tu.toolCallId, name: tu.toolName, input: tu.input });
            }
            const results = await dispatchTools(earlier, toolsById, toolCtx, isFatalLoopError, runStep, formatStepName.tool);
            for (let idx = 0; idx < earlier.length; idx++) {
                const tu = earlier[idx]!;
                await emit({
                    type: "tool-finished",
                    source,
                    toolUseId: tu.toolCallId,
                    name: tu.toolName,
                    isError: isErrorOutput(results[idx]!),
                });
            }
            results.push(errorResult(trailing, TRUNCATED_TOOL_USE_ERROR));
            messages.push({ role: "tool", content: results });
            continue;
        }

        if (reply.finishReason !== "tool-calls") {
            await emit({ type: "iteration", source, index: i, final: true });
            recordAgentRun({ agentId: agent.id, iterations, cappedOut: false, usage });
            return { messages, finish: { reason: reply.finishReason, cappedOut: false, truncationRecoveries } };
        }

        await emit({ type: "iteration", source, index: i, final: false });
        for (const tu of toolCalls) {
            await emit({ type: "tool-started", source, toolUseId: tu.toolCallId, name: tu.toolName, input: tu.input });
        }
        const results = await dispatchTools(toolCalls, toolsById, toolCtx, isFatalLoopError, runStep, formatStepName.tool);
        for (let idx = 0; idx < toolCalls.length; idx++) {
            const tu = toolCalls[idx]!;
            await emit({
                type: "tool-finished",
                source,
                toolUseId: tu.toolCallId,
                name: tu.toolName,
                isError: isErrorOutput(results[idx]!),
            });
        }
        messages.push({ role: "tool", content: results });
    }

    // Cache defeater (known; not fixed here). Emptying the tool set changes the
    // very front of the request prefix — tool definitions are cached ahead of
    // system and history — so this call reads *nothing* back from the cache and
    // rewrites the whole prefix from scratch. It still carries the cache options
    // because it is the one call whose write is pure waste, and the
    // cache_write_tokens counter is what makes that waste visible.
    const wrapUp = await resultStep(runStep)(formatStepName.llm(agent.maxIterations), () =>
        provider.chat({ system: agent.systemPrompt, messages, tools: {}, toolChoice: "none", providerOptions }, session, signal),
    );
    addChatUsage(usage, wrapUp.usage);
    messages.push(wrapUp.message);
    await emit({ type: "iteration", source, index: agent.maxIterations, final: true });
    recordAgentRun({ agentId: agent.id, iterations, cappedOut: true, usage });
    return { messages, finish: { reason: "max_iterations", cappedOut: true, truncationRecoveries } };
}

function toolCallParts(message: Extract<ModelMessage, { role: "assistant" }>): ToolCallPart[] {
    if (typeof message.content === "string") return [];
    return message.content.filter((part): part is ToolCallPart => part.type === "tool-call");
}

async function dispatchTools(
    toolUses: readonly ToolCallPart[],
    toolsById: Map<string, Tool>,
    toolCtx: (tu: ToolCallPart) => ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
    runStep: RunStep,
    toolStepName: (toolName: string, toolUseId: string) => string,
): Promise<ToolResultPart[]> {
    const results = new Array<ToolResultPart>(toolUses.length);
    const stepTools: { tu: ToolCallPart; idx: number }[] = [];
    const workflowTools: { tu: ToolCallPart; idx: number }[] = [];
    const inlineTools: { tu: ToolCallPart; idx: number }[] = [];

    for (const [idx, tu] of toolUses.entries()) {
        const mode = toolsById.get(tu.toolName)?.executionMode ?? "step";
        if (mode === "workflow") workflowTools.push({ tu, idx });
        else if (mode === "inline") inlineTools.push({ tu, idx });
        else stepTools.push({ tu, idx });
    }

    await Promise.all(
        stepTools.map(({ tu, idx }) =>
            runStep(toolStepName(tu.toolName, tu.toolCallId), () => dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError)).then((r) => {
                results[idx] = r;
            }),
        ),
    );

    for (const { tu, idx } of workflowTools) {
        results[idx] = await dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError);
    }
    for (const { tu, idx } of inlineTools) {
        results[idx] = await dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError);
    }

    return results;
}

async function dispatchTool(
    tu: ToolCallPart,
    toolsById: Map<string, Tool>,
    ctx: ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
): Promise<ToolResultPart> {
    const tool = toolsById.get(tu.toolName);
    if (tool === undefined) {
        return errorResult(tu, `unknown tool: ${tu.toolName}`);
    }

    const parsed = tool.inputSchema.safeParse(tu.input);
    if (!parsed.success) {
        return errorResult(tu, `input validation failed: ${formatZodIssues(parsed.error)}`);
    }

    try {
        const output = await tool.execute(parsed.data, ctx);
        if (output.isErr()) return errorResult(tu, toolErrorContent(output.error));
        return successResult(tu, output.value);
    } catch (err) {
        if (isFatalLoopError(err)) throw err;
        return errorResult(tu, toolErrorContent(err));
    }
}

function jsonValue(value: unknown) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function successResult(toolCall: ToolCallPart, value: unknown): ToolResultPart {
    return {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: { type: "json", value: jsonValue(value) },
    };
}

function toolErrorContent(value: unknown): string {
    if (isToolError(value)) {
        return JSON.stringify({ error: value.error, retryable: value.retryable });
    }
    const { retryable } = classifyProviderError(value);
    const error = value instanceof Error ? value.message : String(value);
    return JSON.stringify({ error, retryable });
}

function errorResult(toolCall: ToolCallPart, content: string): ToolResultPart {
    return {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: { type: "error-text", value: content },
    };
}

function isErrorOutput(result: ToolResultPart): boolean {
    return result.output.type === "error-text" || result.output.type === "error-json" || result.output.type === "execution-denied";
}

export function finalText(messages: readonly LoopMessage[]): string {
    const last = messages.at(-1);
    if (last === undefined || last.role !== "assistant") return "";
    if (typeof last.content === "string") return last.content;
    return last.content
        .filter((block): block is { type: "text"; text: string } & typeof block => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function formatZodIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `${path}: ${issue.message}`;
        })
        .join("; ");
}
