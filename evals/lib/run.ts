/**
 * The runner: each case runs K trials through the real loop and the real
 * provider. All trials share one queue of fixed width, thus a run keeps its
 * throughput and stays under the rate limit of the provider.
 */

import { createHash } from "node:crypto";

import { okAsync } from "neverthrow";

import { contextRecordsFor, sanitizedUserMessage } from "@inflexa-ai/harness/app/message-assembly.js";
import { renderRunActivity } from "@inflexa-ai/harness/app/run-activity.js";
import { allWithConcurrency } from "@inflexa-ai/harness/lib/async-utils.js";
import { makeSession } from "@inflexa-ai/harness/providers/__fixtures__/session.js";
import type { AgentRunUsage } from "@inflexa-ai/harness/loop/metrics.js";
import { maskExcept } from "@inflexa-ai/harness/loop/call-policy.js";
import { continueLoop, runLoop, withRunScript, type LoopStep } from "@inflexa-ai/harness/loop/run-loop.js";
import { COMPACTION_MAX_REQUESTS } from "@inflexa-ai/harness/loop/compaction.js";
import { MEMORY_COMPACTION_REQUEST } from "@inflexa-ai/harness/prompts/compaction.js";
import type { EmitFn } from "@inflexa-ai/harness/loop/types.js";
import { RUN_SCRIPT_TOOL_ID } from "@inflexa-ai/harness/tools/script/run-script.js";
import type { KeptToolOutput, ToolOutputStore } from "@inflexa-ai/harness/loop/tool-output.js";
import { blockerOf } from "@inflexa-ai/harness/tools/sandbox/report-blocker.js";
import { SUBMIT_FILE_METADATA_TOOL_ID } from "@inflexa-ai/harness/tools/sandbox/submit-file-metadata.js";
import type { AgentDefinition, LoopMessage } from "@inflexa-ai/harness/loop/types.js";
import type { WorkingMemoryStore } from "@inflexa-ai/harness/memory/working-memory.js";
import type { ChatProvider } from "@inflexa-ai/harness/providers/types.js";
import type { CortexRunRow } from "@inflexa-ai/harness/state/schema.js";
import { errorMessageOf } from "@inflexa-ai/harness/lib/thrown.js";
import { defaultErrorFields, type Logger } from "@inflexa-ai/harness/lib/logger.js";
import {
    exposed,
    plannerTrialAgent,
    synthesisAgent,
    withSandboxScripts,
    withScriptedTools,
    type ScriptToolCall,
    type StaticAgentKind,
    type ToolExposure,
} from "./agent.js";
import { synthesizerSeedOf } from "@inflexa-ai/harness/execution/run-synthesis.js";
import { generateStepSummary } from "@inflexa-ai/harness/execution/step-summary.js";
import { generateFileMetadata } from "@inflexa-ai/harness/execution/artifact-metadata.js";
import { openSandboxTrial, type SandboxTrial } from "./sandbox.js";
import { trialOf, type EvalCase, type Grade, type RunningRun, type TrialAsk, type TrialCall } from "./case.js";

const ANALYSIS_ID = "analysis-001";

export type TrialResult =
    | ({
          readonly kind: "graded";
          readonly calls: readonly TrialCall[];
          readonly asks: readonly TrialAsk[];
          readonly text: string;
          readonly finishReason: string;
          readonly stepFinishes: readonly string[];
          readonly capped: boolean;
          /** A sandbox trial: the files under the working directory at the end. */
          readonly files?: readonly string[];
          /** A sandbox trial: each command that no exec rule answered. */
          readonly unscripted?: readonly string[];
          /** A sandbox trial of a case with `summary`: the step summary. */
          readonly summary?: string;
          readonly summaryError?: string;
          readonly usage?: AgentRunUsage;
      } & Grade)
    | { readonly kind: "error"; readonly error: string };

export type RunOptions = {
    /** The agent of each kind that a case can name. */
    readonly agents: Readonly<Record<StaticAgentKind, AgentDefinition>>;
    readonly provider: ChatProvider;
    /** The provider of the sandbox cases. Absent: `provider`. */
    readonly sandboxProvider?: ChatProvider;
    readonly trials: number;
    readonly concurrency: number;
    /** The smallest bound of one trial, in milliseconds. A case with a larger bound keeps its own. */
    readonly trialTimeoutMs: number;
    /** Where each agent holds its plain file tools. Absent: `base`. */
    readonly exposure?: ToolExposure;
    /** Called when a trial ends, for progress output. */
    readonly onTrial?: (evalCase: EvalCase, result: TrialResult) => void;
};

/**
 * A digest of what the model sees before the turn: the system prompt and each
 * tool definition of each agent. Two runs with the same digest ran the same prompt variant.
 */
export function promptDigest(agents: Readonly<Record<StaticAgentKind, AgentDefinition>>, sandboxAgents: readonly AgentDefinition[] = []): string {
    const hash = createHash("sha256");
    for (const agent of [...Object.values(agents), ...sandboxAgents]) {
        hash.update(agent.systemPrompt);
        // The loop declares `run_script`, whose description holds the catalog of the script tools, thus the digest reads
        // the tools that a request declares, and each script tool too.
        for (const tool of [...withRunScript(agent).tools, ...(agent.scriptTools ?? [])])
            hash.update(JSON.stringify([tool.id, tool.description, tool.jsonSchema]));
    }
    return hash.digest("hex").slice(0, 16);
}

function synthesisOf(evalCase: EvalCase): NonNullable<EvalCase["synthesis"]> {
    if (evalCase.synthesis === undefined) throw new Error(`the synthesis case ${evalCase.id} has no summaries`);
    return evalCase.synthesis;
}

/** The first message of a synthesis case, as the run gives it. */
function synthesisSeedOf(evalCase: EvalCase): string {
    const { narrative, summaries } = synthesisOf(evalCase);
    return synthesizerSeedOf(narrative, summaries);
}

function replyText(messages: readonly LoopMessage[]): string {
    const parts: string[] = [];
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        if (typeof message.content === "string") parts.push(message.content);
        else for (const part of message.content) if (part.type === "text") parts.push(part.text);
    }
    return parts.join("\n").trim();
}

function runningRow(run: RunningRun): CortexRunRow {
    return {
        runId: run.runId,
        analysisId: ANALYSIS_ID,
        threadId: null,
        workflowName: "execute-analysis",
        status: "running",
        startedAt: run.startedAt,
        completedAt: null,
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateId: null,
        planId: run.planId ?? null,
    };
}

function workingMemoryOf(render: string): WorkingMemoryStore {
    const unused = (): never => {
        throw new Error("an eval turn only renders the working memory");
    };
    return { load: unused, updateSection: unused, render: () => okAsync(render) };
}

/**
 * The input of a turn. A chat turn gives the sanitized user message, then the context records that the harness adds
 * (`app/chat-turn.ts`); a report thread reads no working memory. A planner and an analogical reasoner get their seed
 * alone, as `generate_plan` and `generate_analogy_report` give it.
 */
export async function turnInputOf(evalCase: EvalCase, history: readonly LoopMessage[]): Promise<LoopMessage[]> {
    const kind = evalCase.agent ?? "conversation";
    if (kind === "planner" || kind === "planner-knowledge" || kind === "analogy" || kind === "sandbox") return [{ role: "user", content: evalCase.user }];
    if (kind === "synthesis") return [{ role: "user", content: synthesisSeedOf(evalCase) }];
    const state = evalCase.state ?? {};
    const runs = (state.runningRuns ?? []).map(runningRow);
    const records = await contextRecordsFor(
        {
            threadType: kind,
            analysisId: ANALYSIS_ID,
            analysisContext: state.analysisContext ?? null,
            runActivityContext: renderRunActivity({ runs, total: runs.length }),
            workingMemory: workingMemoryOf(state.workingMemory ?? ""),
        },
        history,
    );
    return [sanitizedUserMessage(evalCase.user), ...records];
}

/** A logger that keeps each warning and each error, thus a trial can say why a follow-up gave nothing. */
function recordingLogger(records: string[]): Logger {
    const keep = (msg: string, fields?: Record<string, unknown>): void => {
        records.push(fields === undefined ? msg : `${msg} ${JSON.stringify(fields)}`);
    };
    const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: keep,
        error: keep,
        with: () => logger,
        named: () => logger,
        errorFields: defaultErrorFields,
    };
    return logger;
}

/** A store of the cut texts of tool results, for `read_tool_output`, that lives for one trial. */
function memoryToolOutputStore(): ToolOutputStore {
    const kept = new Map<string, KeptToolOutput>();
    return {
        put: (output) => {
            kept.set(`${output.analysisId}/${output.ref}`, output);
            return okAsync(undefined);
        },
        get: (analysisId, ref) => okAsync(kept.get(`${analysisId}/${ref}`) ?? null),
    };
}

/** The agent of a trial. A sandbox case gets its own tree, which the trial disposes of at its end. */
async function trialAgentOf(
    evalCase: EvalCase,
    agents: RunOptions["agents"],
    exposure: ToolExposure,
    store: ToolOutputStore,
    record: ScriptToolCall[],
): Promise<{ readonly agent: AgentDefinition; readonly sandbox?: SandboxTrial }> {
    const kind = evalCase.agent ?? "conversation";
    const scripted = (agent: AgentDefinition): AgentDefinition => withScriptedTools(exposed(agent, exposure), evalCase.tools ?? {}, record);
    if (kind === "synthesis") return { agent: scripted(synthesisAgent(synthesisOf(evalCase).summaries)) };
    if (kind === "planner" || kind === "planner-knowledge") return { agent: scripted(plannerTrialAgent(evalCase.pool ?? [], kind === "planner-knowledge")) };
    if (kind !== "sandbox") return { agent: scripted(agents[kind]) };
    if (evalCase.sandbox === undefined) throw new Error(`the sandbox case ${evalCase.id} has no sandbox setup`);
    const sandbox = await openSandboxTrial(evalCase.sandbox, { toolOutputStore: store, label: evalCase.id });
    return { agent: withSandboxScripts(exposed(sandbox.agent, exposure), evalCase.tools ?? {}), sandbox };
}

export async function runTrial(
    evalCase: EvalCase,
    options: Pick<RunOptions, "agents" | "provider" | "sandboxProvider" | "trialTimeoutMs" | "exposure">,
): Promise<TrialResult> {
    const history = evalCase.history ?? [];
    const store = memoryToolOutputStore();
    let sandbox: SandboxTrial | undefined;
    try {
        const record: ScriptToolCall[] = [];
        const built = await trialAgentOf(evalCase, options.agents, options.exposure ?? "base", store, record);
        const { agent } = built;
        sandbox = built.sandbox;
        const asks: TrialAsk[] = [];
        const decision = evalCase.approve ?? "approve";
        // A step agent declares the output tool of its file-metadata request from the first request, and the task
        // masks it; a blocker ends the step. Both as `sandbox-step.ts` runs the task.
        const stepRules =
            sandbox === undefined
                ? {}
                : {
                      policy: {
                          mask: maskExcept(
                              withRunScript(agent).tools.map((tool) => tool.id),
                              [SUBMIT_FILE_METADATA_TOOL_ID],
                          ),
                      },
                      toolOutputStore: store,
                  };
        // A script emits a `tool-started` frame for each of its calls, with the input, one level below its call.
        const scriptCalls = new Map<string, Array<{ tool: string; input: unknown; value?: unknown }>>();
        const emit: EmitFn = (event) => {
            if (event.type !== "tool-started" || event.source.agentId !== RUN_SCRIPT_TOOL_ID || event.source.invocationId === undefined) return;
            const calls = scriptCalls.get(event.source.invocationId) ?? [];
            calls.push({ tool: event.name, input: event.input });
            scriptCalls.set(event.source.invocationId, calls);
        };
        const stop = (steps: readonly LoopStep[]): boolean => steps.length >= evalCase.maxSteps || (sandbox !== undefined && blockerOf(steps) !== null);
        const turnInput = sandbox?.seed === undefined ? await turnInputOf(evalCase, history) : [{ role: "user" as const, content: sandbox.seed }];
        // A summary-only case gives the transcript of the task as its history, thus the loop of the task does not run.
        // A compaction case runs the exchange that the loop of a chat turn runs at its budget, after the turn input.
        const compacted =
            evalCase.compact === true
                ? await continueLoop(
                      agent,
                      [...history, ...turnInput],
                      {
                          text: MEMORY_COMPACTION_REQUEST,
                          mask: { allow: ["update_working_memory"] },
                          maxRequests: COMPACTION_MAX_REQUESTS,
                          endOnRequestRefusal: true,
                      },
                      makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_ID } }),
                      { provider: options.provider, signal: AbortSignal.timeout(Math.max(evalCase.timeoutMs ?? 0, options.trialTimeoutMs)), emit },
                  )
                : undefined;
        const result =
            compacted !== undefined
                ? { ...compacted, messages: [...history, ...compacted.messages] }
                : evalCase.summary === "only"
                  ? { messages: [...turnInput, ...history], steps: [] as LoopStep[], finish: { reason: "stop", usage: undefined } }
                  : await runLoop(agent, history, makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_ID } }), {
                        provider: sandbox === undefined ? options.provider : (options.sandboxProvider ?? options.provider),
                        signal: AbortSignal.timeout(Math.max(evalCase.timeoutMs ?? 0, options.trialTimeoutMs)),
                        emit,
                        turnInput,
                        stopWhen: stop,
                        approve: (request, call) => {
                            asks.push({ tool: call.toolName, command: request.command });
                            return Promise.resolve(decision === "approve" ? { kind: "approved" } : { kind: "denied" });
                        },
                        ...stepRules,
                    });
        // A trial that its time bound stopped measured the provider, not a decision. A stalled proxy stops each trial with no reply.
        if (result.finish.reason === "aborted") return { kind: "error", error: `the trial reached its time bound after ${result.steps.length} steps` };
        const text = replyText(result.messages.slice(history.length));
        const summaryRecords: string[] = [];
        const summaryLogger = recordingLogger(summaryRecords);
        const summaryWanted = sandbox !== undefined && evalCase.summary !== undefined && evalCase.summary !== false;
        const artifacts =
            sandbox === undefined ? [] : Object.entries(sandbox.files()).filter(([path]) => path.startsWith("output/") || path.startsWith("figures/"));
        const summarySession = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_ID } });
        const summarySignal = AbortSignal.timeout(Math.max(evalCase.timeoutMs ?? 0, options.trialTimeoutMs));
        // The step workflow asks for the file metadata first, and the summary continues after that exchange.
        const metadata =
            summaryWanted && sandbox?.fileMetadata !== undefined && artifacts.length > 0
                ? await generateFileMetadata({
                      provider: options.sandboxProvider ?? options.provider,
                      session: summarySession,
                      agent,
                      cell: sandbox.fileMetadata,
                      transcript: result.messages,
                      artifacts: artifacts.map(([path, text]) => ({
                          dbPath: `runs/run-001/${evalCase.sandbox?.stepId ?? "step"}/${path}`,
                          displayPath: path,
                          sizeBytes: Buffer.byteLength(text),
                      })),
                      resourceId: ANALYSIS_ID,
                      toolOutputStore: store,
                      logger: summaryLogger,
                      signal: summarySignal,
                  })
                : undefined;
        const summary = summaryWanted
            ? await generateStepSummary({
                  provider: options.sandboxProvider ?? options.provider,
                  session: summarySession,
                  agent,
                  conversation: [...result.messages, ...(metadata?.messages ?? [])],
                  artifactPaths: artifacts.map(([path]) => path),
                  stepId: evalCase.sandbox?.stepId ?? "step",
                  agentId: agent.id,
                  runId: "run-001",
                  toolOutputStore: store,
                  logger: summaryLogger,
                  signal: summarySignal,
              })
            : undefined;
        // A frame of a nested call has no input. Each script tool records its input, in the order of the calls.
        const pending = [...record];
        for (const calls of scriptCalls.values()) {
            for (const [i, call] of calls.entries()) {
                if (call.input !== undefined) continue;
                const at = pending.findIndex((entry) => entry.tool === call.tool);
                if (at === -1) continue;
                calls[i] = { tool: call.tool, input: pending[at]?.input, value: pending[at]?.value };
                pending.splice(at, 1);
            }
        }
        const trial = trialOf(result.steps, asks, text, result.finish.reason, {
            summary: summary?.markdown,
            summaryError: summaryRecords.length === 0 ? undefined : summaryRecords.join("; "),
            maxSteps: evalCase.maxSteps,
            files: sandbox?.files(),
            unscripted: sandbox?.unscripted,
            scriptCalls,
        });
        const grade = evalCase.grade(trial);
        return {
            kind: "graded",
            ...grade,
            calls: trial.calls,
            asks,
            text,
            finishReason: trial.finishReason,
            stepFinishes: trial.stepFinishes,
            capped: trial.capped,
            files: trial.files === undefined ? undefined : Object.keys(trial.files),
            unscripted: trial.unscripted === undefined || trial.unscripted.length === 0 ? undefined : [...trial.unscripted],
            summary: trial.summary,
            summaryError: trial.summaryError,
            usage: result.finish.usage,
        };
    } catch (cause) {
        return { kind: "error", error: errorMessageOf(cause) ?? "the trial failed with no message" };
    } finally {
        sandbox?.dispose();
    }
}

/** Run each case `trials` times. The results keep the order of the cases. */
export async function runCases(cases: readonly EvalCase[], options: RunOptions): Promise<Map<string, TrialResult[]>> {
    const results = new Map<string, TrialResult[]>(cases.map((evalCase) => [evalCase.id, []]));
    const tasks = cases.flatMap((evalCase) =>
        Array.from({ length: options.trials }, () => async (): Promise<void> => {
            const result = await runTrial(evalCase, options);
            results.get(evalCase.id)?.push(result);
            options.onTrial?.(evalCase, result);
        }),
    );
    await allWithConcurrency(tasks, options.concurrency);
    return results;
}
