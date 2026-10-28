/**
 * generateAnalogyReport — cross-domain analogy report as a sub-agent tool.
 *
 * An inline harness `AgentDefinition` driven by `runWithSalvage`. The result reaches the wrapper through one of two
 * submit tools because the output envelope is a union and `defineTool` takes
 * only a top-level object. Neither tool ends the run: the wrapper selects the
 * last accepted report from the recorded calls, else the first blocker. A run
 * with no outcome gets one salvage request, then an `extraction-failed`
 * envelope, so the frontend never renders raw prose.
 */

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { ok } from "neverthrow";
import { z } from "zod";

import { AnalogyReportSchema, type AnalogicalReasonerOutput, type AnalogyReport } from "@inflexa-ai/harness/contracts/analogy-report.js";

import { analogicalReasonerPrompt } from "../../prompts/analogical-reasoner.js";
import { composeSystemPrompt } from "../../agents/system-prompt.js";
import { forSubAgent } from "../../auth/types.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { runWithSalvage, type LoopStep } from "../../loop/run-loop.js";
import type { SubAgentRegistrar } from "../../loop/sub-agent.js";
import { recordedInputOf } from "../../loop/tool-adapter.js";
import type { ToolOutputStore } from "../../loop/tool-output.js";
import type { AgentDefinition } from "../../loop/types.js";
import type { ChatProvider } from "../../providers/types.js";
import type { UsageRecorder } from "../../billing/usage-recorder.js";
import { defineTool, type Tool } from "../define-tool.js";
import { createReadToolOutputTool } from "../read-tool-output.js";
import { blockerOf, createReportBlockerToolFor, REPORT_BLOCKER_TOOL_ID } from "../sandbox/report-blocker.js";

// Cross-domain search tools the analogical-reasoner uses.
import { createSearchSemanticScholarTool } from "./search-semantic-scholar.js";
import { searchArxivTool } from "./search-arxiv.js";
import { createSearchGithubReposTool } from "./search-github-repos.js";

// Biology literature — reused for analogies that land back in biology.
import { createNcbiTools, type BioToolKeys } from "../bio/keys.js";

/** Sub-agent identity — appended to `callPath`, set as `agentId`. */
const AGENT_ID = "analogical-reasoner";

/** Tool-call budget for the inner research agent. */
const RESEARCH_MAX_ITERATIONS = 40;

const ANALOGY_SALVAGE_NUDGE =
    "You ended without a terminal outcome. Call submit_analogy_report with " +
    "your report now, or report_blocker if phase 1 cannot run. Do not reply " +
    "with prose.";

const SUBMIT_ANALOGY_REPORT_TOOL_ID = "submit_analogy_report";

function createSubmitAnalogyReportTool(): Tool {
    return defineTool({
        id: SUBMIT_ANALOGY_REPORT_TOOL_ID,
        description:
            "Submit the analogy report: the problem summary, objects, " +
            "relations, and key terms of phase 1, and each analogy with its " +
            "coverage and its cited solutions from phase 2. Call it one time with " +
            "the full report. If it rejects the report, correct the fields that it " +
            "names and call it again. The last accepted report is the result.",
        inputSchema: AnalogyReportSchema,
        describeCall: "none",
        execute: () => Promise.resolve(ok({ recorded: true as const, message: "Report recorded. Stop now." })),
    });
}

/** The last report of a run that its call accepted. The input schema of the tool checked it. */
export function acceptedReportOf(steps: readonly LoopStep[]): AnalogyReport | undefined {
    let accepted: AnalogyReport | undefined;
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.toolName !== SUBMIT_ANALOGY_REPORT_TOOL_ID || call.output?.outcome !== "ok") continue;
            accepted = recordedInputOf(AnalogyReportSchema, call.input) ?? accepted;
        }
    }
    return accepted;
}

function createAnalogyBlockerTool(): Tool {
    return createReportBlockerToolFor({
        blockedWhen:
            "Ends the analogy research with no report. Call it only when the " +
            "problem is empty or incoherent, thus phase 1 cannot extract its " +
            "objects and relations.",
    });
}

export const generateAnalogyReportInputSchema = z.object({
    problem: z
        .string()
        .min(1)
        .describe(
            "The scientific problem in natural language. The single most important " +
                "field — describes what the user is trying to do and the system-level " +
                "constraints. Keep it focused; the inner agent reads this verbatim.",
        ),
    context: z
        .string()
        .optional()
        .describe(
            "Optional supporting context: data profile excerpt, prior findings, " +
                "experimental design notes, user constraints. Keep under ~500 tokens. " +
                "Do NOT paste full files — the inner agent does not need them.",
        ),
    numDomains: z.number().int().min(2).max(5).optional().describe("How many cross-domain analogies to extract. Defaults to 3."),
    solutionsPerDomain: z.number().int().min(1).max(5).optional().describe("How many real, cited solutions to surface per analogy. Defaults to 3."),
    preferredDomains: z
        .array(z.string())
        .optional()
        .describe("Soft preferences for analogy domains (e.g., " + '`["control_theory", "ecology"]`). The agent treats these as hints, ' + "not constraints."),
    excludeDomains: z
        .array(z.string())
        .optional()
        .describe(
            "Hard exclusions — domains the agent must avoid. Use to force a " +
                'cross-domain search (e.g., `["biology"]` when the source problem is ' +
                "biological).",
        ),
});

export type GenerateAnalogyReportInput = z.infer<typeof generateAnalogyReportInputSchema>;

/**
 * Render the structured input as a brief that maps 1-to-1 to the
 * `analogical-reasoner` prompt's "Inputs you may see in the brief" section.
 * Exported for unit testing.
 */
export function buildResearchPrompt(input: GenerateAnalogyReportInput): string {
    const lines: string[] = ["## Problem", input.problem];

    if (input.context) {
        lines.push("", "## Context", input.context);
    }

    const knobs: string[] = [];
    if (input.numDomains !== undefined) {
        knobs.push(`- numDomains: ${input.numDomains}`);
    }
    if (input.solutionsPerDomain !== undefined) {
        knobs.push(`- solutionsPerDomain: ${input.solutionsPerDomain}`);
    }
    if (input.preferredDomains && input.preferredDomains.length > 0) {
        knobs.push(`- preferredDomains: ${input.preferredDomains.join(", ")}`);
    }
    if (input.excludeDomains && input.excludeDomains.length > 0) {
        knobs.push(`- excludeDomains: ${input.excludeDomains.join(", ")}`);
    }
    if (knobs.length > 0) {
        lines.push("", "## Knobs", ...knobs);
    }

    return lines.join("\n");
}

export type GenerateAnalogyReportDeps = {
    /** The LLM seam the child loop runs on. */
    readonly provider: ChatProvider;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /** API keys for the bio/chem + GitHub data sources the reasoner searches. */
    readonly bioKeys: BioToolKeys;
    /** LLM usage-accounting seam for the child loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The store of the child loop and of its read tool. */
    readonly toolOutputStore?: ToolOutputStore;
    /** Logging seam; omitted falls back to no-op. Logs the salvage warning and an accounting error of the reasoner loop. */
    readonly logger?: Logger;
};

/** Build the `generate_analogy_report` delegation tool bound to its provider. */
/** The analogical reasoner over its search tools, its submit tool, and its blocker tool. */
export function analogyAgentOf(deps: Pick<GenerateAnalogyReportDeps, "bioKeys" | "model" | "toolOutputStore">): AgentDefinition {
    const ncbi = createNcbiTools(deps.bioKeys);
    return {
        id: AGENT_ID,
        systemPrompt: composeSystemPrompt(analogicalReasonerPrompt),
        model: deps.model,
        // The order and the definitions of the tools stay fixed across calls so the cache-keyed prefix holds.
        tools: [
            createSearchSemanticScholarTool({ apiKey: deps.bioKeys.semanticScholar }),
            searchArxivTool,
            createSearchGithubReposTool({ githubToken: deps.bioKeys.github }),
            ncbi.pubmed,
            ...(deps.toolOutputStore ? [createReadToolOutputTool(deps.toolOutputStore)] : []),
            createSubmitAnalogyReportTool(),
            createAnalogyBlockerTool(),
        ],
        maxIterations: RESEARCH_MAX_ITERATIONS,
    };
}

export function createGenerateAnalogyReportTool(deps: GenerateAnalogyReportDeps, registerSubAgent: SubAgentRegistrar): Tool {
    const logger = (deps.logger ?? createNoopLogger()).named("generate-analogy-report");

    const research = registerSubAgent<GenerateAnalogyReportInput, AnalogicalReasonerOutput>(AGENT_ID, async ({ payload: input, ctx, loop }) => {
        const childSession = forSubAgent(ctx.session, AGENT_ID);
        const agent = analogyAgentOf(deps);

        let steps: readonly LoopStep[];
        try {
            const run = await runWithSalvage(
                agent,
                [{ role: "user", content: buildResearchPrompt(input) }],
                childSession,
                {
                    ...loop,
                    provider: deps.provider,
                    logger,
                    usageRecorder: deps.usageRecorder,
                    toolOutputStore: deps.toolOutputStore,
                },
                {
                    tools: [SUBMIT_ANALOGY_REPORT_TOOL_ID, REPORT_BLOCKER_TOOL_ID],
                    nudge: ANALOGY_SALVAGE_NUDGE,
                    hasOutcome: (done) => acceptedReportOf(done) !== undefined || blockerOf(done) !== null,
                },
            );
            steps = run.steps;
        } catch (err) {
            const message = errorMessageOf(err) ?? textOf(err);
            return {
                schemaVersion: "1",
                error: {
                    kind: "extraction-failed",
                    message: `Analogy research failed: ${message}`.slice(0, 240),
                },
            };
        }

        // A report wins over a blocker.
        const report = acceptedReportOf(steps);
        if (report !== undefined) return report;
        const blocker = blockerOf(steps);
        if (blocker !== null) return { schemaVersion: "1", error: { kind: "extraction-failed", message: blocker.reason } };
        return buildExtractionFailedEnvelope();
    });

    return defineTool({
        id: "generate_analogy_report",
        description:
            "Idea-generation engine. Extracts structural analogies for an open-ended " +
            "scientific problem and returns real, cited solutions from other fields " +
            "(control theory, ML, ecology, logistics, economics…).\n" +
            "WHEN: an exploratory or hypothesis-generation turn — the user asks how " +
            "to approach a problem, what to try, or whether precedents exist outside " +
            "biology. The intent decides, whether or not the user names analogy or " +
            "cross-domain search.\n" +
            "NOT for: in-domain literature review (use `pubmed` and the other " +
            "bio-lookup tools), single-gene factual lookup (use `search_gene`), or " +
            "execution-mode turns where the user just wants the next step done. It " +
            "drives a multi-step research sub-agent (up to 40 model turns) over live " +
            "literature search, so it is slow; a fact that one lookup answers does " +
            "not need it.\n" +
            "RETURNS an AnalogyReport envelope the UI renders as an inline card. An " +
            "analogy the search could not fill carries a `coverage` tag " +
            "(`queried_no_data` | `search_failed` | `not_loaded`) with an empty " +
            "`solutions` array — a partial result, not an error. A top-level `error` " +
            'field with `kind: "extraction-failed"` means no report was produced: the ' +
            "sub-agent found the problem empty or incoherent, failed, or ended with " +
            "no report after one corrective request. `error.message` gives the cause. " +
            "A retry with the same or a similar problem statement meets the same " +
            "failure, thus surface the message and ask the user to narrow the problem.",
        inputSchema: generateAnalogyReportInputSchema,
        describeCall: "none",
        startsWorkflow: true,
        execute: async (input, ctx) => ok(await research(input, ctx)),
    });
}

/** The envelope of a run that recorded no outcome, also after its salvage. */
function buildExtractionFailedEnvelope(): AnalogicalReasonerOutput {
    return {
        schemaVersion: "1",
        error: {
            kind: "extraction-failed",
            message: "The analogical reasoner submitted no report and no blocker, also after a corrective request. Try narrowing the problem statement.",
        },
    };
}
