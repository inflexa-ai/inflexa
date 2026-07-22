import { jsonSchema, tool as aiTool, type FinishReason, type ToolSet, type ToolCallPart, type ToolResultPart, type ModelMessage } from "ai";
import type { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import { hintForZodIssue, repairToolInput } from "../lib/zod-issues.js";
import { markInterruptedMessage, syntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import { classifyProviderError } from "../providers/errors.js";
import { DEFAULT_PROMPT_CACHE, promptCacheProviderOptions } from "../providers/prompt-cache.js";
import { resultStep } from "./run-step.js";
import type { AgentChat, ChatRequest, PromptCachePolicy } from "../providers/types.js";
import { AskRejectedError, UnavailableAsk, type AskApproval, type AskRequest } from "../tools/approval/contract.js";
import { isToolError, type Tool, type ToolContext } from "../tools/define-tool.js";
import { addChatUsage, recordAgentRun, type AgentRunUsage } from "./metrics.js";
import type { AgentDefinition, EmitFn, EventSource, LoopMessage, RunStep } from "./types.js";

export interface AgentFinish {
    readonly reason: FinishReason | "aborted" | "max_iterations" | "denied";
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
    /**
     * Per-turn user-approval seam threaded into every tool's `ToolContext` as
     * `ctx.ask`. A conversation tool calls it to pause for an explicit user
     * decision; the caller (the turn) wires the realization that surfaces the
     * prompt and returns the reply. Omitted on non-interactive paths (workflow
     * contexts, headless embedders): approval then resolves to the shipped
     * deny-by-default `UnavailableAsk`, so a tool that asks where nothing can
     * answer is denied rather than left waiting on a surface that never responds.
     */
    readonly ask?: (request: AskRequest) => Promise<AskApproval>;
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

    // Approval resolves once to the caller's seam, or the deny-by-default one
    // when it wires none: a tool that pauses for a user decision where no
    // interactive surface is present is denied rather than left waiting on an
    // answer that cannot come.
    const unavailableAsk = new UnavailableAsk();
    const ask = opts.ask ?? ((request: AskRequest) => unavailableAsk.ask(request));
    const toolCtx = (tu: ToolCallPart): ToolContext => ({
        session,
        signal,
        emit,
        runStep: (name, fn) => runStep(`${formatStepName.tool(tu.toolName, tu.toolCallId)}:${name}`, fn),
        ask,
    });

    let iterations = 0;
    let truncationRecoveries = 0;

    // Resolved once, not per iteration: an identical options object across every
    // call is itself part of the cache contract — the request prefix has to be
    // byte-identical to be read back.
    const providerOptions = promptCacheProviderOptions(opts.promptCache ?? DEFAULT_PROMPT_CACHE);
    const usage: AgentRunUsage = {};

    // The user said no. A subsequent model call would only let the agent argue
    // with the decision, or spend a call acknowledging it; the denial tool result
    // is itself what the surface renders, so the turn ends the moment a denial
    // lands in a dispatch round — after the concurrent siblings in that same round
    // have completed and been appended. Mirrors the clean-stop terminal path.
    const stopOnDenial = async (i: number): Promise<RunAgentResult> => {
        await emit({ type: "iteration", source, index: i, final: true });
        recordAgentRun({ agentId: agent.id, iterations, cappedOut: false, usage });
        return { messages, finish: { reason: "denied", cappedOut: false, truncationRecoveries } };
    };

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

        if (reply.finishReason === "aborted") {
            // An interrupted turn keeps whatever the model produced before the cut, but
            // never an empty shell: a partial with no content adds no message, so a
            // no-output abort leaves the transcript at the initial prefix. The marker
            // then rides the last assistant message this run produced — the partial when
            // it has content, or the tool-calling step when the abort landed mid-dispatch
            // — an assistant role no turn-boundary reader observes. "aborted" is not
            // "tool-calls", so this falls into the terminal return below.
            if (assistantHasContent(reply.message)) messages.push(reply.message);
            markLastLoopAssistant(messages, initial.length);
        } else {
            messages.push(reply.message);
        }

        const toolCalls = toolCallParts(reply.message);
        if (reply.finishReason === "length") {
            truncationRecoveries++;
            await emit({ type: "iteration", source, index: i, final: false });
            if (toolCalls.length === 0) {
                // Stamped synthetic, not left as a bare `user` message: the wire format needs a user turn
                // after a truncated assistant message, but this one is the loop's own nudge, and thread
                // storage treats a genuine `user` message as the start of a conversation turn. Unmarked, it
                // would split this turn in two everywhere that boundary is read.
                messages.push(syntheticUserMessage(TRUNCATED_PROSE_STEER));
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
            if (hasDenial(results)) return stopOnDenial(i);
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
        if (hasDenial(results)) return stopOnDenial(i);
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

    if (wrapUp.finishReason === "aborted") {
        // An abort during the tool-less wrap-up is still the user cutting the turn — the
        // same event the in-loop path handles — so it gets the identical treatment: keep a
        // partial only when it carries content, and stamp the marker on the last assistant
        // this run produced. Reporting it as a plain cap-out would hide the interruption
        // from every downstream reader; `cappedOut` stays true because the loop genuinely
        // exhausted its iterations, while the reason carries the abort.
        if (assistantHasContent(wrapUp.message)) messages.push(wrapUp.message);
        markLastLoopAssistant(messages, initial.length);
        await emit({ type: "iteration", source, index: agent.maxIterations, final: true });
        recordAgentRun({ agentId: agent.id, iterations, cappedOut: true, usage });
        return { messages, finish: { reason: "aborted", cappedOut: true, truncationRecoveries } };
    }

    messages.push(wrapUp.message);
    await emit({ type: "iteration", source, index: agent.maxIterations, final: true });
    recordAgentRun({ agentId: agent.id, iterations, cappedOut: true, usage });
    return { messages, finish: { reason: "max_iterations", cappedOut: true, truncationRecoveries } };
}

function toolCallParts(message: Extract<ModelMessage, { role: "assistant" }>): ToolCallPart[] {
    if (typeof message.content === "string") return [];
    return message.content.filter((part): part is ToolCallPart => part.type === "tool-call");
}

/** Whether an aborted partial carries any content worth persisting — an empty partial contributes no message. */
function assistantHasContent(message: Extract<ModelMessage, { role: "assistant" }>): boolean {
    return message.content.length > 0;
}

/**
 * Stamp the interruption marker on the last assistant message the loop produced
 * this run — an index at or beyond the `initial` prefix — replacing the slot with
 * a marked copy so the mark rides into `appendTurn` and the stored row. When the
 * turn produced no assistant message beyond `initial` (a no-output abort on a
 * fresh turn), there is nothing to mark and the transcript is left untouched.
 */
function markLastLoopAssistant(messages: LoopMessage[], initialCount: number): void {
    for (let idx = messages.length - 1; idx >= initialCount; idx--) {
        const message = messages[idx]!;
        if (message.role === "assistant") {
            messages[idx] = markInterruptedMessage(message);
            return;
        }
    }
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
    if (parsed.success) return execute(tu, tool, parsed.data, ctx, isFatalLoopError);

    // A complete JSON argument can arrive as a string behind function-call
    // markup or a code fence. Repair only makes the schema reachable — the
    // repaired value is validated in full, and the tool's own semantic checks
    // still run, so nothing here weakens validation.
    const repairedInput = repairToolInput(tu.input, parsed.error);
    const repaired = repairedInput === undefined ? undefined : tool.inputSchema.safeParse(repairedInput);
    if (repaired?.success === true) return execute(tu, tool, repaired.data, ctx, isFatalLoopError);

    return errorResult(tu, `input validation failed: ${formatZodIssues(parsed.error, tu.input)}`);
}

async function execute(tu: ToolCallPart, tool: Tool, input: unknown, ctx: ToolContext, isFatalLoopError: (err: unknown) => boolean): Promise<ToolResultPart> {
    try {
        const output = await tool.execute(input, ctx);
        if (output.isErr()) return errorResult(tu, toolErrorContent(output.error));
        return successResult(tu, output.value);
    } catch (err) {
        if (isFatalLoopError(err)) throw err;
        if (isAskRejected(err)) return deniedResult(tu, err.feedback);
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

function isAskRejected(err: unknown): err is AskRejectedError {
    // Name-based fallback recognizes a rejection thrown from a different module
    // realm, where `instanceof` against this file's class reference would miss it.
    return err instanceof AskRejectedError || (err instanceof Error && err.name === "AskRejectedError");
}

/**
 * Map a rejected approval to a model-visible `execution-denied` tool result. The
 * prose is the model's only account of the denial; `isErrorOutput` already
 * treats `execution-denied` as an error result.
 */
function deniedResult(toolCall: ToolCallPart, feedback: string | undefined): ToolResultPart {
    const reason =
        feedback === undefined || feedback.length === 0
            ? "The user rejected this action."
            : `The user rejected this action with the following feedback: ${feedback}`;
    return {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: { type: "execution-denied", reason },
    };
}

function isErrorOutput(result: ToolResultPart): boolean {
    return result.output.type === "error-text" || result.output.type === "error-json" || result.output.type === "execution-denied";
}

function hasDenial(results: readonly ToolResultPart[]): boolean {
    return results.some((r) => r.output.type === "execution-denied");
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

function formatZodIssues(error: z.ZodError, input: unknown): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            const hint = hintForZodIssue(issue, input);
            return hint === undefined ? `${path}: ${issue.message}` : `${path}: ${issue.message} — ${hint}`;
        })
        .join("; ");
}
