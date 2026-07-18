/**
 * Run synthesizer — a single-shot agent loop driven through `runAgent`:
 *
 *   - `validate_synthesis` — non-terminal: dry-run schema + semantic validation
 *                            of a candidate in any shape. Never records.
 *   - `submit_synthesis`  — terminal: schema + semantic validation, captures
 *                            the outcome. Re-callable; a later valid submission
 *                            supersedes an earlier outcome (last-valid-wins).
 *   - `report_blocker`    — terminal: the run produced nothing synthesizable.
 *                            Only records when no outcome exists yet, so a
 *                            blocker can never clobber a real synthesis.
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
import { hintForZodIssue } from "../lib/zod-issues.js";

import { RunSynthesisSchema, type RunSynthesis } from "../schemas/run-synthesis.js";
import { synthesisAgentPrompt } from "../prompts/synthesis-agent.js";
import { composeSystemPrompt } from "../agents/system-prompt.js";
import type { StepSummary } from "../schemas/step-summary.js";
import { runDir } from "../workspace/paths.js";

import { runToTerminal } from "../loop/run-to-terminal.js";
import { passthroughStep } from "../loop/run-step.js";
import type { AgentDefinition, ChatDataPart, EmitFn } from "../loop/types.js";
import type { ChatProvider } from "../providers/types.js";
import type { RunSession } from "../auth/types.js";
import { defineTool, type Tool, type ToolError } from "../tools/define-tool.js";
import { createReportBlockerToolFor } from "../tools/sandbox/report-blocker.js";
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

/**
 * Mutable cell the submit tool writes on every rejection from its semantic
 * re-validation — the stepId/theme-ref/PMID checks the arg schema cannot express.
 * The arg schema itself is enforced at the agent-loop boundary — which repairs a
 * markup-wrapped argument and re-validates it in full before dispatch — so what
 * arrives here always parses, and only the semantic checks can reject it. A
 * rejection is not terminal: submission is last-valid-wins, so a rejected call
 * leaves any recorded outcome intact and the model may fix the cited paths and
 * submit again. This therefore measures how hard the model had to work against the
 * semantic checks, not whether it eventually succeeded. Read after the loop to
 * diagnose a blocker's cause: zero here points to LLM misjudgment — it gave up
 * without the checks ever pushing back — and repeated rejections to a defensive
 * give-up against those checks. The deduped `issuePaths` name which fields the
 * model could not satisfy.
 */
interface RejectionTelemetry {
    rejections: number;
    readonly issuePaths: Set<string>;
}

// ── Validation ──────────────────────────────────────────────────────

function zodIssuesToValidationIssues(error: z.ZodError, input: unknown, rootPath = "synthesis"): ValidationIssue[] {
    return error.issues.map((i) => ({
        path: [rootPath, ...i.path.map((p) => String(p))].join("."),
        code: "schema" as const,
        message: i.message,
        hint: hintForZodIssue(i, input),
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
        return { valid: false, issues: zodIssuesToValidationIssues(parsed.error, candidate) };
    }
    const semanticIssues = semanticCheck(parsed.data, ctx);
    if (semanticIssues.length > 0) {
        return { valid: false, issues: semanticIssues };
    }
    return { valid: true, synthesis: parsed.data };
}

// ── Inner tools ─────────────────────────────────────────────────────

function buildValidateTool(ctx: InnerToolContext): Tool {
    return defineTool({
        id: "validate_synthesis",
        description:
            "Dry-run a candidate synthesis and get back everything that is wrong " +
            "with it. Takes the synthesis in ANY shape: a malformed, partial, or " +
            "wrong-typed candidate is REPORTED, not rejected. Returns " +
            "{valid, issues[]} covering both schema problems (missing / " +
            "wrong-typed fields) and the semantic checks a schema cannot express " +
            "(unknown stepId refs, theme→finding refs, keyReferences PMIDs not " +
            "cited by any finding, non-numeric PMIDs). The authoritative " +
            "field-by-field synthesis schema is the arg schema of " +
            "submit_synthesis — this tool deliberately does not restate it. " +
            "Non-terminal: call as often as needed to iterate toward a clean " +
            "synthesis, then submit_synthesis.",
        // Deliberately permissive: a structurally-invalid candidate must reach
        // `execute` so the model gets a structured {valid:false, issues} result —
        // including semantic issues — instead of a bare Zod rejection at the loop's
        // input boundary. `execute` re-parses against RunSynthesisSchema itself.
        inputSchema: z.object({
            synthesis: z.unknown().describe("The candidate synthesis, in any shape. Field-by-field schema: see submit_synthesis."),
        }),
        execute: async (input) => {
            const result = fullyValidate(input.synthesis, ctx);
            return ok(result.valid ? { valid: true as const, issues: [] as ValidationIssue[] } : { valid: false as const, issues: result.issues });
        },
    });
}

function buildSubmitTool(holder: OutcomeHolder, ctx: InnerToolContext, telemetry: RejectionTelemetry): Tool {
    return defineTool({
        id: "submit_synthesis",
        description:
            "Submit the final synthesis. Re-validates the payload against the " +
            "semantic checks the arg schema cannot express (stepId refs, " +
            "theme→finding refs, keyReferences PMIDs cited, numeric PMIDs). On " +
            "success returns {accepted: true} — STOP after this. On rejection " +
            "returns {accepted: false, issues} — fix the specific fields at each " +
            "issue path and call again, or switch to report_blocker if the " +
            "synthesis cannot be made valid. A rejected submission leaves any " +
            "already-accepted synthesis untouched; a later accepted submission " +
            "supersedes an earlier one.",
        inputSchema: z.object({ synthesis: RunSynthesisSchema }),
        execute: async (input): Promise<Result<SubmitSynthesisOutput, ToolError>> => {
            const result = fullyValidate(input.synthesis, ctx);
            if (!result.valid) {
                // A rejection is not terminal — the model may fix the cited paths and
                // submit again — so this counts attempts against the semantic checks,
                // not a failure of the run.
                telemetry.rejections += 1;
                for (const issue of result.issues) telemetry.issuePaths.add(issue.path);
                return ok({ accepted: false as const, issues: result.issues });
            }
            holder.outcome = { kind: "submitted", synthesis: result.synthesis };
            return ok({ accepted: true as const });
        },
    });
}

function buildBlockerTool(holder: OutcomeHolder): Tool {
    return createReportBlockerToolFor({
        record: (outcome) => {
            if (holder.outcome === null) holder.outcome = outcome;
        },
        blockedWhen:
            "Ends run synthesis with no synthesis written. Use it ONLY when the " +
            "run produced no synthesizable content — every step summary is empty, " +
            "or the summaries are contradictory to the point of incoherence. A run " +
            "with non-empty summaries but no individually notable findings is NOT a " +
            "blocker: submit a synthesis with an empty findings[] instead. Never " +
            "use it as an escape from a synthesis you could fix and submit.",
    });
}

/**
 * Test-only — expose the inner-tool factory so unit tests can assert on
 * validation + outcome capture without driving the whole agent loop.
 */
export function __buildInnerToolsForTest(args: { knownStepIds: ReadonlySet<string>; runId: string }): {
    validate: Tool;
    submit: Tool;
    blocker: Tool;
    holder: OutcomeHolder;
    telemetry: RejectionTelemetry;
} {
    const holder: OutcomeHolder = { outcome: null };
    const telemetry: RejectionTelemetry = { rejections: 0, issuePaths: new Set() };
    const ctx: InnerToolContext = {
        knownStepIds: args.knownStepIds,
        runId: args.runId,
    };
    return {
        validate: buildValidateTool(ctx),
        submit: buildSubmitTool(holder, ctx, telemetry),
        blocker: buildBlockerTool(holder),
        holder,
        telemetry,
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

export type GenerateRunSynthesisResult =
    | { kind: "synthesis"; synthesis: RunSynthesis; validationRejections: number }
    | { kind: "skipped"; reason: string; validationRejections: number; rejectedIssuePaths: readonly string[] };

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
    const telemetry: RejectionTelemetry = { rejections: 0, issuePaths: new Set() };
    const innerCtx: InnerToolContext = { knownStepIds, runId: input.runId };
    const reviewer = createLiteratureReviewerTool({
        provider: input.provider,
        model: input.model,
        bioKeys: input.bioKeys,
    });

    const validateTool = buildValidateTool(innerCtx);
    const submitTool = buildSubmitTool(holder, innerCtx, telemetry);
    const blockerTool = buildBlockerTool(holder);
    const tools: readonly Tool[] = [validateTool, submitTool, blockerTool, reviewer];

    const agent: AgentDefinition = {
        id: AGENT_ID,
        systemPrompt: composeSystemPrompt(synthesisAgentPrompt),
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
        return { kind: "synthesis", synthesis: outcome.synthesis, validationRejections: telemetry.rejections };
    }
    if (outcome?.kind === "blocker") {
        return {
            kind: "skipped",
            reason: outcome.reason,
            validationRejections: telemetry.rejections,
            rejectedIssuePaths: [...telemetry.issuePaths].sort(),
        };
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
    // Confine to the run directory, not the whole workspace: synthesis.json sits
    // at runs/{runId}/, above any step's RW mount and never in the hard-linked
    // `data/` inputs.
    const runRoot = join(args.workspaceRoot, runDir(args.runId));
    const path = join(runRoot, "synthesis.json");
    await writeFileWithinRoot(runRoot, path, JSON.stringify(args.synthesis, null, 2));
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
