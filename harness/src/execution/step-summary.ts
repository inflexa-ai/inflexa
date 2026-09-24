/**
 * Per-step interpretive summary. Continues the step agent's conversation
 * (`continueAgent`) so the request reuses the cached prefix and keeps
 * signed thinking blocks valid.
 *
 * Contract:
 *   - Sends the step agent's system prompt and tools, masked to `read_file`
 *     and `grep` in the step's output tree, and emits the markdown
 *     summary as its final assistant text.
 *   - Returns `{ stepId, agentId, markdown }` on non-empty final text;
 *     `undefined` on empty text, on a throw, or when the request cap is hit
 *     before a final answer (a continuation runs no wrap-up). Non-fatal.
 *   - `Session` is taken explicitly (see the harness-durable-runtime spec).
 *
 * Honest empty: with no output artifacts the request directs the model to
 * state plainly that the step produced no output files — no synthesized
 * results. Blocked steps skip this producer entirely (handled upstream).
 *
 * Transcript-from-memory: per the harness-thread-store spec, workflow loops have no `messages`
 * table; reconstruction from `operation_outputs` is read-side only. At
 * step time the workflow body already holds the array — pass it in. The task
 * always closes its unanswered calls, so the transcript needs no repair.
 */

import type { AgentSession } from "../auth/types.js";
import { continueAgent, type ContinuationResult } from "../loop/continue-agent.js";
import { finalText } from "../loop/run-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, LoopMessage } from "../loop/types.js";
import type { AgentChat } from "../providers/types.js";
import { stepSummaryPrompt } from "../prompts/execute-analysis/step-summary.js";
import { StepSummarySchema, type StepSummary } from "../schemas/step-summary.js";

import { incrementSummaryNullCount } from "./step-summary-metrics.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";

const SYSTEM_PROMPT = `You are a sandbox agent writing a post-step interpretive summary of work you just completed.

Your prior conversation — tool calls, code output, intermediate results — is in the message history above. Use it for narrative and intent.

Ground every quantitative claim in a PERSISTED output file: open it with the read_file tool and report what the file actually contains. A number that appears only in command stdout is NOT a citable result — read the artifact that holds it. If there are no output files, say so plainly; do not invent numbers and do not synthesize results no artifact backs.

When finished, write the markdown summary as your final message. It is stored as the step summary exactly as you write it.`;

const SUMMARY_AGENT_ID = "step-summary-writer";

/** A handful of read_file reads plus the final write-up. */
const SUMMARY_MAX_REQUESTS = 12;

/** Must already be declared tools of the step agent — the mask only narrows. */
const SUMMARY_TOOLS = ["read_file", "grep"];

function summaryRequest(artifactPaths: readonly string[]): string {
    return `${SYSTEM_PROMPT}\n\n${stepSummaryPrompt(artifactPaths.join("\n"))}`;
}

export interface GenerateStepSummaryOptions {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** LLM usage-accounting seam for the continuation; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The provider of the task, thus each request extends the prefix that the task cached. */
    readonly provider: AgentChat;
    readonly session: AgentSession;
    /** The step agent: the continuation sends its system prompt and its declared tools. */
    readonly agent: AgentDefinition;
    /** Task transcript, then the file-metadata exchange messages if one ran. */
    readonly conversation: readonly LoopMessage[];
    readonly artifactPaths: readonly string[];
    readonly stepId: string;
    readonly agentId: string;
    readonly runId: string;
    readonly signal?: AbortSignal;
}

/** Returns `undefined` on non-fatal failure instead of throwing. */
export async function generateStepSummary(opts: GenerateStepSummaryOptions): Promise<StepSummary | undefined> {
    const logger = (opts.logger ?? createNoopLogger()).named("step-summary").with({ runId: opts.runId, stepId: opts.stepId, agentId: opts.agentId });

    let result: ContinuationResult;
    try {
        result = await continueAgent(
            opts.agent,
            opts.conversation,
            {
                text: summaryRequest(opts.artifactPaths),
                mask: { allow: SUMMARY_TOOLS },
                maxRequests: SUMMARY_MAX_REQUESTS,
                stepNamespace: "step-summary",
                accountingAgentId: SUMMARY_AGENT_ID,
            },
            opts.session,
            {
                provider: opts.provider,
                signal: opts.signal ?? new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
                usageRecorder: opts.usageRecorder,
            },
        );
    } catch (err) {
        logger.warn("summary continuation failed", logger.errorFields(err));
        incrementSummaryNullCount(opts.agentId, "throw");
        return undefined;
    }

    const markdown = finalText(result.messages);
    if (!markdown || markdown.trim().length === 0) {
        logger.warn("empty markdown");
        incrementSummaryNullCount(opts.agentId, "empty");
        return undefined;
    }

    return StepSummarySchema.parse({
        stepId: opts.stepId,
        agentId: opts.agentId,
        markdown,
    });
}
