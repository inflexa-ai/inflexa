/**
 * Per-step interpretive markdown summary — a focused `runAgent` tool-loop on
 * the harness `ChatProvider` that consumes the step's in-memory transcript
 * (the `runAgent` `messages` array the workflow body already holds) AND a
 * scoped `read_file` so it grounds every quantitative claim in the persisted
 * output files rather than confabulating from `execute_command` stdout.
 *
 * Contract:
 *   - `runAgent` loop with a single `read_file` tool scoped to the step's
 *     writable output tree (via `createReadFileTool(workspaceFs, workingDir)`).
 *     The summarizer reads any output file it needs, then emits the markdown
 *     summary as its final assistant text.
 *   - Returns `{ stepId, agentId, markdown }` on non-empty final text;
 *     `undefined` on empty/empty-after-trim, on a loop throw, or on no
 *     text in the final assistant turn. Non-fatal — the workflow body decides
 *     whether to write `output/summary.md`.
 *   - `Session` is taken explicitly (see the harness-durable-runtime spec).
 *
 * Honest empty: with no output artifacts the prompt directs the model to
 * state plainly that the step produced no output files — no synthesized
 * results. Blocked steps skip this producer entirely (handled upstream).
 *
 * Transcript-from-memory: per the harness-thread-store spec, workflow loops have no `messages`
 * table; reconstruction from `operation_outputs` is read-side only. At
 * step time the workflow body already holds the array — pass it in.
 */

import type { AgentSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import { finalText, runAgent, type RunAgentResult } from "../loop/run-agent.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, LoopMessage } from "../loop/types.js";
import type { AgentChat } from "../providers/types.js";
import { stepSummaryPrompt } from "../prompts/execute-analysis/step-summary.js";
import { composeSystemPrompt } from "../agents/system-prompt.js";
import { createReadFileTool } from "../tools/workspace/read-file.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { StepSummarySchema, type StepSummary } from "../schemas/step-summary.js";

import { incrementSummaryNullCount } from "./step-summary-metrics.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";

const SYSTEM_PROMPT = `You are a sandbox agent writing a post-step interpretive summary of work you just completed.

Your prior conversation — tool calls, code output, intermediate results — is in the message history above. Use it for narrative and intent.

Ground every quantitative claim in a PERSISTED output file: open it with the read_file tool and report what the file actually contains. A number that appears only in command stdout is NOT a citable result — read the artifact that holds it. If there are no output files, say so plainly; do not invent numbers and do not synthesize results no artifact backs.

When finished, output ONLY the markdown summary as your final message — no preamble, no apologies, no tool calls.`;

/** Sub-agent identity for the summary loop — provenance only. */
const SUMMARY_AGENT_ID = "step-summary-writer";

/** Iteration budget: a handful of read_file reads plus the final write-up. */
const DEFAULT_MAX_ITERATIONS = 12;

export interface GenerateStepSummaryOptions {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly provider: AgentChat;
    readonly session: AgentSession;
    readonly modelId: string;
    /** In-memory transcript from `runAgent` — assistant + tool-result rounds. */
    readonly messages: readonly LoopMessage[];
    readonly artifactPaths: readonly string[];
    /** Workspace read seam — backs the scoped `read_file` tool. */
    readonly workspaceFs: WorkspaceFilesystem;
    /** Absolute host path to the step's writable output tree — `read_file`'s working dir. */
    readonly workingDir: string;
    readonly stepId: string;
    readonly agentId: string;
    readonly runId: string;
    readonly maxIterations?: number;
    readonly signal?: AbortSignal;
}

/**
 * Sanitize a transcript that came from the loop so it can prefix a fresh
 * loop turn: any final assistant `tool_use` block needs a matching
 * `tool_result` we are not going to produce. Drop the trailing partial round.
 */
function sanitizeTranscript(messages: readonly LoopMessage[]): LoopMessage[] {
    const out: LoopMessage[] = [...messages];
    while (out.length > 0) {
        const last = out[out.length - 1]!;
        const blocks = Array.isArray(last.content) ? last.content : [];
        const hasOpenToolUse = last.role === "assistant" && blocks.some((b) => b.type === "tool-call");
        if (hasOpenToolUse) {
            out.pop();
            continue;
        }
        break;
    }
    return out;
}

/**
 * Run the post-step summary loop on the harness provider against the supplied
 * transcript, grounding claims in persisted files via `read_file`. Returns
 * `undefined` on any non-fatal failure mode; the workflow body proceeds
 * without `summary.md` in that case.
 */
export async function generateStepSummary(opts: GenerateStepSummaryOptions): Promise<StepSummary | undefined> {
    const logger = (opts.logger ?? createNoopLogger()).named("step-summary").with({ runId: opts.runId, stepId: opts.stepId, agentId: opts.agentId });
    const transcript = sanitizeTranscript(opts.messages);
    const userPrompt = stepSummaryPrompt(opts.artifactPaths.join("\n"));

    const writer: AgentDefinition = {
        id: SUMMARY_AGENT_ID,
        systemPrompt: composeSystemPrompt(SYSTEM_PROMPT),
        model: opts.modelId,
        tools: [createReadFileTool(opts.workspaceFs, opts.workingDir)],
        maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    };

    const abortController = opts.signal ? undefined : new AbortController();
    const signal = abortController ? abortController.signal : opts.signal;

    let result: RunAgentResult;
    try {
        result = await runAgent(writer, [...transcript, { role: "user", content: userPrompt }], forSubAgent(opts.session, SUMMARY_AGENT_ID), {
            provider: opts.provider,
            signal,
            emit: () => {},
            runStep: passthroughStep,
        });
    } catch (err) {
        logger.warn("summary loop failed", logger.errorFields(err));
        incrementSummaryNullCount(opts.agentId, "throw");
        return undefined;
    } finally {
        abortController?.abort();
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
