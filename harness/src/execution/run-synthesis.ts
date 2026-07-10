/**
 * Run synthesizer — a single-shot agent loop driven through `runAgent`:
 *
 *   - `submit_synthesis`  — terminal: schema + semantic validation, captures
 *                            the outcome. Re-callable on rejection.
 *   - `report_blocker`    — terminal: the run produced nothing synthesizable.
 *   - `literature_reviewer` — research sub-agent exposed as a tool. The tool
 *                            re-uses `createLiteratureReviewerTool`; the
 *                            sub-agent loop's brief is the only context handed
 *                            across the boundary (forSubAgent semantics).
 *
 * Two deliverables on a happy path: `synthesis.json` written to the run dir
 * and a `data-run-synthesis` chat data part emitted via the `emit` callback
 * the dep wrapper provides (the wrapper forwards events to the parent
 * workflow's `"events"` stream).
 *
 * The dep wrapper handles failure semantics — if this function throws or
 * resolves with `{ kind: "failed" }`, the wrapper emits a synthesis-progress
 * `failed` part. We do not throw here for routine submitter rejections.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { writeFileWithinRoot } from "../lib/fs-helpers.js";

import { RunSynthesisSchema, type RunSynthesis } from "../schemas/run-synthesis.js";
import { synthesisAgentPrompt } from "../prompts/synthesis-agent.js";
import type { StepSummary } from "../schemas/step-summary.js";
import { runDir } from "../workspace/paths.js";

import { runToTerminal } from "../loop/run-to-terminal.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, ChatDataPart, EmitFn } from "../loop/types.js";
import type { ChatProvider } from "../providers/types.js";
import type { RunSession } from "../auth/types.js";
import { defineTool, type Tool, type ToolError } from "../tools/define-tool.js";
import { createLiteratureReviewerTool } from "../tools/research/literature-reviewer.js";
import type { BioToolKeys } from "../tools/bio/keys.js";

// ── Agent identity / budgets ────────────────────────────────────────

const AGENT_ID = "run-synthesizer";

/**
 * Budget for the synthesizer loop: read summaries + 1–3 reviewer delegations
 * + draft + 1–2 submit/fix cycles + headroom.
 */
const SYNTHESIZER_MAX_ITERATIONS = 25;

// ── Types ────────────────────────────────────────────────────────────

interface ValidationIssue {
    readonly path: string;
    readonly code: "schema" | "semantic";
    readonly message: string;
    readonly hint?: string;
}

type SubmitSynthesisOutput = { accepted: true } | { accepted: false; issues: ValidationIssue[] };

type SynthesizerOutcome = { kind: "submitted"; synthesis: RunSynthesis } | { kind: "blocker"; reason: string };

/** Internal state passed to the inner tools through closure capture. */
interface InnerToolContext {
    /** stepIds present in the input summaries — used for reference checks. */
    readonly knownStepIds: ReadonlySet<string>;
    /** runId from the workflow — enforced on the submitted payload. */
    readonly runId: string;
}

interface OutcomeHolder {
    outcome: SynthesizerOutcome | null;
}

// ── Validation ──────────────────────────────────────────────────────

function zodIssuesToValidationIssues(error: z.ZodError, rootPath = "synthesis"): ValidationIssue[] {
    return error.issues.map((i) => ({
        path: [rootPath, ...i.path.map((p) => String(p))].join("."),
        code: "schema" as const,
        message: i.message,
    }));
}

function semanticCheck(synthesis: RunSynthesis, ctx: InnerToolContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (synthesis.runId !== ctx.runId) {
        issues.push({
            path: "synthesis.runId",
            code: "semantic",
            message: `runId must be "${ctx.runId}"`,
        });
    }

    for (const [i, f] of synthesis.findings.entries()) {
        if (!ctx.knownStepIds.has(f.stepId)) {
            issues.push({
                path: `synthesis.findings[${i}].stepId`,
                code: "semantic",
                message: `stepId "${f.stepId}" is not in the input summaries`,
                hint: `Known stepIds: ${Array.from(ctx.knownStepIds).join(", ")}`,
            });
        }
    }

    const findingKeys = new Set(synthesis.findings.map((f) => `${f.stepId}::${f.title}`));
    for (const [ti, t] of synthesis.themes.entries()) {
        for (const [fi, ref] of t.findings.entries()) {
            if (!findingKeys.has(`${ref.stepId}::${ref.title}`)) {
                issues.push({
                    path: `synthesis.themes[${ti}].findings[${fi}]`,
                    code: "semantic",
                    message: `theme reference (stepId="${ref.stepId}", title="${ref.title}") ` + `does not match any entry in findings[]`,
                });
            }
        }
    }

    const citedPmids = new Set(synthesis.findings.flatMap((f) => f.references.map((r) => r.pmid)));
    for (const [i, r] of synthesis.keyReferences.entries()) {
        if (!citedPmids.has(r.pmid)) {
            issues.push({
                path: `synthesis.keyReferences[${i}].pmid`,
                code: "semantic",
                message: `keyReferences pmid "${r.pmid}" does not appear in any finding.references[]`,
                hint: "Every keyReferences entry must already be cited by at least one finding.",
            });
        }
    }

    const pmidRe = /^\d+$/;
    for (const [fi, f] of synthesis.findings.entries()) {
        for (const [ri, r] of f.references.entries()) {
            if (!pmidRe.test(r.pmid)) {
                issues.push({
                    path: `synthesis.findings[${fi}].references[${ri}].pmid`,
                    code: "semantic",
                    message: `pmid "${r.pmid}" is not a valid numeric PMID`,
                });
            }
        }
    }
    for (const [i, r] of synthesis.keyReferences.entries()) {
        if (!pmidRe.test(r.pmid)) {
            issues.push({
                path: `synthesis.keyReferences[${i}].pmid`,
                code: "semantic",
                message: `pmid "${r.pmid}" is not a valid numeric PMID`,
            });
        }
    }

    return issues;
}

function fullyValidate(candidate: unknown, ctx: InnerToolContext): { valid: true; synthesis: RunSynthesis } | { valid: false; issues: ValidationIssue[] } {
    const parsed = RunSynthesisSchema.safeParse(candidate);
    if (!parsed.success) {
        return { valid: false, issues: zodIssuesToValidationIssues(parsed.error) };
    }
    const semanticIssues = semanticCheck(parsed.data, ctx);
    if (semanticIssues.length > 0) {
        return { valid: false, issues: semanticIssues };
    }
    return { valid: true, synthesis: parsed.data };
}

// ── Inner tools ─────────────────────────────────────────────────────

function buildSubmitTool(holder: OutcomeHolder, ctx: InnerToolContext): Tool {
    return defineTool({
        id: "submit_synthesis",
        description:
            "Submit the final synthesis. Re-validates payload against the schema " +
            "and semantic checks (stepId refs, theme→finding refs, keyReferences " +
            "PMIDs cited, numeric PMIDs). On success returns {accepted: true} — " +
            "STOP after this. On rejection returns {accepted: false, issues} — " +
            "fix the specific fields at each issue path and call again, or switch " +
            "to report_blocker if the synthesis cannot be made valid.",
        inputSchema: z.object({ synthesis: z.unknown() }),
        execute: async (input): Promise<Result<SubmitSynthesisOutput, ToolError>> => {
            if (holder.outcome !== null) {
                return ok({
                    accepted: false as const,
                    issues: [
                        {
                            path: "synthesis",
                            code: "semantic" as const,
                            message: "A terminal outcome has already been recorded; submit_synthesis " + "can only be called once per invocation.",
                        },
                    ],
                });
            }
            const result = fullyValidate(input.synthesis, ctx);
            if (!result.valid) {
                return ok({ accepted: false as const, issues: result.issues });
            }
            holder.outcome = { kind: "submitted", synthesis: result.synthesis };
            return ok({ accepted: true as const });
        },
    });
}

function buildBlockerTool(holder: OutcomeHolder): Tool {
    return defineTool({
        id: "report_blocker",
        description:
            "Terminal. Use when the run produced no synthesizable content (all " +
            "summaries empty, contradictory to the point of incoherence, or no " +
            "findings worth surfacing). Pass a short reason. Stop after calling.",
        inputSchema: z.object({ reason: z.string().min(1) }),
        execute: async (input) => {
            if (holder.outcome === null) {
                holder.outcome = { kind: "blocker", reason: input.reason };
            }
            return ok({ recorded: true as const });
        },
    });
}

/**
 * Test-only — expose the inner-tool factory so unit tests can assert on
 * validation + outcome capture without driving the whole agent loop.
 */
export function __buildInnerToolsForTest(args: { knownStepIds: ReadonlySet<string>; runId: string }): {
    submit: Tool;
    blocker: Tool;
    holder: OutcomeHolder;
} {
    const holder: OutcomeHolder = { outcome: null };
    const ctx: InnerToolContext = {
        knownStepIds: args.knownStepIds,
        runId: args.runId,
    };
    return {
        submit: buildSubmitTool(holder, ctx),
        blocker: buildBlockerTool(holder),
        holder,
    };
}

// ── Public API ──────────────────────────────────────────────────────

export interface GenerateRunSynthesisInput {
    readonly provider: ChatProvider;
    readonly session: RunSession;
    readonly model: string;
    /** API keys for the bio/chem tools the embedded literature reviewer uses. */
    readonly bioKeys: BioToolKeys;
    /** Step summaries from the completed run. Non-empty. */
    readonly summaries: readonly StepSummary[];
    /** Plan analytical narrative for context. */
    readonly planNarrative: string;
    /** Run id — submitted synthesis must match. */
    readonly runId: string;
    /** Optional cancellation. */
    readonly signal?: AbortSignal;
    /** Optional UI event sink (chat data parts forwarded to the parent stream). */
    readonly emit?: EmitFn;
}

export type GenerateRunSynthesisResult = { kind: "synthesis"; synthesis: RunSynthesis } | { kind: "skipped"; reason: string };

/**
 * Drive the synthesizer agent loop to a terminal outcome — either a
 * validated synthesis (`submit_synthesis`) or a blocker (`report_blocker`).
 * Throws when neither terminal is reached (loop cap or external abort).
 */
export async function generateRunSynthesis(input: GenerateRunSynthesisInput): Promise<GenerateRunSynthesisResult> {
    if (input.summaries.length === 0) {
        throw new Error("Run synthesis: no step summaries to synthesize");
    }

    const knownStepIds = new Set(input.summaries.map((s) => s.stepId));
    const holder: OutcomeHolder = { outcome: null };
    const innerCtx: InnerToolContext = { knownStepIds, runId: input.runId };
    const reviewer = createLiteratureReviewerTool({
        provider: input.provider,
        model: input.model,
        bioKeys: input.bioKeys,
    });

    const submitTool = buildSubmitTool(holder, innerCtx);
    const blockerTool = buildBlockerTool(holder);
    const tools: readonly Tool[] = [submitTool, blockerTool, reviewer];

    const agent: AgentDefinition = {
        id: AGENT_ID,
        systemPrompt: synthesisAgentPrompt,
        model: input.model,
        tools,
        maxIterations: SYNTHESIZER_MAX_ITERATIONS,
    };

    const prompt = buildSynthesizerPrompt(input.planNarrative, input.summaries, input.runId);

    const signal = input.signal ?? new AbortController().signal;
    const emit: EmitFn = input.emit ?? (() => {});

    const loopDeps = {
        provider: input.provider,
        signal,
        emit,
        runStep: passthroughStep,
    } as const;

    await runToTerminal(agent, [{ role: "user", content: prompt }], input.session, loopDeps, {
        resolved: () => holder.outcome !== null,
        tools: [submitTool, blockerTool],
        nudge:
            "You ended without calling a terminal tool. You MUST call " +
            "submit_synthesis with the final synthesis now, or report_blocker " +
            "if the run produced nothing synthesizable. Do not reply with prose.",
    });

    const outcome = holder.outcome;
    if (outcome?.kind === "submitted") {
        return { kind: "synthesis", synthesis: outcome.synthesis };
    }
    if (outcome?.kind === "blocker") {
        return { kind: "skipped", reason: outcome.reason };
    }
    if (signal.aborted) {
        throw new Error("Run synthesis was cancelled.");
    }
    throw new Error("Run synthesis completed without a terminal tool call — the synthesizer " + "did not call submit_synthesis or report_blocker.");
}

// ── Disk I/O — load summaries + persist synthesis ───────────────────

export interface LoadStepSummariesInput {
    /** Absolute host root of the analysis's workspace tree. */
    readonly workspaceRoot: string;
    readonly runId: string;
    readonly completedSteps: readonly string[];
    readonly agentByStepId?: Readonly<Record<string, string>>;
}

/**
 * Read each completed step's `output/summary.md`. Steps with missing or empty
 * summaries are silently dropped — the caller decides what to do when the
 * resulting array is empty.
 */
export async function loadStepSummariesFromDisk(args: LoadStepSummariesInput): Promise<StepSummary[]> {
    const out: StepSummary[] = [];
    for (const stepId of args.completedSteps) {
        const path = join(args.workspaceRoot, "runs", args.runId, stepId, "output", "summary.md");
        try {
            const markdown = await readFile(path, "utf8");
            if (markdown.trim().length === 0) continue;
            out.push({
                stepId,
                agentId: args.agentByStepId?.[stepId] ?? "scientific-executor",
                markdown,
            });
        } catch {
            // Missing summary — skip silently. Steps that produced no summary do
            // not contribute to synthesis.
        }
    }
    return out;
}

export interface PersistSynthesisInput {
    /** Absolute host root of the analysis's workspace tree. */
    readonly workspaceRoot: string;
    readonly runId: string;
    readonly synthesis: RunSynthesis;
}

export async function persistSynthesis(args: PersistSynthesisInput): Promise<string> {
    const path = join(args.workspaceRoot, runDir(args.runId), "synthesis.json");
    await writeFileWithinRoot(args.workspaceRoot, path, JSON.stringify(args.synthesis, null, 2));
    return path;
}

// ── Embedding text ──────────────────────────────────────────────────

export function formatSynthesisEmbeddingText(synthesis: RunSynthesis): string {
    return [
        "# Overview",
        synthesis.overview,
        "",
        "# Conclusions",
        synthesis.conclusions,
        "",
        "# Key Findings",
        ...synthesis.findings.flatMap((f) => [
            `## ${f.title} [${f.noveltyStatus}]`,
            f.description,
            f.literatureInterpretation,
            ...(f.references.length > 0 ? f.references.map((r) => `- [PMID:${r.pmid}] ${r.citation} (${r.concordance})`) : []),
            "",
        ]),
        "# Themes",
        ...synthesis.themes.flatMap((t) => [`## ${t.name}`, t.narrative, ""]),
        "# Limitations",
        ...synthesis.limitations.map((l) => `- ${l}`),
        "",
        "# Key References",
        ...synthesis.keyReferences.map((r) => `- [PMID:${r.pmid}] ${r.citation} — ${r.description}`),
    ].join("\n");
}

// ── Prompt builder ──────────────────────────────────────────────────

function buildSynthesizerPrompt(planNarrative: string, summaries: readonly StepSummary[], runId: string): string {
    const summaryBlock = summaries.map((s) => `### ${s.stepId} (${s.agentId})\n\n${s.markdown}`).join("\n\n---\n\n");

    return [`runId: "${runId}"`, "", "## Analytical Narrative", planNarrative, "", "## Step Summaries", summaryBlock].join("\n");
}

// ── Chat data part builders ─────────────────────────────────────────

/**
 * Build the `data-run-synthesis` chat part the parent stream emits when the
 * synthesizer completes successfully. The schema mirrors the harness's contracts
 * `RunSynthesisPart` interface — keep them in lockstep.
 */
export function buildRunSynthesisPart(runId: string, synthesis: RunSynthesis): ChatDataPart {
    return {
        type: "data-run-synthesis",
        data: {
            id: `synthesis-${runId}`,
            runId,
            overview: synthesis.overview,
            conclusions: synthesis.conclusions,
            findings: synthesis.findings,
            themes: synthesis.themes,
            limitations: synthesis.limitations,
            keyReferences: synthesis.keyReferences,
        },
    };
}
