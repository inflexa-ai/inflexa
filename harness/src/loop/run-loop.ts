/**
 * The agent loop: one conversation of one agent with a model and its tools.
 *
 * The AI SDK drives each request series with `streamText`. Inside a DBOS
 * workflow, `durableCalls` makes each model call a step, and the tool adapter
 * makes each tool call a step, thus a recovery replays each completed call
 * from its checkpoint. Outside a workflow, each call runs directly. The same
 * loop serves a chat turn, a workflow step, and a sub-agent.
 *
 * The loop keeps the transcript itself, and each request sends its view of
 * the transcript. This gives the loop the work that the SDK does not do: the
 * append-only record of each round, the round sink, the compaction, the
 * follow-up request, the salvage, the not-run answer of each unanswered call
 * at an exit, and the finish record.
 */

import { randomUUID } from "node:crypto";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { durableCalls } from "@dbos-inc/vercel-ai";
import {
    NoSuchToolError,
    streamText,
    wrapLanguageModel,
    type AssistantModelMessage,
    type ModelMessage,
    type StepResult,
    type ToolCallPart,
    type ToolResultPart,
    type LanguageModelMiddleware,
    type ToolSet,
    type UIMessageStreamWriter,
} from "ai";

import { forSubAgent, type AgentSession } from "../auth/types.js";
import { createNoopUsageRecorder } from "../billing/noop-usage-recorder.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { CompactionPart } from "../contracts/chat-parts.js";
import type { TokenUsageRollup } from "../contracts/usage.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { toThrowable } from "../lib/result.js";
import { errorNameOf } from "../lib/thrown.js";
import {
    contextRecordOf,
    markCompactionExchange,
    markInterruptedMessage,
    summaryMarkerMessage,
    syntheticUserMessage,
    withRequestInputTokens,
    type CompactionTrigger,
} from "../memory/ai-sdk-message-storage.js";
import { conversationView, lastRequestInputTokens, withoutReasoning } from "../memory/conversation-view.js";
import { answerUnansweredToolCalls } from "../memory/tool-call-integrity.js";
import { aliasedToolName } from "./tool-name-repair.js";
import { fallbackModelOf } from "../providers/ai-sdk.js";
import { extractStatus, findProviderError } from "../providers/errors.js";
import { DEFAULT_PROMPT_CACHE, withPromptCacheBreakpoint, withSystemPromptBreakpoint } from "../providers/prompt-cache.js";
import type { ChatProvider, PromptCachePolicy, ProviderOptions, ReasoningPolicy } from "../providers/types.js";
import type { AskRequest } from "../tools/approval/contract.js";
import { accountingMiddleware, rollupMiddleware } from "./accounting.js";
import { createCallPolicy, type CallPolicy, type CallPolicyState, type ToolMask } from "./call-policy.js";
import { createRunScriptTool } from "../tools/script/run-script.js";
import { COMPACTION_MAX_REQUESTS, type CompactionPolicy } from "./compaction.js";
import { addChatUsage, hasReportedUsage, recordAgentRun, type AgentRunUsage } from "./metrics.js";
import {
    adaptTools,
    deniedReason,
    foldCallRecords,
    isFatalToolError,
    modelViewOf,
    recordedInputOf,
    ToolCallOutputSchema,
    type ToolCallOutput,
} from "./tool-adapter.js";
import { READ_TOOL_OUTPUT_TOOL_ID, type ToolOutputStore } from "./tool-output.js";
import type { AgentDefinition, EmitFn, EventSource, LoopMessage } from "./types.js";

export type AgentFinish = {
    /**
     * The stop reason: the finish reason of the last reply, `aborted`, `max_iterations` at the step cap, or
     * `denied` after a denial of the user. A word outside the modeled union stays as the provider sent it.
     */
    readonly reason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "aborted" | "max_iterations" | "denied" | (string & {});
    /** The word of the endpoint for the stop, when the provider captured one. */
    readonly rawFinishReason?: string;
    readonly cappedOut: boolean;
    /** What the model calls of this run reported. Absent when no call reported anything — never an all-zero figure. */
    readonly usage?: AgentRunUsage;
    /**
     * The whole turn's total, every descendant loop included. Present only on
     * the loop that created the turn accumulator — the run whose options
     * carried none, which is by construction the turn's root.
     */
    readonly turnUsage?: AgentRunUsage;
};

/** One tool call of a completed request, in the order that the model made the calls. */
export type LoopToolCall = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
    /** The output of a call that ran. Absent for a refused call and for an input that did not parse. */
    readonly output?: ToolCallOutput;
    /** The policy of the run refused the call, thus it did not run. */
    readonly refused: boolean;
    /** The call has a result in the conversation. */
    readonly answered: boolean;
};

/** One completed model request of a run, and the tool calls of its reply. */
export type LoopStep = {
    readonly finishReason: string;
    readonly rawFinishReason?: string;
    readonly calls: readonly LoopToolCall[];
};

export type LoopResult = {
    readonly messages: LoopMessage[];
    readonly finish: AgentFinish;
    /** Each completed request of the run, in order. A selector reads the outcome of a run from them. */
    readonly steps: readonly LoopStep[];
};

/** A request that the provider refused for its content: the HTTP status and the text of the provider error. */
export type RequestRefusal = {
    readonly status: number;
    readonly message: string;
};

/** The messages that the loop appended after the last call of the round sink. */
export type AgentRound = {
    readonly messages: readonly LoopMessage[];
};

/** The decision of the user on the approval of one call. */
export type ApprovalDecision = { readonly kind: "approved" } | { readonly kind: "denied"; readonly feedback?: string };

/** The reason of a call that asks for approval in a loop where no surface can answer. */
const NO_APPROVER_REASON = "This action needs the approval of the user, and no one can answer here. Thus it did not run.";

export type LoopOptions = {
    readonly provider: ChatProvider;
    readonly signal: AbortSignal;
    readonly emit: EmitFn;
    /** Receives each text delta of the reply as it streams. A loop with a live reader of its text gives it. */
    readonly onText?: (text: string) => void | Promise<void>;
    /**
     * The round sink. The loop awaits it before each model request, at each exit, and before a throw.
     * A durable loop passes no sink, because DBOS replays the loop body.
     */
    readonly onRound?: (round: AgentRound) => Promise<void>;
    /**
     * The compaction policy. Each request then sends the view of the transcript, and the loop compacts
     * before a task request whose view passes the budget. A durable loop passes no policy, because
     * `recordsAfter` reads the database outside a step.
     */
    readonly compaction?: CompactionPolicy;
    /**
     * The messages that open the turn of a chat thread: the user message and its context records. The loop appends
     * them after the turn-start compaction, thus the conversation holds each message in the order that it was sent.
     * Absent: `initial` holds the whole conversation.
     */
    readonly turnInput?: readonly LoopMessage[];
    /**
     * The decision of the user on a call whose tool asks for approval. The loop asks before the call runs, after the
     * call policy. Absent: no surface can answer, and the loop denies each such call.
     */
    readonly approve?: (request: AskRequest, call: { readonly toolCallId: string; readonly toolName: string }) => Promise<ApprovalDecision>;
    /** The mask of the task, the budget, and the guard of the run. A refused call does not run. */
    readonly policy?: CallPolicy;
    /** Ends the run when its outcome is final, for example a blocker of a step agent. The finish reason is `stop`. */
    readonly stopWhen?: (steps: readonly LoopStep[]) => boolean;
    /** An early cap: the run ends as if it reached its step cap, for example after the refusal limit of a guard. */
    readonly capWhen?: () => boolean;
    /**
     * Prompt-cache policy for every model call of this run. Defaults to `DEFAULT_PROMPT_CACHE` (5m) — an agent
     * loop always re-sends its prefix, so it breaks even by the second request. A host whose endpoint ignores
     * or charges badly for cache directives passes `"off"`.
     */
    readonly promptCache?: PromptCachePolicy;
    /**
     * The reasoning effort for each model call of this run. Anthropic discards its message cache when the
     * top-level effort changes, so the run sends the same value, or none, throughout.
     */
    readonly reasoning?: ReasoningPolicy;
    readonly logger?: Logger;
    /** Per-call usage accounting. Omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** Keeps the text of each cut tool result. A run with no store cuts, and it keeps nothing. */
    readonly toolOutputStore?: ToolOutputStore;
    /**
     * The turn's usage accumulator, supplied by whatever ran this loop as part of a larger turn (a
     * sub-agent-running tool passes `ctx.turnUsage`). A run that receives none creates its own and is
     * therefore the turn's root: it alone reports `turnUsage` on its finish.
     */
    readonly turnUsage?: AgentRunUsage;
    /**
     * The durable stream that each model call of the run writes its text to, from inside its step. A loop
     * outside a workflow writes nothing, and `onText` gives its text.
     */
    readonly chatStream?: string;
    /** Receives the chunks that each tool step writes through the tool writer of the library, on a replay too. */
    readonly toolWriter?: UIMessageStreamWriter;
    /** Model middleware inside the step of each model call, thus a replay of a recorded call does not run it. */
    readonly modelMiddleware?: readonly LanguageModelMiddleware[];
    /**
     * The id of the tool call this loop runs inside, supplied by a sub-agent-running tool from its
     * `ctx.invocationId`. It separates two dispatches of the same sub-agent in one round in the usage record
     * key. The data profile gives the workflow id of its attempt, because each profile runs under the same
     * constant frame.
     */
    readonly invocationId?: string;
    /**
     * Waits out a failed request whose cause a person or time can repair, and gives how the wait ended: the deadline
     * of a retry, a resume, or a stop. `undefined`: the failure does not pause, and the loop throws it. The body of a
     * workflow gives the pause of its work. A loop with no pause throws each failure.
     */
    readonly pause?: (failure: unknown, attempt: number, signal: AbortSignal) => Promise<"retry" | "resume" | "abort" | undefined>;
};

/** The harness request after a reply that a failed request cut. The model reads its partial reply, and continues it. */
export const CONTINUE_REQUEST = "[The model request failed during your reply above. Continue the reply from where it stopped.]";

/** A run that receives no turn accumulator is the turn's root. See `LoopOptions.turnUsage`. */
export const isTurnRoot = (opts: Pick<LoopOptions, "turnUsage">): boolean => opts.turnUsage === undefined;

/** The name of the durable step of each model call. It holds no model id, thus a change of the model never breaks a replay. */
function modelStepName(agentId: string): string {
    return `${agentId}.model`;
}

/** Run an agent over `initial` until its reply ends the run. */
export async function runLoop(agent: AgentDefinition, initial: readonly LoopMessage[], session: AgentSession, opts: LoopOptions): Promise<LoopResult> {
    const conversation = openConversation(agent, initial, session, opts, agent.id);
    return conversation.guard(async () => {
        if (opts.turnInput !== undefined) {
            const ended = await conversation.startTurn(opts.turnInput);
            if (ended !== undefined) return ended;
        }
        return conversation.run({ mask: opts.policy?.mask, maxRequests: agent.maxIterations, checksBudget: true });
    });
}

/** One harness request that continues a finished conversation. */
export type FollowUpRequest = {
    /** Appended as a synthetic user message, thus it opens no turn in a stored thread. */
    readonly text: string;
    /** The tools that can run. The request still declares every tool of the agent. */
    readonly mask: ToolMask;
    readonly maxRequests: number;
    /**
     * When set, metrics and token counts are attributed to this id instead of
     * `agent.id`, through `forSubAgent`. Omitted, both stay the agent's own.
     */
    readonly accountingAgentId?: string;
    /** A `provider` error with the status `400` or `413` ends the request with the finish reason `error`, and no throw. */
    readonly endOnRequestRefusal?: boolean;
};

export type FollowUpResult = LoopResult & {
    /** The refusal that ended a request with `endOnRequestRefusal`. */
    readonly refusal?: RequestRefusal;
};

/**
 * Continue a finished conversation with one harness request. `agent` and `opts`
 * must match the conversation's own, since each request extends its cached
 * prefix. `conversation` itself is never changed. The result holds only the new
 * messages, starting with the request.
 */
export async function continueLoop(
    agent: AgentDefinition,
    conversation: readonly LoopMessage[],
    request: FollowUpRequest,
    session: AgentSession,
    opts: LoopOptions,
): Promise<FollowUpResult> {
    const accountingAgentId = request.accountingAgentId;
    const runSession = accountingAgentId === undefined ? session : forSubAgent(session, accountingAgentId);
    const { onRound: _onRound, compaction: _compaction, turnInput: _turnInput, stopWhen: _stopWhen, capWhen: _capWhen, ...followUp } = opts;
    const open = openConversation(agent, conversation, runSession, followUp, accountingAgentId ?? agent.id);
    const result = await open.guard(() =>
        open.run({
            mask: request.mask,
            maxRequests: request.maxRequests,
            requestText: request.text,
            endsOnRequestRefusal: request.endOnRequestRefusal === true,
        }),
    );
    return { ...result, messages: result.messages.slice(conversation.length) };
}

/** Default salvage budget: one submit plus a fix of a refused submission or two. */
export const DEFAULT_SALVAGE_REQUESTS = 3;

/** How to salvage a run that ended with no outcome. */
export type TerminalSalvage = {
    /** The tools that can run in the salvage request. Each one must be a declared tool of the agent. */
    readonly tools: readonly string[];
    /** Opens the salvage request as a synthetic user message. */
    readonly nudge: string;
    /** The cap of salvage requests. Defaults to {@link DEFAULT_SALVAGE_REQUESTS}. */
    readonly maxRequests?: number;
    /** Whether the recorded steps hold the outcome of the agent. */
    readonly hasOutcome: (steps: readonly LoopStep[]) => boolean;
};

/**
 * What a salvage request was and how it went — present only when one ran. The first finish is the
 * diagnosis of why a salvage was needed: a run that capped out spent its budget, and a run that ended
 * on prose gave up early.
 */
export type SalvageRecord = {
    readonly firstFinish: AgentFinish;
    readonly finish: AgentFinish;
};

export type SalvagedResult = LoopResult & {
    /** Null when the first run reached its outcome and no salvage ran. */
    readonly salvage: SalvageRecord | null;
};

/**
 * Run an agent that has an outcome, and send one salvage request when the run
 * ends with none and was not aborted. The salvage request lets only the
 * terminal tools of the agent run. A salvaged result carries both runs'
 * messages and steps and the summed rollups, with the finish of the salvage.
 */
export async function runWithSalvage(
    agent: AgentDefinition,
    initial: readonly LoopMessage[],
    session: AgentSession,
    opts: LoopOptions,
    salvage: TerminalSalvage,
): Promise<SalvagedResult> {
    const undeclared = salvage.tools.find((id) => !agent.tools.some((tool) => tool.id === id));
    if (undeclared !== undefined) {
        throw new Error(`The terminal tool "${undeclared}" is not a declared tool of the agent "${agent.id}", thus the salvage mask cannot let it run.`);
    }
    const first = await runLoop(agent, initial, session, opts);
    if (salvage.hasOutcome(first.steps) || first.finish.reason === "aborted" || opts.signal.aborted) return { ...first, salvage: null };

    const maxRequests = salvage.maxRequests ?? DEFAULT_SALVAGE_REQUESTS;
    (opts.logger ?? createNoopLogger()).named("loop").warn("salvaging a run that ended with no outcome", {
        agentId: agent.id,
        callPath: session.provenance.callPath,
        firstFinishReason: first.finish.reason,
        firstCappedOut: first.finish.cappedOut,
        salvageTools: salvage.tools,
        salvageMaxRequests: maxRequests,
    });
    const salvaged = await continueLoop(agent, first.messages, { text: salvage.nudge, mask: { allow: salvage.tools }, maxRequests }, session, opts);
    return {
        messages: [...first.messages, ...salvaged.messages],
        steps: [...first.steps, ...salvaged.steps],
        finish: {
            ...salvaged.finish,
            ...sumUsage("usage", first.finish, salvaged.finish),
            ...sumUsage("turnUsage", first.finish, salvaged.finish),
        },
        salvage: { firstFinish: first.finish, finish: salvaged.finish },
    };
}

function sumUsage(field: "usage" | "turnUsage", first: AgentFinish, second: AgentFinish): Pick<AgentFinish, "usage" | "turnUsage"> {
    const a = first[field];
    const b = second[field];
    if (a === undefined && b === undefined) return {};
    const total: AgentRunUsage = {};
    addChatUsage(total, a);
    addChatUsage(total, b);
    return { [field]: total };
}

export function finalText(messages: readonly LoopMessage[]): string {
    const last = messages.at(-1);
    if (last === undefined || last.role !== "assistant") return "";
    if (typeof last.content === "string") return last.content;
    return last.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

/** One series of model requests under one mask: the task of a run, or a follow-up request. */
type RequestSeries = {
    readonly mask: ToolMask | undefined;
    readonly maxRequests: number;
    /** A harness request that the series appends, as a synthetic user message, before its first request. */
    readonly requestText?: string;
    /** The loop compacts before a request of the series whose view passes the budget of the policy. */
    readonly checksBudget?: boolean;
    /** A refusal of a request, a `provider` error with the status `400` or `413`, ends the series with no new message. */
    readonly endsOnRequestRefusal?: boolean;
};

/** A series whose request failed, with the reply that the failed request streamed before the failure. */
type SeriesFailure = { readonly kind: "failed"; readonly failure: unknown; readonly partial: LoopMessage[] };

/** How a series ended, short of a throw. */
type SeriesEnd =
    | { readonly kind: "reply"; readonly finishReason: string; readonly rawFinishReason?: string }
    | { readonly kind: "capped" }
    | { readonly kind: "early-cap" }
    | { readonly kind: "stopped" }
    | { readonly kind: "denied" }
    | { readonly kind: "aborted" }
    | { readonly kind: "refused"; readonly refusal: RequestRefusal };

/** The facts of one series that a request of the series reads. */
type SeriesTarget = {
    /** The conversation that the series extends, in place. */
    readonly messages: LoopMessage[];
    readonly session: AgentSession;
    readonly metricAgentId: string;
    /** The rollups that the usage of each call folds into. */
    readonly rollups: readonly AgentRunUsage[];
    /** The view of the conversation that a request sends. */
    readonly viewOf: (messages: readonly LoopMessage[]) => LoopMessage[];
    /** Runs before each request: the round sink and the compaction. */
    readonly beforeRequest?: () => Promise<void>;
    /** Receives each text delta of the reply. */
    readonly onText?: (text: string) => void | Promise<void>;
    /** The durable stream that the text of the reply goes to. A compaction exchange streams no text. */
    readonly textStream?: string;
    /** Each step of the run so far, which a stop condition reads. */
    readonly steps: LoopStep[];
    readonly stopWhen?: (steps: readonly LoopStep[]) => boolean;
    readonly capWhen?: () => boolean;
};

type Conversation = {
    /** Compact before the input of the turn joins when the last request passed the turn-start budget. The result of the run when an abort ends the compaction. */
    startTurn(input: readonly LoopMessage[]): Promise<LoopResult | undefined>;
    /** Run one series to the end of the run. */
    run(series: RequestSeries): Promise<FollowUpResult>;
    /** Give the open round to the sink before a throw leaves the run. */
    guard<T>(body: () => Promise<T>): Promise<T>;
};

/**
 * The agent with the `run_script` tool over its script tools, after its own tools. The tool is a pure function of
 * the script tools, thus each request of a conversation declares the same tool, and the prompt cache holds.
 */
export function withRunScript(agent: AgentDefinition, logger?: Logger): AgentDefinition {
    const scriptTools = agent.scriptTools ?? [];
    if (scriptTools.length === 0) return agent;
    const asking = scriptTools.find((tool) => tool.approval !== undefined || tool.startsWorkflow === true);
    if (asking !== undefined) throw new Error(`the script tool ${asking.id} of agent ${agent.id} asks an approval or starts a workflow`);
    const ownStep = scriptTools.find((tool) => tool.ownStep === true);
    if (ownStep !== undefined) throw new Error(`the script tool ${ownStep.id} of agent ${agent.id} must run as its own durable step`);
    return { ...agent, tools: [...agent.tools, createRunScriptTool(scriptTools, agent.scriptRuntime, { scratch: agent.scriptScratch, logger })] };
}

/**
 * Open the loop over one conversation. `metricAgentId` is the id that usage
 * and run metrics count under, which is not always `agent.id`.
 */
function openConversation(
    declared: AgentDefinition,
    initial: readonly LoopMessage[],
    session: AgentSession,
    opts: LoopOptions,
    metricAgentId: string,
): Conversation {
    const agent = withRunScript(declared, opts.logger);
    const { provider, emit } = opts;
    if (agent.tools.length > 0 && !provider.capabilities.toolCalling) {
        throw new Error(`Provider/model cannot run tool-required agent "${agent.id}"`);
    }

    const messages: LoopMessage[] = [...initial];
    // The loop never changes a message before `givenCount`, because the sink can hold it already.
    let givenCount = initial.length;
    // Stays true when the sink rejects, thus the throw path does not call the sink again.
    let sinkPending = false;
    const giveRound = async (): Promise<void> => {
        if (opts.onRound === undefined || messages.length === givenCount) return;
        sinkPending = true;
        await opts.onRound({ messages: messages.slice(givenCount) });
        sinkPending = false;
        givenCount = messages.length;
    };

    const log = (opts.logger ?? createNoopLogger()).named("loop").with({ agentId: session.provenance.agentId, callPath: session.provenance.callPath });
    const policy = opts.compaction;
    const viewOptions = { keepFirstTurn: policy?.keepFirstTurn === true };
    const viewOf = (from: readonly LoopMessage[]): LoopMessage[] => (policy === undefined ? [...from] : conversationView(from, viewOptions).messages);

    // A run handed no accumulator is the turn's root: it creates the one every
    // descendant loop folds into, and it is the only loop entitled to report a
    // turn total. Descendants receive the root's object and mutate it in place.
    const turnUsage: AgentRunUsage = opts.turnUsage ?? {};
    const turnRoot = isTurnRoot(opts);
    const usage: AgentRunUsage = {};
    const steps: LoopStep[] = [];
    const calls = createCallPolicy(opts.policy ?? {});

    let compactionStopped = false;
    // The first request after a summary shows if the summary brought the conversation under the budget.
    let summarizedLast = false;

    /**
     * Run one series, and wait out a failure that pauses. After the wait, the series runs again with the requests
     * that it did not use. A partial reply of the failed request stays as an interrupted reply, and one harness
     * request asks the model to continue it. A failure with no partial reply changes no message, thus the next
     * request sends the same view.
     */
    const series = async (target: SeriesTarget, spec: RequestSeries): Promise<SeriesEnd> => {
        let current = spec;
        let attempt = 0;
        for (;;) {
            const stepsBefore = target.steps.length;
            const ended = await runSeries(agent, opts, calls, log, target, current);
            if (ended.kind !== "failed") return ended;
            const used = target.steps.length - stepsBefore;
            // A request that completed ends the outage, thus the timer of the next pause starts again.
            if (used > 0) attempt = 0;
            const pauseEnd = opts.pause === undefined ? undefined : await opts.pause(ended.failure, attempt, opts.signal);
            if (pauseEnd === undefined) throw toThrowable(ended.failure);
            const [reply, ...results] = ended.partial;
            if (reply !== undefined) {
                const from = target.messages.length;
                target.messages.push(markInterruptedMessage(reply), ...results);
                answerUnansweredToolCalls(target.messages, from);
            }
            if (pauseEnd === "abort") return { kind: "aborted" };
            attempt = pauseEnd === "retry" ? attempt + 1 : 0;
            current = { ...current, maxRequests: current.maxRequests - used, requestText: reply === undefined ? undefined : CONTINUE_REQUEST };
        }
    };

    const finishUsage = (): Pick<AgentFinish, "usage" | "turnUsage"> => {
        const rollups: { usage?: TokenUsageRollup; turnUsage?: TokenUsageRollup } = {};
        if (hasReportedUsage(usage)) rollups.usage = { ...usage };
        if (turnRoot && hasReportedUsage(turnUsage)) rollups.turnUsage = { ...turnUsage };
        return rollups;
    };

    /**
     * Settle the transcript on the way out. A reply can carry a complete tool
     * call beside any finish reason, and a call this run never ran gets a
     * not-run result instead of being executed or dropped: every tool call
     * needs a result, or the provider refuses the transcript on the next turn.
     * The fix only appends. It never edits or removes a message.
     */
    const settleTranscript = (): void => {
        const answered = answerUnansweredToolCalls(messages, initial.length);
        if (answered.length === 0) return;
        log.warn("unanswered tool calls answered at run exit", { toolCallIds: answered.map((d) => d.toolCallId), tools: answered.map((d) => d.toolName) });
    };

    const end = async (seriesEnd: SeriesEnd): Promise<FollowUpResult> => {
        settleTranscript();
        const toolCalls = steps.reduce((n, step) => n + step.calls.length, 0);
        const toolErrors = steps.reduce(
            (n, step) => n + step.calls.filter((call) => call.refused || (call.output !== undefined && call.output.outcome !== "ok")).length,
            0,
        );
        const finish = finishOf(seriesEnd, finishUsage());
        recordAgentRun({ agentId: metricAgentId, iterations: steps.length, cappedOut: finish.cappedOut });
        const level = finish.cappedOut || finish.reason === "denied" || seriesEnd.kind === "refused" ? "warn" : "info";
        log[level]("run finished", { iterations: steps.length, reason: finish.reason, cappedOut: finish.cappedOut, toolCalls, toolErrors, usage });
        await giveRound();
        return { messages, finish, steps, refusal: seriesEnd.kind === "refused" ? seriesEnd.refusal : undefined };
    };

    const mainTarget = (beforeRequest: (() => Promise<void>) | undefined): SeriesTarget => ({
        messages,
        session,
        metricAgentId,
        rollups: [usage, turnUsage],
        viewOf,
        beforeRequest,
        onText: opts.onText,
        textStream: opts.chatStream,
        steps,
        stopWhen: opts.stopWhen,
        capWhen: opts.capWhen,
    });

    /** The result of the run when an abort ends the exchange, or `undefined` when the run continues. */
    const compact = async (active: CompactionPolicy, tokensBefore: number, trigger: CompactionTrigger): Promise<"aborted" | undefined> => {
        // The body of a workflow records the id, thus a replay of the exchange gives the same id.
        const id = DBOS.isInWorkflow() ? await DBOS.randomUUID() : randomUUID();
        const startedAt = performance.now();
        const source = sourceOf(session, opts.invocationId);
        const emitPart = (data: Omit<CompactionPart, "type" | "trigger">): void | Promise<void> =>
            emit({ type: "data-compaction", source, data: { ...data, trigger } });
        await emitPart({ id, status: "running", tokensBefore });
        let settled = false;
        try {
            const exchangeAgentId = `${agent.id}-compaction`;
            const view = viewOf(messages);
            const exchange: LoopMessage[] = [...view];
            const exchangeEnd = await series(
                {
                    messages: exchange,
                    session: forSubAgent(session, exchangeAgentId),
                    metricAgentId: exchangeAgentId,
                    rollups: [turnUsage],
                    viewOf: (from) => [...from],
                    steps: [],
                },
                { mask: active.mask, maxRequests: COMPACTION_MAX_REQUESTS, requestText: active.request, endsOnRequestRefusal: true },
            );
            const exchangeMessages = exchange.slice(view.length);
            answerUnansweredToolCalls(exchangeMessages);
            messages.push(...exchangeMessages.map((message) => markCompactionExchange(message, id)));
            await giveRound();
            if (exchangeEnd.kind === "aborted") {
                settled = true;
                await emitPart({ id, status: "failed", tokensBefore, durationMs: Math.round(performance.now() - startedAt) });
                return "aborted";
            }

            const summary = exchangeEnd.kind === "reply" && exchangeEnd.finishReason === "stop" ? finalText(exchangeMessages).trim() : "";
            if (summary.length === 0) {
                settled = true;
                const durationMs = Math.round(performance.now() - startedAt);
                await emitPart({ id, status: "failed", tokensBefore, durationMs });
                const refusal = exchangeEnd.kind === "refused" ? { status: exchangeEnd.refusal.status, providerError: exchangeEnd.refusal.message } : {};
                log.error("compaction gave no summary, thus the run compacts no more", { compactionId: id, trigger, tokensBefore, durationMs, ...refusal });
                compactionStopped = true;
                return undefined;
            }
            const markerOf = (durationMs: number): LoopMessage => summaryMarkerMessage(summary, { kind: "summary", id, tokensBefore, durationMs, trigger });
            // The figures of a marker do not change the view, thus a draft marker gives the view of the real one.
            const records = await active.recordsAfter(conversationView([...messages, markerOf(0)], viewOptions).messages);
            const durationMs = Math.round(performance.now() - startedAt);
            messages.push(markerOf(durationMs), ...records);
            settled = true;
            // The `done` part goes out before the marker round: a chat turn gives the rounds after a marker a new
            // assistant message, and the `running` and `done` parts of one compaction must stream into the same message.
            await emitPart({ id, status: "done", tokensBefore, durationMs });
            await giveRound();
            log.info("conversation compacted", { compactionId: id, trigger, tokensBefore, durationMs });
            summarizedLast = true;
            return undefined;
        } finally {
            if (!settled) await emitPart({ id, status: "failed", tokensBefore, durationMs: Math.round(performance.now() - startedAt) });
        }
    };

    const compactOverBudget = async (): Promise<void> => {
        if (policy === undefined || compactionStopped) return;
        const tokens = lastRequestInputTokens(messages);
        if (tokens === undefined) return;
        const afterSummary = summarizedLast;
        summarizedLast = false;
        if (tokens <= policy.budget) return;
        if (afterSummary) {
            log.warn("the first request after the summary still exceeds the budget, thus the run compacts no more", { tokens, budget: policy.budget });
            compactionStopped = true;
            return;
        }
        // An abort during the exchange aborts the request that follows it, thus the run ends as aborted.
        await compact(policy, tokens, "mid-turn");
    };

    return {
        async startTurn(input) {
            const budget = policy?.turnStartBudget;
            const tokens = lastRequestInputTokens(messages);
            if (policy === undefined || budget === undefined || tokens === undefined || tokens <= budget) {
                messages.push(...input);
                return undefined;
            }
            const ended = await compact(policy, tokens, "turn-start");
            if (ended === "aborted") return end({ kind: "aborted" });
            // The records after a summary give the current context, thus a record of the input would only repeat one.
            messages.push(...(summarizedLast ? input.filter((message) => contextRecordOf(message) === undefined) : input));
            return undefined;
        },

        async run(spec) {
            const beforeRequest = async (): Promise<void> => {
                await giveRound();
                if (spec.checksBudget === true) await compactOverBudget();
            };
            return end(await series(mainTarget(beforeRequest), spec));
        },

        // A throw keeps the open round, and the not-run results keep that stored round valid on the wire.
        async guard(body) {
            try {
                return await body();
            } catch (err) {
                log.error("run failed", { iterations: steps.length, ...log.errorFields(err) });
                if (opts.onRound === undefined || sinkPending) throw err;
                answerUnansweredToolCalls(messages, givenCount);
                // A rejection of this call must not hide the error of the run.
                await giveRound().catch(() => undefined);
                throw err;
            }
        },
    };
}

function finishOf(seriesEnd: SeriesEnd, rollups: Pick<AgentFinish, "usage" | "turnUsage">): AgentFinish {
    switch (seriesEnd.kind) {
        case "reply":
            return { reason: seriesEnd.finishReason, rawFinishReason: seriesEnd.rawFinishReason, cappedOut: false, ...rollups };
        case "capped":
        case "early-cap":
            return { reason: "max_iterations", cappedOut: true, ...rollups };
        case "stopped":
            return { reason: "stop", cappedOut: false, ...rollups };
        case "denied":
            return { reason: "denied", cappedOut: false, ...rollups };
        case "aborted":
            return { reason: "aborted", cappedOut: false, ...rollups };
        case "refused":
            return { reason: "error", cappedOut: false, ...rollups };
    }
}

function sourceOf(session: AgentSession, invocationId: string | undefined): EventSource {
    const source: { agentId: string; callPath: readonly string[]; invocationId?: string } = {
        agentId: session.provenance.agentId,
        callPath: session.provenance.callPath,
    };
    if (invocationId !== undefined) source.invocationId = invocationId;
    return source;
}

/** The statuses of a request that the provider refuses for its content, for example a request past the context window. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 413]);

function requestRefusalOf(failure: unknown): RequestRefusal | undefined {
    const error = findProviderError(failure);
    if (error?.type !== "provider") return undefined;
    const status = extractStatus(error);
    return status !== undefined && REFUSAL_STATUSES.has(status) ? { status, message: error.message } : undefined;
}

/** Whether the loop asks the model again after this step: each call of the reply has a result. */
function continuesAfter(step: LoopStep): boolean {
    return step.calls.length > 0 && step.calls.every((call) => call.answered);
}

function deniedByUser(step: LoopStep): boolean {
    return step.calls.some((call) => call.output?.outcome === "denied");
}

/**
 * Run one series of model requests with `streamText`, and say how it ended.
 * A failed request ends the series as `failed`, and a fatal tool error leaves as a throw.
 */
async function runSeries(
    agent: AgentDefinition,
    opts: LoopOptions,
    calls: CallPolicyState,
    log: Logger,
    target: SeriesTarget,
    spec: RequestSeries,
): Promise<SeriesEnd | SeriesFailure> {
    const { messages, session } = target;
    const startIndex = messages.length;
    if (spec.requestText !== undefined) messages.push(syntheticUserMessage(spec.requestText));

    const promptCache = opts.promptCache ?? DEFAULT_PROMPT_CACHE;
    const source = sourceOf(session, opts.invocationId);
    const bound = opts.provider.bind({
        session,
        reasoning: opts.reasoning,
        live: target.onText !== undefined,
        // A reader sees the retries of a request, thus a wait of the envelope is no silence. The part is transient,
        // and a failed write of it changes nothing of the request.
        onRetry: (retry) => {
            const part = {
                id: retry.requestId,
                attempt: retry.attempt,
                maxRetries: retry.maxRetries,
                retryAt: new Date(Date.now() + retry.delayMs).toISOString(),
                status: retry.status,
            };
            void Promise.resolve(opts.emit({ type: "data-model-retry", source, data: part })).catch(() => undefined);
        },
    });
    const model = wrapLanguageModel({
        model: bound.model,
        middleware: [
            rollupMiddleware(target.rollups),
            durableCalls({ name: modelStepName(agent.id), retriesAllowed: false, durableStream: target.textStream }),
            accountingMiddleware({
                session,
                agentId: target.metricAgentId,
                invocationId: opts.invocationId,
                usageRecorder: opts.usageRecorder ?? createNoopUsageRecorder(),
                logger: log,
            }),
            ...(opts.modelMiddleware ?? []),
        ],
    });

    // The work before the current request, which an abort of the stream does not wait for.
    let preparing: Promise<void> | undefined;
    // The first fatal error of a tool call or of an approval ends the series, and the series throws it.
    let fatal: unknown;
    const fatalController = new AbortController();
    const failRun = (err: unknown): void => {
        if (fatal !== undefined) return;
        fatal = err;
        fatalController.abort(err);
    };
    const tools = adaptTools(agent.tools, {
        session,
        source,
        emit: opts.emit,
        turnUsage: target.rollups.at(-1) ?? {},
        capabilities: opts.provider.capabilities,
        // Only the read tool of the agent can read a kept text, thus an agent without it keeps nothing.
        store: agent.tools.some((tool) => tool.id === READ_TOOL_OUTPUT_TOOL_ID) ? opts.toolOutputStore : undefined,
        invocationId: opts.invocationId,
        log,
        writer: opts.toolWriter,
        fail: failRun,
    });

    const toolsById = new Map(agent.tools.map((tool) => [tool.id, tool]));
    // The calls that the user denied, with the reason that the model reads. A replay asks again, and the same answer
    // comes back from the checkpoints of the turn.
    const deniedByTheUser = new Map<string, string>();
    /** The reason of a denial of the user, or `undefined` for a call that runs. */
    const userDenialOf = async (toolCall: { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }): Promise<string | undefined> => {
        const tool = toolsById.get(toolCall.toolName);
        if (tool?.approval === undefined) return undefined;
        // An input that does not parse needs no approval: `execute` gives the model its error.
        const input = recordedInputOf(tool.inputSchema, toolCall.input);
        if (input === undefined) return undefined;
        const request = await tool.approval(input, { invocationId: toolCall.toolCallId, session });
        if (request === undefined) return undefined;
        if (opts.approve === undefined) return NO_APPROVER_REASON;
        const decision = await opts.approve(request, { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName });
        return decision.kind === "approved" ? undefined : deniedReason(decision.feedback);
    };

    const seriesSteps: LoopStep[] = [];
    let open = openStep();
    let failure: unknown;
    const requestView = (): ModelMessage[] => [...withPromptCacheBreakpoint(sanitizeMessages(target.viewOf(messages)), promptCache)];
    const stops = (): boolean =>
        seriesSteps.length >= spec.maxRequests ||
        deniedByUser(seriesSteps.at(-1) ?? { finishReason: "", calls: [] }) ||
        target.stopWhen?.(target.steps) === true ||
        target.capWhen?.() === true;

    const result = streamText({
        model,
        instructions: withSystemPromptBreakpoint(agent.systemPrompt, promptCache),
        messages: requestView(),
        tools,
        toolChoice: "auto",
        maxOutputTokens: bound.settings.maxOutputTokens,
        reasoning: bound.settings.reasoning,
        providerOptions: mergeProviderOptions(bound.settings.providerOptions, agent.providerOptions),
        // The retry envelope of the provider owns the retries, inside the step of the call.
        maxRetries: 0,
        abortSignal: AbortSignal.any([opts.signal, fatalController.signal]),
        telemetry: bound.telemetry,
        repairToolCall: ({ toolCall, tools: declared, error }) => {
            if (!NoSuchToolError.isInstance(error)) return Promise.resolve(null);
            const tool = aliasedToolName(toolCall.toolName, new Set(Object.keys(declared)));
            if (tool === undefined) return Promise.resolve(null);
            log.warn("a tool call named a proxy alias of a declared tool", { alias: toolCall.toolName, tool });
            return Promise.resolve({ ...toolCall, toolName: tool });
        },
        toolApproval: async ({ toolCall }) => {
            const refusal = calls.refusalOf({ toolName: toolCall.toolName, input: toolCall.input }, spec.mask);
            if (refusal !== undefined) {
                // A refused call does not run, thus its two events come from here.
                await opts.emit({ type: "tool-started", source, toolUseId: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input });
                await opts.emit({ type: "tool-finished", source, toolUseId: toolCall.toolCallId, name: toolCall.toolName, outcome: "error" });
                return { type: "denied", reason: refusal };
            }
            let denial: string | undefined;
            try {
                denial = await userDenialOf(toolCall);
            } catch (err) {
                // The SDK keeps a failed approval to itself, thus a cancel or an abort reaches the series here.
                if (isFatalToolError(err)) failRun(err);
                throw err;
            }
            if (denial === undefined) return undefined;
            deniedByTheUser.set(toolCall.toolCallId, denial);
            await opts.emit({ type: "tool-started", source, toolUseId: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input });
            await opts.emit({ type: "tool-finished", source, toolUseId: toolCall.toolCallId, name: toolCall.toolName, outcome: "denied" });
            return { type: "denied", reason: denial };
        },
        stopWhen: () => stops(),
        prepareStep: async () => {
            open = openStep();
            const before = target.beforeRequest?.();
            preparing = before;
            await before;
            return { messages: requestView() };
        },
        onChunk: async ({ chunk }) => {
            switch (chunk.type) {
                case "text-delta":
                    open.text += chunk.text;
                    await target.onText?.(chunk.text);
                    return;
                case "tool-call":
                    if (chunk.providerExecuted !== true)
                        open.calls.push({ type: "tool-call", toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });
                    return;
                case "tool-result": {
                    const output = ToolCallOutputSchema.safeParse(chunk.output);
                    if (output.success)
                        open.results.push({ type: "tool-result", toolCallId: chunk.toolCallId, toolName: chunk.toolName, output: modelViewOf(output.data) });
                    return;
                }
                default:
                    return;
            }
        },
        onError: ({ error }) => {
            failure ??= error;
        },
        onStepEnd: async (step) => {
            open = openStep();
            const loopStep = loopStepOf(step, deniedByTheUser);
            messages.push(...recordedMessagesOf(step, loopStep));
            foldCallRecords(agent.tools, loopStep.calls, log);
            seriesSteps.push(loopStep);
            target.steps.push(loopStep);
            if (loopStep.calls.length > 0) log.debug("iteration", { iteration: seriesSteps.length - 1, tools: loopStep.calls.map((call) => call.toolName) });
            await opts.emit({ type: "iteration", source, index: seriesSteps.length - 1, final: !continuesAfter(loopStep) || stops() });
        },
    });
    await result.consumeStream({
        onError: (error) => {
            failure ??= error;
        },
    });
    // An abort ends the stream while the work before a request can still run, for example a compaction that
    // writes its round. The series ends after that work, thus the run never writes a round beside it.
    await preparing?.catch(() => undefined);

    const callerAborted = opts.signal.aborted;
    if (fatal !== undefined && !(callerAborted && errorNameOf(fatal) === "AbortError")) {
        messages.push(...openStepMessages(open));
        answerUnansweredToolCalls(messages, startIndex);
        throw toThrowable(fatal);
    }
    if (callerAborted) {
        // An interrupted turn keeps whatever the model wrote before the cut, but never an empty shell.
        const [reply, ...results] = openStepMessages(open);
        if (reply !== undefined) messages.push(markInterruptedMessage(reply), ...results);
        answerUnansweredToolCalls(messages, startIndex);
        return { kind: "aborted" };
    }
    if (failure !== undefined && !isFatalToolError(failure)) {
        const refusal = spec.endsOnRequestRefusal === true ? requestRefusalOf(failure) : undefined;
        answerUnansweredToolCalls(messages, startIndex);
        if (refusal !== undefined) return { kind: "refused", refusal };
        return { kind: "failed", failure, partial: openStepMessages(open) };
    }

    const last = seriesSteps.at(-1);
    if (last === undefined) throw new Error(`The run of the agent "${agent.id}" ended with no completed request.`);
    if (!continuesAfter(last)) return { kind: "reply", finishReason: last.finishReason, rawFinishReason: last.rawFinishReason };
    if (deniedByUser(last)) return { kind: "denied" };
    if (target.stopWhen?.(target.steps) === true) return { kind: "stopped" };
    if (target.capWhen?.() === true) {
        log.warn("run stopped early by the host policy", { iterations: seriesSteps.length });
        return { kind: "early-cap" };
    }
    return { kind: "capped" };
}

/** What the step in flight streamed so far. An exit that cuts the step keeps it, because `onStepEnd` does not run. */
type OpenStep = {
    text: string;
    readonly calls: ToolCallPart[];
    readonly results: ToolResultPart[];
};

function openStep(): OpenStep {
    return { text: "", calls: [], results: [] };
}

/** The reply of a cut step and the results of its calls that completed. A step with no text and no call gives nothing. */
function openStepMessages(open: OpenStep): LoopMessage[] {
    if (open.text.length === 0 && open.calls.length === 0) return [];
    if (open.calls.length === 0) return [{ role: "assistant", content: open.text }];
    const text = open.text.length > 0 ? [{ type: "text" as const, text: open.text }] : [];
    const messages: LoopMessage[] = [{ role: "assistant", content: [...text, ...open.calls] }];
    const results = open.results.filter((result) => open.calls.some((call) => call.toolCallId === result.toolCallId));
    if (results.length > 0) messages.push({ role: "tool", content: results });
    return messages;
}

/** The harness view of one completed step: each tool call of the reply, with its output when it ran. */
function loopStepOf(step: StepResult<ToolSet>, deniedByTheUser: ReadonlyMap<string, string>): LoopStep {
    const outputs = new Map<string, unknown>();
    for (const result of step.toolResults) outputs.set(result.toolCallId, result.output);
    const answered = new Set<string>(outputs.keys());
    const refused = new Set<string>();
    for (const part of step.content) {
        if (part.type === "tool-error") answered.add(part.toolCallId);
        if (part.type === "tool-approval-response" && !part.approved) {
            answered.add(part.toolCall.toolCallId);
            if (!deniedByTheUser.has(part.toolCall.toolCallId)) refused.add(part.toolCall.toolCallId);
        }
    }
    const calls = step.toolCalls
        .filter((call) => call.providerExecuted !== true)
        .map((call): LoopToolCall => {
            const parsed = outputs.has(call.toolCallId) ? ToolCallOutputSchema.safeParse(outputs.get(call.toolCallId)) : undefined;
            const denial = deniedByTheUser.get(call.toolCallId);
            return {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
                output: denial === undefined ? (parsed?.success === true ? parsed.data : undefined) : { outcome: "denied", reason: denial },
                refused: refused.has(call.toolCallId),
                answered: answered.has(call.toolCallId),
            };
        });
    return { finishReason: step.finishReason, rawFinishReason: step.rawFinishReason, calls };
}

/**
 * The messages of one step as the transcript records them. The request after
 * them sends them as they are recorded, thus the record is the prefix of the
 * next request.
 *
 * - The assistant message holds the input tokens of its request, which the
 *   budget checks read, and it holds no thinking after a fallback hop.
 * - A refusal of the policy reads as the error result of the call. A denial
 *   reads as a decision of the user, and the reload of a thread reports the
 *   outcome of each call from its result.
 * - The approval parts go: they describe the approval, and the wire drops them.
 */
function recordedMessagesOf(step: StepResult<ToolSet>, loopStep: LoopStep): LoopMessage[] {
    const refused = new Set(loopStep.calls.filter((call) => call.refused).map((call) => call.toolCallId));
    const servedByFallback = fallbackModelOf(step.providerMetadata) !== undefined;
    const inputTokens = step.usage.inputTokens;
    const recorded: LoopMessage[] = [];
    for (const message of step.response.messages) {
        if (message.role === "assistant") {
            const content = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type !== "tool-approval-request");
            let assistant: AssistantModelMessage | undefined = { ...message, content };
            if (servedByFallback) {
                const stripped = withoutReasoning(assistant);
                assistant = stripped?.role === "assistant" ? stripped : undefined;
            }
            if (assistant === undefined) continue;
            recorded.push(inputTokens === undefined ? assistant : withRequestInputTokens(assistant, inputTokens));
            continue;
        }
        const content = message.content.flatMap((part) => {
            if (part.type === "tool-approval-response") return [];
            if (part.output.type === "execution-denied" && refused.has(part.toolCallId)) {
                return [{ ...part, output: { type: "error-text" as const, value: part.output.reason ?? "" } }];
            }
            return [part];
        });
        if (content.length > 0) recorded.push({ role: "tool", content });
    }
    return recorded;
}

function mergeProviderOptions(base: ProviderOptions | undefined, extra: ProviderOptions | undefined): ProviderOptions | undefined {
    if (extra === undefined) return base;
    if (base === undefined) return extra;
    const merged: Record<string, ProviderOptions[string]> = { ...base };
    for (const [namespace, options] of Object.entries(extra)) merged[namespace] = { ...base[namespace], ...options };
    return merged;
}

/**
 * Drop empty text parts — and messages left with no content at all — before
 * the request. The Anthropic Messages API rejects any request containing an
 * empty text block, and a stored thread can hold one.
 */
function sanitizeMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const m of messages) {
        if (typeof m.content === "string") {
            if (m.content !== "") out.push(m);
            continue;
        }
        // The filtered parts are a subset of this message's own content, so the
        // switch recovers the role-to-content correlation that `filter` loses.
        switch (m.role) {
            case "assistant": {
                const parts = m.content.filter((p) => p.type !== "text" || p.text !== "");
                if (parts.length > 0) out.push({ ...m, content: parts });
                break;
            }
            case "user": {
                const parts = m.content.filter((p) => p.type !== "text" || p.text !== "");
                if (parts.length > 0) out.push({ ...m, content: parts });
                break;
            }
            case "tool": {
                if (m.content.length > 0) out.push(m);
                break;
            }
            case "system":
                break;
        }
    }
    return out;
}
