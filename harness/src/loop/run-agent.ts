import { randomUUID } from "node:crypto";

import {
    jsonSchema,
    tool as aiTool,
    type FilePart,
    type FinishReason,
    type ToolSet,
    type TextPart,
    type ToolCallPart,
    type ToolResultPart,
    type ModelMessage,
} from "ai";
import type { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import { createNoopUsageRecorder } from "../billing/noop-usage-recorder.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import { stripNulCharacters } from "../input-sanitization.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { hintForZodIssue, repairToolInput } from "../lib/zod-issues.js";
import { markInterruptedMessage, syntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import { classifyProviderError } from "../providers/errors.js";
import { DEFAULT_PROMPT_CACHE, promptCacheProviderOptions } from "../providers/prompt-cache.js";
import { resultStep } from "./run-step.js";
import type { AgentChat, ChatRequest, ChatResponse, PromptCachePolicy, ProviderCapabilities } from "../providers/types.js";
import { AskRejectedError, UnavailableAsk, type AskApproval, type AskRequest } from "../tools/approval/contract.js";
import { isToolError, readToolResultImage, type Tool, type ToolContext, type ToolResultImage } from "../tools/define-tool.js";
import { addChatUsage, hasReportedUsage, recordAgentRun, type AgentRunUsage } from "./metrics.js";
import { computeDetail, type ToolCallDetail } from "./tool-detail.js";
import { toolOutcomeForOutputType, type ToolOutcome } from "./tool-outcome.js";
import type { AgentDefinition, EmitFn, EventSource, LoopMessage, RunStep } from "./types.js";

export interface AgentFinish {
    readonly reason: FinishReason | "aborted" | "max_iterations" | "denied";
    readonly cappedOut: boolean;
    readonly truncationRecoveries: number;
    /**
     * What this loop's own LLM calls reported, the forced wrap-up included.
     * Absent when no call reported anything — never an all-zero figure.
     */
    readonly usage?: AgentRunUsage;
    /**
     * The whole turn's total, every descendant loop included. Present only on
     * the loop that created the turn accumulator — the run whose options
     * carried none, which is by construction the turn's root.
     */
    readonly turnUsage?: AgentRunUsage;
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
    /** Tool-selection policy for in-loop model calls. The cap wrap-up remains
     * tool-less regardless. */
    readonly toolChoice?: ChatRequest["toolChoice"];
    /**
     * Optional outcome predicate for loop-driving agents whose result is
     * recorded by a tool into closure state. Checked immediately after each
     * dispatch round, once every sibling tool result has been appended.
     */
    readonly resolved?: () => boolean;
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
    /**
     * Diagnostic sink for the run's own lifecycle. Optional because `runAgent` is
     * called from tools, workflow bodies, and test rigs alike — silence is the
     * correct behaviour for a caller that wires nothing, and the noop fallback
     * gives it without every call site threading `?.`.
     *
     * Distinct from `emit`, which feeds a user-facing surface: every host filters
     * sub-agent events off that surface by `callPath` depth, so a sub-agent's
     * progress is emitted and then dropped. This is where it survives.
     */
    readonly logger?: Logger;
    /**
     * Per-call LLM usage-accounting seam. Omitted falls back to the no-op
     * recorder. Delivery is fire-and-forget by contract — the loop neither
     * awaits `record` nor guards it, so a realization must not throw or block.
     */
    readonly usageRecorder?: UsageRecorder;
    /**
     * The turn's usage accumulator, supplied by whatever ran this loop as part
     * of a larger turn (a sub-agent-running tool passes `ctx.turnUsage`). A run
     * that receives none creates its own and is therefore the turn's root: it
     * alone reports `turnUsage` on its finish.
     */
    readonly turnUsage?: AgentRunUsage;
    /**
     * The id of the tool call this loop runs inside, supplied by a
     * sub-agent-running tool from its `ctx.invocationId`. It is what separates
     * two dispatches of the *same* sub-agent in one round — they share the run
     * frame, the call path, and every loop-local step name — in the usage
     * record key. Absent for a loop that is not nested inside a tool dispatch
     * (a chat turn's root, a workflow step body, a background task).
     */
    readonly invocationId?: string;
}

export async function runAgent(agent: AgentDefinition, initial: readonly LoopMessage[], session: AgentSession, opts: RunAgentOptions): Promise<RunAgentResult> {
    const { provider, signal, emit, runStep } = opts;
    const formatStepName = opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER;
    const configuredFatalLoopError = opts.isFatalLoopError ?? (() => false);
    // AbortError is control flow, not a tool failure. Always compose it with the
    // host's fatal predicate so request cancellation cannot be converted into a
    // model-visible error result and retried by the loop.
    const isFatalLoopError = (err: unknown): boolean =>
        ((err instanceof Error || err instanceof DOMException) && err.name === "AbortError") || configuredFatalLoopError(err);
    if (agent.tools.length > 0 && !provider.capabilities.toolCalling) {
        throw new Error(`Provider/model cannot run tool-required agent "${agent.id}"`);
    }

    const messages: LoopMessage[] = [...initial];
    const source: EventSource = {
        agentId: session.provenance.agentId ?? agent.id,
        callPath: session.provenance.callPath,
    };
    // Bound from the same `source` the emitted events carry: one derivation feeding
    // both sinks, so a record and an event cannot disagree about who produced them.
    // `callPath` rides as an array rather than a joined string — the queryable form;
    // rendering `parent > child` is the sink's choice, not a published package's.
    const log = (opts.logger ?? createNoopLogger()).named("loop").with({ agentId: source.agentId, callPath: source.callPath });
    // The picture of a tool result rides where the wire renders it. Absent flags
    // mean "cannot carry", thus the loop degrades to text and records the drop.
    // The collector belongs to this run, thus two loops never share one.
    const encoding: ResultEncoding = { placement: imagePlacementFor(provider.capabilities), deferredImages: [], log };
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

    // A run handed no accumulator is the turn's root: it creates the one every
    // descendant loop folds into, and it is the only loop entitled to report a
    // turn total. Descendants receive the root's object and mutate it in place.
    const turnUsage: AgentRunUsage = opts.turnUsage ?? {};
    const isTurnRoot = opts.turnUsage === undefined;

    const toolCtx = (tu: ToolCallPart): ToolContext => ({
        invocationId: tu.toolCallId,
        session,
        signal,
        emit,
        runStep: (name, fn) => runStep(`${formatStepName.tool(tu.toolName, tu.toolCallId)}:${name}`, fn),
        ask,
        turnUsage,
    });

    let iterations = 0;
    let truncationRecoveries = 0;
    // Counted rather than listed: the finish record stays one bounded line for a run of
    // any length, and "50 iterations, 49 tool calls, 47 of them errored" already separates
    // a productive long run from a loop stuck retrying one failing call. The per-iteration
    // `debug` records name the tools when that distinction is not enough.
    let toolCallCount = 0;
    let toolErrorCount = 0;

    // Resolved once, not per iteration: an identical options object across every
    // call is itself part of the cache contract — the request prefix has to be
    // byte-identical to be read back.
    const providerOptions = promptCacheProviderOptions(opts.promptCache ?? DEFAULT_PROMPT_CACHE);
    const usage: AgentRunUsage = {};

    // Exactly one record per completed run — never one per iteration. That bound is
    // what keeps the default level affordable for an agent that runs long; the
    // per-iteration detail lives at `debug`, where paying per iteration is the point.
    const logFinish = (level: "info" | "warn", reason: AgentFinish["reason"], cappedOut: boolean): void => {
        log[level]("run finished", { iterations, reason, cappedOut, truncationRecoveries, toolCalls: toolCallCount, toolErrors: toolErrorCount, usage });
    };

    const usageRecorder = opts.usageRecorder ?? createNoopUsageRecorder();

    /**
     * Fold one completed call into both rollups and hand it to the recorder.
     * Called at the fold point, with the reply in hand — before any branch that
     * can end the run — so a call that completed is accounted for even when the
     * run later aborts or dies.
     *
     * A call that reported nothing produces no record. Model ids are identity,
     * not usage: a reply carrying only `requestedModelId`/`servedModelId` still
     * reported nothing to account for, so it is folded (to no effect) and left
     * out of the ledger rather than entered as an all-absent record.
     *
     * Delivery is bare — no `await`, no `try` — because the `UsageRecorder`
     * contract forbids `record` to throw or block.
     */
    const accountForCall = (reply: ChatResponse, stepName: string): void => {
        addChatUsage(usage, reply.usage);
        addChatUsage(turnUsage, reply.usage);

        const reported = reply.usage;
        if (reported === undefined || !hasReportedUsage(reported)) return;
        usageRecorder.record({
            recordKey: recordKeyFor(session, opts.invocationId, stepName),
            agentId: source.agentId,
            callPath: source.callPath,
            scope: session.scope,
            ...(session.runFrame?.runId === undefined ? {} : { runId: session.runFrame.runId }),
            ...(session.runFrame?.stepId === undefined ? {} : { stepId: session.runFrame.stepId }),
            ...(reply.requestedModelId === undefined ? {} : { requestedModelId: reply.requestedModelId }),
            ...(reply.servedModelId === undefined ? {} : { servedModelId: reply.servedModelId }),
            usage: reported,
        });
    };

    /** The rollups this loop stamps on its finish — each absent when nothing reported. */
    const finishUsage = (): Pick<AgentFinish, "usage" | "turnUsage"> => ({
        ...(hasReportedUsage(usage) ? { usage: { ...usage } } : {}),
        ...(isTurnRoot && hasReportedUsage(turnUsage) ? { turnUsage: { ...turnUsage } } : {}),
    });

    // The user said no. A subsequent model call would only let the agent argue
    // with the decision, or spend a call acknowledging it; the denial tool result
    // is itself what the surface renders, so the turn ends the moment a denial
    // lands in a dispatch round — after the concurrent siblings in that same round
    // have completed and been appended. Mirrors the clean-stop terminal path.
    const stopOnDenial = async (i: number): Promise<RunAgentResult> => {
        await emit({ type: "iteration", source, index: i, final: true });
        recordAgentRun({ agentId: agent.id, iterations, cappedOut: false, usage });
        logFinish("warn", "denied", false);
        return { messages, finish: { reason: "denied", cappedOut: false, truncationRecoveries, ...finishUsage() } };
    };
    /**
     * The call details for one dispatch round, positionally aligned with `calls`.
     *
     * Computed once per round and carried onto both the `tool-started` and the
     * `tool-finished` event, so the pair a host renders as one chip cannot show
     * two different descriptions of the same call.
     */
    const roundDetails = (calls: readonly ToolCallPart[]): (ToolCallDetail | undefined)[] =>
        calls.map((tu) => {
            const tool = toolsById.get(tu.toolName);
            return tool === undefined ? undefined : computeDetail(tool, tu.input, log);
        });

    /**
     * Fold one dispatch round into the run's counters and the event sink, returning the
     * tools whose results the model will read as errors.
     *
     * Shared by both dispatch paths so a truncated round and a normal one cannot drift
     * in what they count. An error tool result is otherwise invisible to every sink —
     * it is not a thrown failure, so nothing reports it and the loop simply feeds it
     * back — and a run that ends badly is usually a run whose tool calls were failing.
     *
     * `details` and `durations` are positionally aligned with `calls`. `dispatchTools`
     * measures a duration around the call itself, because this sink emits every finish
     * event only after the whole round settles.
     */
    const settleRound = async (
        calls: readonly ToolCallPart[],
        results: readonly ToolResultPart[],
        details: readonly (ToolCallDetail | undefined)[],
        durations: readonly (number | undefined)[],
    ): Promise<string[]> => {
        const errored: string[] = [];
        for (let idx = 0; idx < calls.length; idx++) {
            const tu = calls[idx]!;
            const outcome = outcomeOf(results[idx]!);
            toolCallCount++;
            // A denial counts here with the errors: the model reads it as a result
            // it did not get to act on, which is what these counters describe. The
            // event keeps the two apart for the user-facing surface.
            if (outcome !== "ok") {
                toolErrorCount++;
                errored.push(tu.toolName);
            }
            await emit({
                type: "tool-finished",
                source,
                toolUseId: tu.toolCallId,
                name: tu.toolName,
                outcome,
                ...detailField(details[idx]),
                ...durationField(durations[idx]),
            });
        }
        return errored;
    };

    const stopOnResolved = async (i: number): Promise<RunAgentResult> => {
        await emit({ type: "iteration", source, index: i, final: true });
        recordAgentRun({ agentId: agent.id, iterations, cappedOut: false, usage });
        return { messages, finish: { reason: "stop", cappedOut: false, truncationRecoveries } };
    };

    for (let i = 0; i < agent.maxIterations; i++) {
        iterations = i + 1;
        const request: ChatRequest = {
            system: agent.systemPrompt,
            messages,
            tools: toolDefs,
            ...(opts.toolChoice !== undefined ? { toolChoice: opts.toolChoice } : {}),
            providerOptions,
        };
        const llmStepName = formatStepName.llm(i);
        const reply = await resultStep(runStep)(llmStepName, () => provider.chat(request, session, signal));
        accountForCall(reply, llmStepName);

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
            // `tools` is what the model asked for; the trailing call was cut off at the
            // output limit and is never dispatched, which the distinct message records.
            log.debug("iteration truncated at output limit", { iteration: i, tools: toolCalls.map((t) => t.toolName), truncationRecoveries });
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
            const earlierDetails = roundDetails(earlier);
            for (const [idx, tu] of earlier.entries()) {
                await emit({ type: "tool-started", source, toolUseId: tu.toolCallId, name: tu.toolName, input: tu.input, ...detailField(earlierDetails[idx]) });
            }
            const { results, durations } = await dispatchTools(earlier, toolsById, toolCtx, isFatalLoopError, runStep, formatStepName.tool, encoding);
            const errored = await settleRound(earlier, results, earlierDetails, durations);
            results.push(errorResult(trailing, TRUNCATED_TOOL_USE_ERROR));
            // The trailing call was never dispatched, but it reaches the model as an error
            // result like any other — so it counts, or `toolErrors` reports a cleaner run
            // than the model actually read. It gets no `tool-finished` event: no
            // `tool-started` was emitted for it either, and the pair must stay balanced.
            toolCallCount++;
            toolErrorCount++;
            errored.push(trailing.toolName);
            log.debug("tool results returned errors", { iteration: i, tools: errored });
            messages.push({ role: "tool", content: results });
            appendDeferredImages(messages, results, encoding.deferredImages);
            if (hasDenial(results)) return stopOnDenial(i);
            if (opts.resolved?.()) return stopOnResolved(i);
            continue;
        }

        if (reply.finishReason !== "tool-calls") {
            await emit({ type: "iteration", source, index: i, final: true });
            recordAgentRun({ agentId: agent.id, iterations, cappedOut: false, usage });
            logFinish("info", reply.finishReason, false);
            return { messages, finish: { reason: reply.finishReason, cappedOut: false, truncationRecoveries, ...finishUsage() } };
        }

        await emit({ type: "iteration", source, index: i, final: false });
        log.debug("iteration", { iteration: i, tools: toolCalls.map((t) => t.toolName) });
        const details = roundDetails(toolCalls);
        for (const [idx, tu] of toolCalls.entries()) {
            await emit({ type: "tool-started", source, toolUseId: tu.toolCallId, name: tu.toolName, input: tu.input, ...detailField(details[idx]) });
        }
        const { results, durations } = await dispatchTools(toolCalls, toolsById, toolCtx, isFatalLoopError, runStep, formatStepName.tool, encoding);
        const errored = await settleRound(toolCalls, results, details, durations);
        if (errored.length > 0) log.debug("tool results returned errors", { iteration: i, tools: errored });
        messages.push({ role: "tool", content: results });
        appendDeferredImages(messages, results, encoding.deferredImages);
        if (hasDenial(results)) return stopOnDenial(i);
        if (opts.resolved?.()) return stopOnResolved(i);
    }

    // Cache defeater (known; not fixed here). Emptying the tool set changes the
    // very front of the request prefix — tool definitions are cached ahead of
    // system and history — so this call reads *nothing* back from the cache and
    // rewrites the whole prefix from scratch. It still carries the cache options
    // because it is the one call whose write is pure waste, and the
    // cache_write_tokens counter is what makes that waste visible.
    const wrapUpStepName = formatStepName.llm(agent.maxIterations);
    const wrapUp = await resultStep(runStep)(wrapUpStepName, () =>
        provider.chat({ system: agent.systemPrompt, messages, tools: {}, toolChoice: "none", providerOptions }, session, signal),
    );
    accountForCall(wrapUp, wrapUpStepName);

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
        logFinish("warn", "aborted", true);
        return { messages, finish: { reason: "aborted", cappedOut: true, truncationRecoveries, ...finishUsage() } };
    }

    messages.push(wrapUp.message);
    await emit({ type: "iteration", source, index: agent.maxIterations, final: true });
    recordAgentRun({ agentId: agent.id, iterations, cappedOut: true, usage });
    logFinish("warn", "max_iterations", true);
    return { messages, finish: { reason: "max_iterations", cappedOut: true, truncationRecoveries, ...finishUsage() } };
}

/**
 * Delimiter joining the call path into one key segment.
 *
 * Deliberately not the `:` that separates the key's segments, so a call path
 * can never be read as one: agent ids are kebab-case identifiers, run ids are
 * UUIDs or the profiler's `data-profile` literal, step ids are path-safe plan
 * ids (`T1S1`, `synthesis`, `profile`), tool-call ids are provider-issued
 * opaque tokens, and the loop's step names are `llm-{n}` / `tool-{name}-{id}`
 * with an optional `salvage:` prefix — none of them can contain `>`.
 */
const CALL_PATH_DELIMITER = ">";

/**
 * Idempotency key for one call's usage record:
 * `{runId}[:{stepId}]:{callPath}[:{invocationId}]:{stepName}`.
 *
 * Every component is a fact the same call carries again on every replay, so a
 * re-executed body re-fires `record` with the byte-identical key and an
 * upserting sink counts the call once. Each earns its place by a collision it
 * alone resolves:
 *
 * - `stepId` — `executeAnalysis` runs one child workflow per step under a
 *   single shared `runId`, and each step's loop names its first call `llm-0`.
 * - `callPath` — a step name is unique only within ONE loop invocation (every
 *   `runAgent` restarts its names at `llm-0`), and several loops routinely run
 *   under one frame: a step's post-step describer and its summary writer share
 *   `{runId, stepId}`, and the run-synthesis loop shares a bare `{runId}` with
 *   the sub-agents its tools run. The provenance path is what separates those
 *   agent chains.
 * - `invocationId` — the same sub-agent dispatched twice in one round has an
 *   identical call path, so only the dispatching tool-call id tells the two
 *   child loops apart. It is replay-stable by the harness-tools contract: a
 *   redelivered call carries the id it was issued under.
 * - `stepName` — the loop's own deterministic name, reused rather than
 *   re-derived. Minting a second *naming* scheme here would create two things
 *   that must agree about what "the same call" is, and they would drift.
 *
 * Outside a `RunFrame` there is no replay to be safe against (the HTTP chat
 * path runs a call exactly once), so a fresh id is enough and is what keeps two
 * calls in one turn distinct.
 */
function recordKeyFor(session: AgentSession, invocationId: string | undefined, stepName: string): string {
    const frame = session.runFrame;
    if (frame === undefined) return randomUUID();
    return [
        frame.runId,
        ...(frame.stepId === undefined ? [] : [frame.stepId]),
        session.provenance.callPath.join(CALL_PATH_DELIMITER),
        ...(invocationId === undefined ? [] : [invocationId]),
        stepName,
    ].join(":");
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

/** Where the picture of a tool result goes on the wire. */
type ImagePlacement = "tool-result" | "user-message" | "drop";

/**
 * Where a tool picture goes for this wire. The tool result wins, because it is
 * the native place and the correlation to the tool call stays implicit. The user
 * message is the fallback. When the wire renders neither, the loop drops the
 * picture.
 */
function imagePlacementFor(capabilities: ProviderCapabilities): ImagePlacement {
    if (capabilities.imageToolResults === true) return "tool-result";
    if (capabilities.imageUserMessages === true) return "user-message";
    return "drop";
}

/** A picture that a tool result cannot carry, with the tool call that produced it. */
interface DeferredImage {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly image: ToolResultImage;
}

/**
 * How a completed tool result is encoded onto the provider message. `placement`
 * says where the picture of a tool result goes, and `log` is the sink for the drop
 * record. `deferredImages` collects the picture of each tool result of the round
 * under the user-message placement, and the round assembly empties it.
 *
 * CAUTION: the collector fills as a side effect inside the tool step body. A
 * replayed durable step returns its cached result, and it does not run the body.
 * Thus a recovered run omits the fallback picture of a replayed round.
 *
 * TODO(define): the hole is latent, because no durable agent wires an image
 * tool today. The structural fix moves the picture into the cached step
 * return, and a replay then rebuilds the same fallback message. That fix
 * changes the contract of the durable step and the specs, thus it waits for
 * its own change.
 */
interface ResultEncoding {
    readonly placement: ImagePlacement;
    readonly log: Logger;
    readonly deferredImages: DeferredImage[];
}

/**
 * Append one user message that carries each deferred picture of the round, then
 * empty the collector.
 *
 * The tool message must come directly after the assistant message with the
 * tool calls. Thus a picture rides a separate message after the whole tool
 * message, and one message batches the round. The parts obey the order of
 * `results`, which is the order of the tool calls. Each deferred picture has a
 * result of this round, because the collector fills during the dispatch and it
 * empties here. A text part names the tool call of each picture, because the wire
 * holds no structural link between a user message and a tool call.
 *
 * The message carries the synthetic marker, because a `user` message opens a
 * conversation turn. An unmarked one is loop machinery that reads as a turn
 * boundary, and it splits one stored turn in two.
 */
function appendDeferredImages(messages: LoopMessage[], results: readonly ToolResultPart[], deferredImages: DeferredImage[]): void {
    if (deferredImages.length === 0) return;
    const byToolCallId = new Map(deferredImages.map((deferred) => [deferred.toolCallId, deferred]));
    const content: (TextPart | FilePart)[] = [];
    for (const result of results) {
        const deferred = byToolCallId.get(result.toolCallId);
        if (deferred === undefined) continue;
        content.push({ type: "text", text: `The picture of the tool result ${deferred.toolCallId} of ${deferred.toolName}.` });
        content.push({ type: "file", mediaType: deferred.image.mediaType, data: { type: "data", data: deferred.image.base64 } });
    }
    messages.push(syntheticUserMessage(content));
    deferredImages.length = 0;
}

/**
 * Dispatch one round of tool calls, and measure the time of each call.
 *
 * `results` and `durations` are positionally aligned with `toolUses`.
 *
 * Each measurement brackets the same unit that the loop awaits for that call. For a
 * step-mode call that unit is `runStep`, thus the figure includes the durable-step
 * wrapper. The wrapper is part of what the call cost, and a cached replay of a step
 * is genuinely fast. A bracket inside the step would report a body that did not run.
 */
async function dispatchTools(
    toolUses: readonly ToolCallPart[],
    toolsById: Map<string, Tool>,
    toolCtx: (tu: ToolCallPart) => ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
    runStep: RunStep,
    toolStepName: (toolName: string, toolUseId: string) => string,
    encoding: ResultEncoding,
): Promise<{ results: ToolResultPart[]; durations: (number | undefined)[] }> {
    const results = new Array<ToolResultPart>(toolUses.length);
    // The array starts with holes, which read as `undefined`. The element type
    // says so, thus it agrees with what `settleRound` accepts. Every index is in
    // fact assigned, because the mode partition below covers each call.
    const durations = new Array<number | undefined>(toolUses.length);
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
        stepTools.map(({ tu, idx }) => {
            const startedAt = performance.now();
            return runStep(toolStepName(tu.toolName, tu.toolCallId), () => dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError, encoding)).then((r) => {
                durations[idx] = elapsedMs(startedAt);
                results[idx] = r;
            });
        }),
    );

    for (const { tu, idx } of workflowTools) {
        const startedAt = performance.now();
        results[idx] = await dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError, encoding);
        durations[idx] = elapsedMs(startedAt);
    }
    for (const { tu, idx } of inlineTools) {
        const startedAt = performance.now();
        results[idx] = await dispatchTool(tu, toolsById, toolCtx(tu), isFatalLoopError, encoding);
        durations[idx] = elapsedMs(startedAt);
    }

    return { results, durations };
}

/** Whole milliseconds since `startedAt`, on the monotonic clock that took that mark. */
function elapsedMs(startedAt: number): number {
    return Math.round(performance.now() - startedAt);
}

async function dispatchTool(
    tu: ToolCallPart,
    toolsById: Map<string, Tool>,
    ctx: ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
    encoding: ResultEncoding,
): Promise<ToolResultPart> {
    const tool = toolsById.get(tu.toolName);
    if (tool === undefined) {
        return errorResult(tu, `unknown tool: ${tu.toolName}`);
    }

    const parsed = tool.inputSchema.safeParse(tu.input);
    if (parsed.success) return execute(tu, tool, parsed.data, ctx, isFatalLoopError, encoding);

    // A complete JSON argument can arrive as a string behind function-call
    // markup or a code fence. Repair only makes the schema reachable — the
    // repaired value is validated in full, and the tool's own semantic checks
    // still run, so nothing here weakens validation.
    const repairedInput = repairToolInput(tu.input, parsed.error);
    const repaired = repairedInput === undefined ? undefined : tool.inputSchema.safeParse(repairedInput);
    if (repaired?.success === true) return execute(tu, tool, repaired.data, ctx, isFatalLoopError, encoding);

    return errorResult(tu, `input validation failed: ${formatZodIssues(parsed.error, tu.input)}`);
}

async function execute(
    tu: ToolCallPart,
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    isFatalLoopError: (err: unknown) => boolean,
    encoding: ResultEncoding,
): Promise<ToolResultPart> {
    try {
        const output = await tool.execute(input, ctx);
        if (output.isErr()) return errorResult(tu, toolErrorContent(output.error));
        return successResult(tu, output.value, encoding);
    } catch (err) {
        if (isFatalLoopError(err)) throw err;
        if (isAskRejected(err)) return deniedResult(tu, err.feedback);
        return errorResult(tu, toolErrorContent(err));
    }
}

/**
 * Normalize a tool's return value to plain JSON, stripping NUL from every string
 * it holds ({@link stripNulCharacters}). The reviver sees values, not keys — a
 * NUL in an object KEY would still reach the row, but keys come from tool result
 * types rather than scanned bytes, so nothing produces one.
 */
function jsonValue(value: unknown) {
    return JSON.parse(JSON.stringify(value ?? null), (_key, v: unknown) => (typeof v === "string" ? stripNulCharacters(v) : v));
}

/**
 * Encode a tool ok value onto a tool-result message. A value with no picture
 * stays a plain JSON result, byte-identical to a value that never carried one.
 *
 * A value that carries a picture splits: the JSON data goes to a text part, and
 * the bytes ride as an image content block. Thus the model sees the picture, and
 * the JSON text holds no bytes. When the wire carries no picture, the block drops
 * and the text stays, because base64 text floods the context and the model cannot
 * see it. The drop rides the log, thus an operator sees that the picture did not
 * reach the model.
 *
 * A wire that renders a picture on a user message only gets the fallback: the
 * result keeps its JSON text, and the picture goes to the collector of the round.
 * The round then sends the bytes after the tool message.
 */
function successResult(toolCall: ToolCallPart, value: unknown, encoding: ResultEncoding): ToolResultPart {
    const jsonData = jsonValue(value);
    const jsonOnly: ToolResultPart = {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: { type: "json", value: jsonData },
    };
    const image = readToolResultImage(value);
    if (image === undefined) return jsonOnly;
    if (encoding.placement === "drop") {
        encoding.log.warn("the wired provider carries no picture in a tool result, thus the picture is dropped", { toolName: toolCall.toolName });
        return jsonOnly;
    }
    if (encoding.placement === "user-message") {
        encoding.deferredImages.push({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, image });
        return jsonOnly;
    }
    return {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: {
            type: "content",
            value: [
                { type: "text", text: JSON.stringify(jsonData) },
                { type: "file", mediaType: image.mediaType, data: { type: "data", data: image.base64 } },
            ],
        },
    };
}

// NUL is stripped from the prose BEFORE it is serialized: past the stringify it
// is the six-character escape \u0000 — legitimate JSON text, and no longer
// distinguishable from an error that happens to quote that escape.
function toolErrorContent(value: unknown): string {
    if (isToolError(value)) {
        return JSON.stringify({ error: stripNulCharacters(value.error), retryable: value.retryable });
    }
    const { retryable } = classifyProviderError(value);
    const error = stripNulCharacters(value instanceof Error ? value.message : String(value));
    return JSON.stringify({ error, retryable });
}

function errorResult(toolCall: ToolCallPart, content: string): ToolResultPart {
    return {
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        // A thrown tool error routinely quotes stderr verbatim — as exposed to NUL as a success payload.
        output: { type: "error-text", value: stripNulCharacters(content) },
    };
}

function isAskRejected(err: unknown): err is AskRejectedError {
    // Name-based fallback recognizes a rejection thrown from a different module
    // realm, where `instanceof` against this file's class reference would miss it.
    return err instanceof AskRejectedError || (err instanceof Error && err.name === "AskRejectedError");
}

/**
 * Map a rejected approval to a model-visible `execution-denied` tool result. The
 * prose is the model's only account of the denial; `outcomeOf` reports it as
 * `denied`, distinct from a fault.
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

function outcomeOf(result: ToolResultPart): ToolOutcome {
    return toolOutcomeForOutputType(result.output.type);
}

/**
 * The optional `detail` field, present only when there is one. Spread rather
 * than assigned so an undescribed call emits an event with no `detail` key at
 * all, which is what the contract promises: absent, never empty.
 */
function detailField(detail: ToolCallDetail | undefined): { detail?: ToolCallDetail } {
    return detail === undefined ? {} : { detail };
}

/**
 * The optional `durationMs` field, present only for a call that the loop measured.
 *
 * Spread rather than assigned, for the same reason as {@link detailField}: an
 * unmeasured call emits no `durationMs` key. A zero here is a real measurement of a
 * call that took under half a millisecond, and it is never a stand-in for no figure.
 */
function durationField(durationMs: number | undefined): { durationMs?: number } {
    return durationMs === undefined ? {} : { durationMs };
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
