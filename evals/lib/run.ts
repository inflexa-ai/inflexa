/**
 * The runner: each case runs K trials through the real loop and the real
 * provider. All trials share one queue of fixed width, thus a run keeps its
 * throughput and stays under the rate limit of the provider.
 */

import { createHash } from "node:crypto";

import { allWithConcurrency } from "@inflexa-ai/harness/lib/async-utils.js";
import { makeSession } from "@inflexa-ai/harness/providers/__fixtures__/session.js";
import type { AgentRunUsage } from "@inflexa-ai/harness/loop/metrics.js";
import { runLoop } from "@inflexa-ai/harness/loop/run-loop.js";
import type { AgentDefinition, LoopMessage } from "@inflexa-ai/harness/loop/types.js";
import type { ChatProvider } from "@inflexa-ai/harness/providers/types.js";
import { errorMessageOf } from "@inflexa-ai/harness/lib/thrown.js";
import { withScriptedTools } from "./agent.js";
import { trialOf, userMessage, type EvalCase, type Grade, type TrialAsk, type TrialCall } from "./case.js";

export type TrialResult =
    | ({
          readonly kind: "graded";
          readonly calls: readonly TrialCall[];
          readonly asks: readonly TrialAsk[];
          readonly text: string;
          readonly finishReason: string;
          readonly usage?: AgentRunUsage;
      } & Grade)
    | { readonly kind: "error"; readonly error: string };

export type RunOptions = {
    readonly agent: AgentDefinition;
    readonly provider: ChatProvider;
    readonly trials: number;
    readonly concurrency: number;
    /** The bound of one trial, in milliseconds. */
    readonly trialTimeoutMs: number;
    /** Called when a trial ends, for progress output. */
    readonly onTrial?: (evalCase: EvalCase, result: TrialResult) => void;
};

/**
 * A digest of what the model sees before the turn: the system prompt and each
 * tool definition. Two runs with the same digest ran the same prompt variant.
 */
export function promptDigest(agent: AgentDefinition): string {
    const hash = createHash("sha256");
    hash.update(agent.systemPrompt);
    for (const tool of agent.tools) hash.update(JSON.stringify([tool.id, tool.description, tool.jsonSchema]));
    return hash.digest("hex").slice(0, 16);
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

export async function runTrial(evalCase: EvalCase, options: Pick<RunOptions, "agent" | "provider" | "trialTimeoutMs">): Promise<TrialResult> {
    const agent = withScriptedTools(options.agent, evalCase.tools ?? {});
    const history = evalCase.history ?? [];
    try {
        const asks: TrialAsk[] = [];
        const decision = evalCase.approve ?? "approve";
        const result = await runLoop(agent, history, makeSession(), {
            provider: options.provider,
            signal: AbortSignal.timeout(options.trialTimeoutMs),
            emit: () => undefined,
            turnInput: [userMessage(evalCase.user)],
            stopWhen: (steps) => steps.length >= evalCase.maxSteps,
            approve: (request, call) => {
                asks.push({ tool: call.toolName, command: request.command });
                return Promise.resolve(decision === "approve" ? { kind: "approved" } : { kind: "denied" });
            },
        });
        const text = replyText(result.messages.slice(history.length));
        const trial = trialOf(result.steps, asks, text, result.finish.reason);
        const grade = evalCase.grade(trial);
        return { kind: "graded", ...grade, calls: trial.calls, asks, text, finishReason: trial.finishReason, usage: result.finish.usage };
    } catch (cause) {
        return { kind: "error", error: errorMessageOf(cause) ?? "the trial failed with no message" };
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
