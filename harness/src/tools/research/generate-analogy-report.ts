/**
 * generateAnalogyReport — cross-domain analogy report as a sub-agent tool.
 *
 * An inline harness `AgentDefinition` (mirroring `createLiteratureReviewerTool`)
 * driven by `runToTerminal`. The result reaches the wrapper through one of two
 * terminal tools because the output envelope is a union and `defineTool` takes
 * only a top-level object. A run with no outcome gets one salvage continuation,
 * then an `extraction-failed` envelope, so the frontend never renders raw prose.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { AnalogyReportSchema, type AnalogicalReasonerOutput, type AnalogyReport } from "@inflexa-ai/harness/contracts/analogy-report.js";

import { analogicalReasonerPrompt } from "../../prompts/analogical-reasoner.js";
import { composeSystemPrompt } from "../../agents/system-prompt.js";
import { forSubAgent } from "../../auth/types.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { passthroughStep } from "../../loop/run-step.js";
import { runToTerminal } from "../../loop/run-to-terminal.js";
import type { AgentDefinition } from "../../loop/types.js";
import type { ChatProvider } from "../../providers/types.js";
import type { UsageRecorder } from "../../billing/usage-recorder.js";
import { defineTool, type Tool } from "../define-tool.js";
import { createReportBlockerToolFor, type BlockerOutcome } from "../sandbox/report-blocker.js";

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

type AnalogyOutcome = { readonly kind: "report"; readonly report: AnalogyReport } | BlockerOutcome;

interface AnalogyOutcomeCell {
    outcome: AnalogyOutcome | null;
}

function createSubmitAnalogyReportTool(cell: AnalogyOutcomeCell): Tool {
    return defineTool({
        id: "submit_analogy_report",
        description:
            "Terminal. Submit the analogy report: the problem summary, objects, " +
            "relations, and key terms of phase 1, and each analogy with its " +
            "coverage and its cited solutions from phase 2. Call it one time with " +
            "the full report. If it rejects the report, correct the fields that it " +
            "names and call it again. Stop immediately after an accepted call.",
        inputSchema: AnalogyReportSchema,
        describeCall: "none",
        execute: async (report) => {
            // A report replaces a blocker, thus the report wins when one round records both.
            cell.outcome = { kind: "report", report };
            return ok({
                recorded: true as const,
                message: "Report recorded. You are done — stop now and do not take further actions.",
            });
        },
    });
}

function createAnalogyBlockerTool(cell: AnalogyOutcomeCell): Tool {
    return createReportBlockerToolFor({
        // A blocker never replaces a recorded outcome, thus it never replaces a report.
        record: (outcome) => {
            if (cell.outcome === null) cell.outcome = outcome;
        },
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

export interface GenerateAnalogyReportDeps {
    /** The LLM seam the child loop runs on. */
    readonly provider: ChatProvider;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /** API keys for the bio/chem + GitHub data sources the reasoner searches. */
    readonly bioKeys: BioToolKeys;
    /** LLM usage-accounting seam for the child loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** Logging seam; omitted falls back to no-op. Logs the salvage warning and an accounting error of the reasoner loop. */
    readonly logger?: Logger;
}

/** Build the `generate_analogy_report` delegation tool bound to its provider. */
export function createGenerateAnalogyReportTool(deps: GenerateAnalogyReportDeps): Tool {
    const logger = (deps.logger ?? createNoopLogger()).named("generate-analogy-report");
    const ncbi = createNcbiTools(deps.bioKeys);
    const searchTools: readonly Tool[] = [
        createSearchSemanticScholarTool({ ...(deps.bioKeys.semanticScholar === undefined ? {} : { apiKey: deps.bioKeys.semanticScholar }) }),
        searchArxivTool,
        createSearchGithubReposTool({ githubToken: deps.bioKeys.github }),
        ncbi.pubmed,
    ];
    const systemPrompt = composeSystemPrompt(analogicalReasonerPrompt);

    return defineTool({
        id: "generate_analogy_report",
        description:
            "Idea-generation engine. Extracts structural analogies for an open-ended " +
            "scientific problem and returns real, cited solutions from other fields " +
            "(control theory, ML, ecology, logistics, economics…).\n" +
            "WHEN: any exploratory or hypothesis-generation turn — 'what could we do " +
            "about X', 'what should we try', 'how could we approach this', 'we're " +
            "stuck', 'brainstorm ideas', 'are there precedents outside biology'. The " +
            "trigger is exploratory INTENT, not the words 'analogy' or 'cross-domain' " +
            "— users rarely name it, so infer it and reach for the tool proactively.\n" +
            "NOT for: in-domain literature review (use `pubmed` and the other " +
            "bio-lookup tools), single-gene factual lookup (use `search_gene`), or " +
            "execution-mode turns where the user just wants the next step done. It " +
            "drives a multi-step research sub-agent over live literature search, so " +
            "it is slow — never spend it on a fact you could look up.\n" +
            "RETURNS an AnalogyReport envelope the UI renders as an inline card. An " +
            "analogy the search could not fill carries a `coverage` tag " +
            "(`queried_no_data` | `search_failed` | `not_loaded`) with an empty " +
            "`solutions` array — informational, NOT an error. A top-level `error` " +
            "field means no report was produced: on `error.kind === " +
            '"extraction-failed"` do NOT retry with the same or a similar problem ' +
            "statement (the wrapper already salvaged the run one time — you would " +
            "burn latency on the same failure). Surface the message and ask the " +
            "user to narrow the problem.",
        inputSchema: generateAnalogyReportInputSchema,
        describeCall: "none",
        execute: async (input, ctx) => {
            const childSession = forSubAgent(ctx.session, AGENT_ID);

            // Each call builds fresh tool closures over its own cell. Their order and
            // definitions stay fixed across calls so the cache-keyed prefix holds.
            const cell: AnalogyOutcomeCell = { outcome: null };
            const submitReportTool = createSubmitAnalogyReportTool(cell);
            const blockerTool = createAnalogyBlockerTool(cell);
            const agent: AgentDefinition = {
                id: AGENT_ID,
                systemPrompt,
                model: deps.model,
                tools: [...searchTools, submitReportTool, blockerTool],
                maxIterations: RESEARCH_MAX_ITERATIONS,
            };

            try {
                await runToTerminal(
                    agent,
                    [{ role: "user", content: buildResearchPrompt(input) }],
                    childSession,
                    {
                        provider: deps.provider,
                        signal: ctx.signal,
                        emit: ctx.emit,
                        runStep: passthroughStep,
                        resolved: () => cell.outcome !== null,
                        logger,
                        usageRecorder: deps.usageRecorder,
                        // Fold the child's calls into the turn total the root loop reports.
                        turnUsage: ctx.turnUsage,
                        // Keeps the usage record keys of two parallel dispatches disjoint —
                        // same frame, same call path, same loop-local step names.
                        invocationId: ctx.invocationId,
                    },
                    { tools: [submitReportTool, blockerTool], nudge: ANALOGY_SALVAGE_NUDGE },
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok({
                    schemaVersion: "1",
                    error: {
                        kind: "extraction-failed",
                        message: `Analogy research failed: ${message}`.slice(0, 240),
                    },
                } satisfies AnalogicalReasonerOutput);
            }

            const outcome = cell.outcome;
            if (outcome?.kind === "report") return ok(outcome.report satisfies AnalogicalReasonerOutput);
            if (outcome?.kind === "blocker") {
                return ok({ schemaVersion: "1", error: { kind: "extraction-failed", message: outcome.reason } } satisfies AnalogicalReasonerOutput);
            }
            return ok(buildExtractionFailedEnvelope());
        },
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
