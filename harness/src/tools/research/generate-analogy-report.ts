/**
 * generateAnalogyReport — cross-domain analogy report as a sub-agent tool.
 *
 * An inline harness `AgentDefinition` driven by `runWithSalvage`. The reasoner records its report in parts: the
 * problem with its planned analogies, then each analogy when its search is done. A provider filter can stop a reply in
 * the middle of a call, and a cut call is lost whole, thus a small part loses little. The wrapper assembles the report
 * from the last accepted record of each part, else it gives the first blocker. A run with no outcome gets one salvage
 * request, then an `extraction-failed` envelope, so the frontend never renders raw prose.
 */

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { ok } from "neverthrow";
import { z } from "zod";

import {
    AnalogyProblemSchema,
    AnalogySchema,
    type AnalogicalReasonerOutput,
    type Analogy,
    type AnalogyReport,
} from "@inflexa-ai/harness/contracts/analogy-report.js";

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
import type { ScriptRuntime } from "../script/run-script.js";
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
    "You ended without a terminal outcome. Record the problem with record_problem and each analogy with " +
    "record_analogy now, or call report_blocker if phase 1 cannot run. Do not reply with prose.";

const RECORD_PROBLEM_TOOL_ID = "record_problem";
const RECORD_ANALOGY_TOOL_ID = "record_analogy";

const RecordProblemInputSchema = AnalogyProblemSchema.extend({
    plannedAnalogies: z
        .array(z.object({ analogyTitle: z.string(), targetDomain: z.string() }))
        .min(1)
        .describe("Each analogy of phase 1. An analogy that gets no record_analogy call arrives in the report as not loaded."),
});

function createRecordProblemTool(): Tool {
    return defineTool({
        id: RECORD_PROBLEM_TOOL_ID,
        description:
            "Record the extraction of phase 1: the problem summary, objects, relations, key terms, and the analogies " +
            "that phase 2 searches. A later call replaces the record.",
        inputSchema: RecordProblemInputSchema,
        describeCall: "none",
        execute: () => Promise.resolve(ok({ recorded: true as const })),
    });
}

function createRecordAnalogyTool(): Tool {
    return defineTool({
        id: RECORD_ANALOGY_TOOL_ID,
        description:
            "Record one analogy with its coverage and its cited solutions, when its search is done. A later call " +
            "with the same analogyTitle replaces the record.",
        inputSchema: AnalogySchema,
        describeCall: ({ analogyTitle }) => analogyTitle,
        execute: () => Promise.resolve(ok({ recorded: true as const })),
    });
}

/** The parts that a run recorded: the last accepted problem, and the last accepted record of each analogy title. */
function recordedParts(steps: readonly LoopStep[]): { problem?: z.infer<typeof RecordProblemInputSchema>; analogies: Map<string, Analogy> } {
    let problem: z.infer<typeof RecordProblemInputSchema> | undefined;
    const analogies = new Map<string, Analogy>();
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.output?.outcome !== "ok") continue;
            if (call.toolName === RECORD_PROBLEM_TOOL_ID) problem = recordedInputOf(RecordProblemInputSchema, call.input) ?? problem;
            if (call.toolName === RECORD_ANALOGY_TOOL_ID) {
                const analogy = recordedInputOf(AnalogySchema, call.input);
                if (analogy !== undefined) analogies.set(analogy.analogyTitle, analogy);
            }
        }
    }
    return { problem, analogies };
}

/**
 * The report that a run recorded, or nothing when it recorded no problem. The analogies keep the planned order, and a
 * recorded analogy that the plan does not name follows them. A planned analogy with no record is not loaded.
 */
export function assembledReportOf(steps: readonly LoopStep[]): AnalogyReport | undefined {
    const { problem, analogies } = recordedParts(steps);
    if (problem === undefined) return undefined;
    const { plannedAnalogies, ...extraction } = problem;
    const planned = plannedAnalogies.map(
        (plan): Analogy =>
            analogies.get(plan.analogyTitle) ?? {
                targetDomain: plan.targetDomain,
                analogyTitle: plan.analogyTitle,
                objectMappings: [],
                sharedRelations: "",
                coverage: "not_loaded",
                solutions: [],
            },
    );
    const titles = new Set(plannedAnalogies.map((plan) => plan.analogyTitle));
    const extra = [...analogies.values()].filter((analogy) => !titles.has(analogy.analogyTitle));
    return { schemaVersion: "1", ...extraction, analogies: [...planned, ...extra] };
}

/** The run recorded the problem and each analogy that it planned, thus nothing is left to record. */
function everyPartRecorded(steps: readonly LoopStep[]): boolean {
    const { problem, analogies } = recordedParts(steps);
    return problem !== undefined && problem.plannedAnalogies.every((plan) => analogies.has(plan.analogyTitle));
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
    /** Where the VM of `run_script` comes from. See {@link ScriptRuntime}. */
    readonly scriptRuntime?: ScriptRuntime;
};

/** Build the `generate_analogy_report` delegation tool bound to its provider. */
/** The analogical reasoner: its searches run in a script, and it records its report and a blocker directly. */
export function analogyAgentOf(deps: Pick<GenerateAnalogyReportDeps, "bioKeys" | "model" | "toolOutputStore" | "scriptRuntime">): AgentDefinition {
    const ncbi = createNcbiTools(deps.bioKeys);
    return {
        id: AGENT_ID,
        systemPrompt: composeSystemPrompt(analogicalReasonerPrompt),
        model: deps.model,
        // The order and the definitions of the tools stay fixed across calls so the cache-keyed prefix holds.
        tools: [
            ...(deps.toolOutputStore ? [createReadToolOutputTool(deps.toolOutputStore)] : []),
            createRecordProblemTool(),
            createRecordAnalogyTool(),
            createAnalogyBlockerTool(),
        ],
        scriptTools: [
            createSearchSemanticScholarTool({ apiKey: deps.bioKeys.semanticScholar }),
            searchArxivTool,
            createSearchGithubReposTool({ githubToken: deps.bioKeys.github }),
            ncbi.pubmed,
        ],
        scriptRuntime: deps.scriptRuntime,
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
                    // The run ends when each planned analogy has a record, because the wrapper reads no prose.
                    stopWhen: everyPartRecorded,
                },
                {
                    tools: [RECORD_PROBLEM_TOOL_ID, RECORD_ANALOGY_TOOL_ID, REPORT_BLOCKER_TOOL_ID],
                    nudge: ANALOGY_SALVAGE_NUDGE,
                    hasOutcome: (done) => assembledReportOf(done) !== undefined || blockerOf(done) !== null,
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
        const report = assembledReportOf(steps);
        if (report !== undefined) return report;
        const blocker = blockerOf(steps);
        if (blocker !== null) return { schemaVersion: "1", error: { kind: "extraction-failed", message: blocker.reason } };
        if (steps.some((step) => step.finishReason === "content-filter")) {
            logger.warn("the content filter of the provider stopped the analogical reasoner", { steps: steps.length });
            return {
                schemaVersion: "1",
                error: {
                    kind: "extraction-failed",
                    message:
                        "The content filter of the model provider stopped the reasoner before it recorded the problem. A different wording of the problem can pass the filter.",
                },
            };
        }
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
