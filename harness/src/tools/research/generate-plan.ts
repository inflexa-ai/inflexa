/**
 * generatePlan — a loop-driving tool: a focused `runAgent` loop that builds
 * an analysis plan (a DAG of steps).
 *
 * The dataset's facts are NOT an input. They are read here, server-side, from
 * the analysis's persisted data profile — the one durable record of what the
 * input data is — and projected into the planner's seed. The caller supplies
 * only what the profile cannot hold: the research question, facts the user
 * volunteered (`analystNotes`), prior run results, and plan constraints. A
 * caller-typed dataset summary would be a model re-transcribing a record the
 * database already holds, and it would lose fidelity at every hop.
 *
 * The tool drives an internal "planner" agent that communicates outcomes
 * EXCLUSIVELY via four terminal tool calls:
 *
 *   - validate_plan(plan)       → non-terminal dry-run: an any-shape candidate
 *                                 in, {valid, issues} out (schema + semantic)
 *   - submit_plan(plan)         → terminal success: re-validates + persists
 *   - request_clarification(…)  → terminal: planner needs more context
 *   - report_blocker(reason)    → terminal: no viable plan
 *
 * The planner is an `AgentDefinition` driven by `runAgent`; the pool and
 * resource id are an explicit `Pool` dependency and the request-scoped
 * `Session`. The planner prompt injects the agent catalog and exposes the
 * terminal-tool surface above.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { formatAgentCatalog } from "../../agents/sandbox-catalog.js";
import { composeSystemPrompt } from "../../agents/system-prompt.js";
import { runToTerminal } from "../../loop/run-to-terminal.js";
import { passthroughStep } from "../../loop/run-step.js";
import type { AgentDefinition } from "../../loop/types.js";
import { forSubAgent, scopeResource } from "../../auth/types.js";
import { type ChatProvider } from "../../providers/types.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { createReportBlockerToolFor } from "../sandbox/report-blocker.js";

import { DATA_PROFILE_ORIENTATION_MAX_CHARS, buildDataProfileOrientation } from "../../app/data-profile-orientation.js";
import { isDataProfileStale } from "../../app/data-profile-policy.js";
import { DEFAULT_SANDBOX_MAX_STEPS, type ResourcePolicy } from "../../config/resource-limits.js";
import { plannerPrompt } from "../../prompts/planner.js";
import { hydratePlanSteps, PlannerPlanSchema, type PlannerPlan, type PlanningAgentOutput } from "../../schemas/plan-schemas.js";
import { validatePlan } from "../../schemas/validate-plan.js";
import { AnalysisPlanSchema } from "../../schemas/workflow-state.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { hintForZodIssue } from "../../lib/zod-issues.js";
import { insertPlan, loadDataProfileStatus, loadPlan, type DataProfileResult, type DataProfileStatus } from "../../state/index.js";

// ── Tool-level config ──────────────────────────────────────────────

/** Sub-agent identity for the planner — provenance only. */
const PLANNER_AGENT_ID = "planner";

/**
 * Budget for the planner's internal loop: 1 draft + ~3 validate/fix
 * cycles + 1 submit + headroom.
 */
const PLANNER_MAX_ITERATIONS = 13;

/** Wall-clock guard for a single plan-generation invocation. */
const PLAN_TIMEOUT_MS = 600_000;

// ── Prompt / catalog ────────────────────────────────────────────────

/** The planner system prompt is deterministic per policy — build it once per
 *  factory (the policy is a construction-time dep, fixed for the process). */
function plannerInstructions(resourcePolicy?: ResourcePolicy): string {
    return plannerPrompt(formatAgentCatalog(), resourcePolicy);
}

// ── Shared types ────────────────────────────────────────────────────

/**
 * The outcome captured across inner tool calls. Exactly one terminal
 * outcome is recorded per invocation; additional terminal calls are
 * rejected by the tool implementations.
 */
type PlannerOutcome =
    | { kind: "plan_submitted"; planId: string; plan: PlannerPlan }
    | { kind: "clarification"; question: string; questionContext?: string }
    | { kind: "blocker"; reason: string }
    | { kind: "persist_error"; message: string };

interface OutcomeHolder {
    outcome: PlannerOutcome | null;
}

interface PersistContext {
    analysisId: string;
    parentPlanId: string | null;
}

interface ValidationIssue {
    path: string;
    code: "schema" | "semantic";
    message: string;
    hint?: string;
}

type SubmitPlanOutput = { accepted: false; issues: ValidationIssue[] } | { accepted: true; planId: string };

// ── Prior plan serialization (iteration context) ───────────────────

/**
 * Format a loaded prior plan as a markdown block the planner can read —
 * narrative + one line per step. Used only when `parentPlanId` is set.
 */
function formatPriorPlan(parentPlanId: string, plan: unknown): string | null {
    const parsed = AnalysisPlanSchema.safeParse(plan);
    if (!parsed.success) return null;
    const p = parsed.data;

    const stepLines = p.steps.map((s) => {
        const deps = s.depends_on.length ? ` [deps: ${s.depends_on.join(", ")}]` : "";
        const agent = s.agent ? ` (${s.agent})` : "";
        return `- **${s.id}**${agent}: ${s.name} — ${s.question}${deps}`;
    });

    return [
        `## Prior Plan (${parentPlanId} — being iterated)`,
        "",
        ...(p.analytical_narrative ? [`**Analytical narrative:** ${p.analytical_narrative}`, ""] : []),
        "**Steps:**",
        ...stepLines,
        "",
        "The user is iterating on this plan. Preserve steps and IDs that are " +
            "not being changed; modify only what `userConstraints` describes. " +
            "Reuse step IDs when a step's purpose is unchanged so downstream " +
            "references survive.",
    ].join("\n");
}

// ── Data context (server-derived, never model-authored) ────────────

/**
 * What the planner actually holds about the dataset.
 *
 * Every lifecycle state is a variant because every one of them is ordinary: an
 * analysis can be planned before it has been profiled, while profiling is in
 * flight, after an attempt failed, and against a profile whose input files have
 * since changed. None of those is an error, and none of them may stop a plan
 * being produced — a planner told which state it is in can plan accordingly; a
 * planner told nothing plans on facts it cannot know are rotten.
 */
type DataGrounding =
    | { kind: "ready"; result: DataProfileResult }
    /** A profile IS available, but may not describe the analysis's current inputs. */
    | { kind: "provisional"; result: DataProfileResult; reasons: readonly string[] }
    /** Profiling is in flight and no earlier profile exists. */
    | { kind: "pending" }
    /** Profiling failed and no earlier profile exists. */
    | { kind: "failed"; error: string | null }
    /** Never profiled, cleared, or nothing to profile. */
    | { kind: "absent" };

/**
 * Read the profile ledger row into a grounding variant.
 *
 * Staleness is `isDataProfileStale` — the single definition in
 * `app/data-profile-policy.ts` that the embedder's re-trigger policy and
 * `inspect_data_profile` also use, so the planner and the conversation agent can
 * never disagree about whether a profile still describes the data.
 */
function classifyGrounding(status: DataProfileStatus | null): DataGrounding {
    // `loadDataProfileStatus` collapses "no analysis row" and "profile cleared"
    // into one null, deliberately — both mean "no profile" to a consumer.
    if (!status) return { kind: "absent" };

    const result = status.result;
    if (!result) {
        if (status.status === "failed") return { kind: "failed", error: status.error };
        // `completed` with no result is the empty-manifest path: there were no
        // input files to profile. "Nothing is known about the data" is the honest
        // reading of that, not a failure.
        if (status.status === "completed") return { kind: "absent" };
        return { kind: "pending" };
    }

    // A result outlives the attempt that superseded it: `tryRerun` / `tryRetry`
    // preserve `data_profile_result` on purpose, so a non-`completed` status
    // carrying a result means what is on the row is the PREVIOUS profile.
    const reasons: string[] = [];
    if (isDataProfileStale(status.seedInputFileIds ?? [], result.inputFileIds)) {
        reasons.push("the analysis's input file set changed after this profile was taken");
    }
    if (status.status === "pending" || status.status === "running") {
        reasons.push("a re-profile is in progress — this is the previous profile");
    }
    if (status.status === "failed") {
        reasons.push(`the most recent profiling attempt failed (${status.error ?? "no reason recorded"}) — this is the previous profile`);
    }

    return reasons.length > 0 ? { kind: "provisional", result, reasons } : { kind: "ready", result };
}

/** What a seed says when it has no dataset facts to give the planner. */
const NO_FACTS_GUIDANCE =
    "Plan from the research question alone, do not invent dataset specifics, and call " +
    "`request_clarification` if a specific fact about the data is essential to the plan.";

/**
 * Render the seed's `## Data Context` from the grounding.
 *
 * The facts come from `buildDataProfileOrientation` — the same bounded projector
 * the sandbox step seed uses, so a step and the plan that produced it are oriented
 * by identical text. It is not re-derived here, and the planner cannot reach past
 * it: the planner has no `inspect_data_profile` tool, so what this section does not
 * say is simply not known to it.
 *
 * An absent profile renders NOTHING — no heading, no apology. Planning without
 * dataset facts is worse-grounded but entirely possible, and a section announcing
 * its own emptiness is an invitation to fill it. Every other state renders,
 * including the two that carry no facts either: a planner told that its record is
 * still being built, or that its facts may have moved, can act on that; one handed
 * stale facts silently cannot.
 *
 * Pure — the same grounding renders the same string.
 */
function renderDataContext(grounding: DataGrounding): string {
    switch (grounding.kind) {
        case "absent":
            return "";

        case "pending":
            return ["## Data Context", "", `This analysis is still being profiled — no dataset facts are available yet. ${NO_FACTS_GUIDANCE}`].join("\n");

        case "failed":
            return [
                "## Data Context",
                "",
                `Data profiling failed (${grounding.error ?? "no reason recorded"}) and no earlier profile exists, ` +
                    `so no dataset facts are available. ${NO_FACTS_GUIDANCE}`,
            ].join("\n");

        case "ready":
        case "provisional": {
            const lines = [
                "## Data Context",
                "",
                "From this analysis's persisted data profile — the authoritative record of what the input data " +
                    "is, derived by profiling the files themselves. Nobody typed it; ground your plan in it.",
                "",
                buildDataProfileOrientation(grounding.result, DATA_PROFILE_ORIENTATION_MAX_CHARS),
            ];
            if (grounding.kind === "provisional") {
                lines.push(
                    "",
                    `PROVISIONAL — this profile may not describe the analysis's current inputs: ${grounding.reasons.join("; ")}. ` +
                        "Plan on it, but keep the plan robust to any fact above having moved.",
                );
            }
            return lines.join("\n");
        }
    }
}

// ── Persistence ─────────────────────────────────────────────────────

/**
 * Persist a validated plan. Returns the planId, or an outcome-ready error
 * with a sanitized message — DB-shape errors never leak to the planner.
 */
async function persistPlan(plan: PlannerPlan, ctx: PersistContext, pool: Pool): Promise<{ ok: true; planId: string } | { ok: false; message: string }> {
    try {
        const planId = unwrapOrThrow(
            await insertPlan(pool, {
                analysisId: ctx.analysisId,
                plan: hydratePlanSteps(plan),
                parentPlanId: ctx.parentPlanId,
            }),
        );
        return { ok: true, planId };
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const isParentValidation = /^parent plan .* (?:not found|belongs to a different analysis)$/i.test(raw);
        return {
            ok: false,
            message: isParentValidation ? "parentPlanId is not a valid plan for this analysis" : "plan could not be saved, please try again",
        };
    }
}

// ── Validation ──────────────────────────────────────────────────────

function zodIssuesToValidationIssues(error: z.ZodError, input: unknown, rootPath = "plan"): ValidationIssue[] {
    return error.issues.map((i) => ({
        path: [rootPath, ...i.path.map((p) => String(p))].join("."),
        code: "schema" as const,
        message: i.message,
        hint: hintForZodIssue(i, input),
    }));
}

/**
 * Full validation: Zod schema + semantic checks. The plan is valid only if
 * BOTH pass.
 */
function fullyValidate(candidate: unknown, resourcePolicy?: ResourcePolicy): { valid: true; plan: PlannerPlan } | { valid: false; issues: ValidationIssue[] } {
    const parsed = PlannerPlanSchema.safeParse(candidate);
    if (!parsed.success) {
        return { valid: false, issues: zodIssuesToValidationIssues(parsed.error, candidate) };
    }

    // Semantic checks operate on the AnalysisPlan shape — PlannerPlan omits
    // maxSteps, so inject the execution-time default to satisfy the validator.
    const semantic = validatePlan(
        {
            analytical_narrative: parsed.data.analytical_narrative,
            steps: parsed.data.steps.map((s) => ({
                ...s,
                status: "pending" as const,
                maxSteps: DEFAULT_SANDBOX_MAX_STEPS,
            })),
            created_at: parsed.data.created_at,
            omicsType: parsed.data.omicsType,
            omicsSubtype: parsed.data.omicsSubtype,
        },
        { perStepCeiling: resourcePolicy?.perStep },
    );

    if (!semantic.valid) {
        return {
            valid: false,
            issues: semantic.errors.map((msg) => ({
                path: "plan",
                code: "semantic" as const,
                message: msg,
            })),
        };
    }

    return { valid: true, plan: parsed.data };
}

// ── Inner tools (fresh instance per outer tool invocation) ─────────

/**
 * The planner's inner tools. `all` is the full surface handed to the loop;
 * `terminal` is the subset that records an outcome (`submit_plan`,
 * `request_clarification`, `report_blocker`) — `validate_plan` is a
 * non-terminal dry-run and is excluded. The terminal subset is what the
 * salvage turn re-offers if the planner ends without an outcome.
 */
interface InnerTools {
    readonly all: Tool[];
    readonly terminal: Tool[];
}

/**
 * Build the planner's inner tools for one invocation. They close over the
 * shared `holder` so the outer `execute` reads the terminal outcome after the
 * loop finishes.
 */
function buildInnerTools(holder: OutcomeHolder, persistCtx: PersistContext, pool: Pool, resourcePolicy?: ResourcePolicy): InnerTools {
    const validatePlanTool = defineTool({
        id: "validate_plan",
        description:
            "Dry-run a candidate plan and get back everything that is wrong with it. " +
            "Takes the plan in ANY shape: a malformed, partial, or wrong-typed " +
            "candidate is REPORTED, not rejected. Returns {valid, issues[]} covering " +
            "both schema problems (missing / wrong-typed fields) and the semantic " +
            "checks a schema cannot express (unknown agent IDs, DAG cycles, dangling " +
            "depends_on references, duplicate step IDs, resource ceilings). The " +
            "authoritative field-by-field plan schema is the arg schema of " +
            "submit_plan — this tool deliberately does not restate it. Non-terminal: " +
            "call as often as needed to iterate toward a clean plan, then submit_plan.",
        // Deliberately permissive: a structurally-invalid candidate must reach
        // `execute` so the model gets a structured {valid:false, issues} result —
        // including semantic issues — instead of a bare Zod rejection at the loop's
        // input boundary. `execute` re-parses against PlannerPlanSchema itself.
        inputSchema: z.object({
            plan: z.unknown().describe("The candidate plan, in any shape. Field-by-field schema: see submit_plan."),
        }),
        execute: async (input) => {
            const result = fullyValidate(input.plan, resourcePolicy);
            return ok(result.valid ? { valid: true as const, issues: [] as ValidationIssue[] } : { valid: false as const, issues: result.issues });
        },
    });

    const submitPlanTool = defineTool({
        id: "submit_plan",
        description:
            "Submit the final plan for persistence. Re-validates the plan; on " +
            "success returns {accepted: true, planId} — STOP after this. On " +
            "rejection returns {accepted: false, issues} — fix and call again, " +
            "or switch to report_blocker if the plan cannot be made valid. This " +
            "arg schema is the authoritative plan contract.",
        // Strict: a malformed plan must not reach submission. `execute` still
        // re-validates (schema + semantic) — it does not lean on this boundary.
        inputSchema: z.object({ plan: PlannerPlanSchema }),
        execute: async (input): Promise<Result<SubmitPlanOutput, ToolError>> => {
            if (holder.outcome !== null) {
                return ok({
                    accepted: false as const,
                    issues: [
                        {
                            path: "plan",
                            code: "semantic" as const,
                            message: "A terminal outcome has already been recorded; submit_plan " + "can only be called once per invocation.",
                        },
                    ],
                });
            }

            const result = fullyValidate(input.plan, resourcePolicy);
            if (!result.valid) {
                return ok({ accepted: false as const, issues: result.issues });
            }

            const persisted = await persistPlan(result.plan, persistCtx, pool);
            if (!persisted.ok) {
                holder.outcome = { kind: "persist_error", message: persisted.message };
                return ok({
                    accepted: false as const,
                    issues: [
                        {
                            path: "plan",
                            code: "semantic" as const,
                            message: persisted.message,
                            hint: "Persistence failed — do not retry submit_plan.",
                        },
                    ],
                });
            }

            holder.outcome = {
                kind: "plan_submitted",
                planId: persisted.planId,
                plan: result.plan,
            };
            return ok({ accepted: true as const, planId: persisted.planId });
        },
    });

    const requestClarificationTool = defineTool({
        id: "request_clarification",
        description:
            "Terminal. Use when a specific fact you need is missing from the " +
            "input and cannot be inferred. Pass a short question and optional " +
            "context. Stop after calling.",
        inputSchema: z.object({
            question: z.string().min(1),
            questionContext: z.string().optional(),
        }),
        execute: async (input) => {
            if (holder.outcome === null) {
                holder.outcome = {
                    kind: "clarification",
                    question: input.question,
                    questionContext: input.questionContext,
                };
            }
            return ok({ recorded: true as const });
        },
    });

    const reportBlockerTool = createReportBlockerToolFor({
        record: (outcome) => {
            if (holder.outcome === null) holder.outcome = outcome;
        },
        blockedWhen:
            "Ends plan generation with no plan saved. Use it when no valid plan can " +
            "be produced for this data and research question (out of scope, data " +
            "incompatible with every available agent, etc.) — not for a plan you " +
            "could fix and submit.",
    });

    const terminal = [submitPlanTool, requestClarificationTool, reportBlockerTool];
    return { all: [validatePlanTool, ...terminal], terminal };
}

// ── Outcome shaping ─────────────────────────────────────────────────

interface ShapeOutcomeArgs {
    holder: OutcomeHolder;
    runError: unknown;
    timedOut: boolean;
    outerAborted: boolean;
}

/**
 * Translate the captured `PlannerOutcome` (plus any loop error) into the
 * `PlanningAgentOutput` contract the conversation agent consumes.
 */
function shapeOutcome(args: ShapeOutcomeArgs): PlanningAgentOutput {
    const { holder, runError, timedOut, outerAborted } = args;
    const outcome = holder.outcome;

    if (outcome?.kind === "plan_submitted") {
        return { event: "plan_complete", planId: outcome.planId, plan: outcome.plan };
    }
    if (outcome?.kind === "clarification") {
        return {
            event: "clarification_needed",
            question: outcome.question,
            ...(outcome.questionContext ? { questionContext: outcome.questionContext } : {}),
        };
    }
    if (outcome?.kind === "blocker") {
        return { event: "error", error: outcome.reason };
    }
    if (outcome?.kind === "persist_error") {
        return { event: "error", error: `Failed to save plan: ${outcome.message}` };
    }

    // No terminal outcome — something went wrong in the loop.
    if (timedOut) {
        return {
            event: "error",
            error: "Plan generation timed out — the model may be overloaded.",
        };
    }
    if (outerAborted) {
        return { event: "error", error: "Plan generation was cancelled." };
    }
    if (runError) {
        const msg = runError instanceof Error ? runError.message : String(runError);
        return { event: "error", error: `Plan generation failed: ${msg}` };
    }
    return {
        event: "error",
        error: "Plan generation completed without a terminal outcome — the planner " + "did not call submit_plan, request_clarification, or report_blocker.",
    };
}

// ── Outer tool ──────────────────────────────────────────────────────

export interface GeneratePlanDeps {
    /** The LLM seam the planner loop runs on. */
    readonly provider: ChatProvider;
    /** Database pool — plan persistence and prior-plan loading. */
    readonly pool: Pool;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /**
     * Host resource policy — stated to the planner as concrete per-step
     * ceilings and enforced by `validate_plan`. Absent, the prompt keeps its
     * default guidance and validation skips the ceiling check.
     */
    readonly resourcePolicy?: ResourcePolicy;
}

/** Build the `generate_plan` tool bound to its provider and pool. */
export function createGeneratePlanTool(deps: GeneratePlanDeps): Tool {
    return defineTool({
        id: "generate_plan",
        description:
            "Generate an analysis plan (DAG of steps) for this analysis's data and the user's research question. " +
            "The dataset's own facts — domain, organism, experimental design, condition names, quality concerns, " +
            "per-file data types and dimensions — are read server-side from the persisted data profile and handed " +
            "to the planner directly. Do NOT summarize or re-type them into this call; you cannot restate that " +
            "record more faithfully than the record itself. Pass only what the profile cannot hold: the research " +
            "question, facts the user told you (analystNotes), prior run results, and their constraints. " +
            "Returns a structured plan ready for show_plan and execute_plan, or a clarification question if " +
            "the planner is missing something it cannot infer.",
        inputSchema: z.object({
            researchQuestion: z.string().describe("What the user wants to analyze — their goal and specific questions."),
            analystNotes: z
                .string()
                .optional()
                .describe(
                    "Facts about the data that ONLY the user could have told you and the data profile cannot know — " +
                        'e.g. "samples 3 and 7 were re-sequenced", "treat batch B as the reference", ' +
                        '"the tumor/normal labels in column 4 are swapped". ' +
                        "This is NOT a place to restate the data profile: organism, omics type, experimental design, " +
                        "condition names, file names and dimensions are already loaded server-side and given to the " +
                        "planner — repeating them here only risks contradicting the record. Omit entirely unless the " +
                        "user has told you something the profile does not already hold.",
                ),
            priorRuns: z
                .string()
                .optional()
                .describe("Summary of prior run results if any exist: which steps ran, " + "what succeeded/failed, key findings. Omit if no prior runs."),
            userConstraints: z
                .string()
                .optional()
                .describe("User-specified constraints: preferred methods, steps to " + "include/exclude, resource limits, modifications to a prior plan."),
            parentPlanId: z
                .string()
                .regex(/^pln-[a-f0-9]{8}$/, "parentPlanId must be a pln-<8hex> value")
                .optional()
                .describe("The planId of the prior plan being iterated on. Set only when " + "the user is asking for modifications to an existing plan."),
        }),
        execute: async (input, ctx): Promise<Result<PlanningAgentOutput, ToolError>> => {
            const analysisId = scopeResource(ctx.session.scope).resourceId;

            // If iterating, load the parent plan so the planner sees what it is
            // revising. Fails fast with the sanitized message submit_plan would
            // have surfaced — saves a wasted planner run.
            let priorPlanBlock: string | null = null;
            if (input.parentPlanId) {
                try {
                    const priorPlan = unwrapOrThrow(
                        await loadPlan(deps.pool, input.parentPlanId, {
                            analysisId,
                        }),
                    );
                    if (!priorPlan) {
                        return ok({
                            event: "error",
                            error: "parentPlanId is not a valid plan for this analysis",
                        } satisfies PlanningAgentOutput);
                    }
                    priorPlanBlock = formatPriorPlan(input.parentPlanId, priorPlan);
                } catch {
                    return ok({
                        event: "error",
                        error: "Plan iteration failed — parent plan could not be loaded.",
                    } satisfies PlanningAgentOutput);
                }
            }

            // The dataset's facts come from the ledger, not from a string a model
            // typed: the profile is the only durable record of what the input data
            // is, and every re-transcription of it loses fidelity.
            //
            // A read failure degrades to "no profile" rather than throwing. Planning
            // without dataset facts is a real, supported state (see `renderDataContext`),
            // so a ledger read that fails must cost the planner its grounding — never
            // the user their plan.
            const profileStatus = await loadDataProfileStatus(deps.pool, analysisId).unwrapOr(null);
            const dataContextBlock = renderDataContext(classifyGrounding(profileStatus));

            const prompt = [
                ...(priorPlanBlock ? [priorPlanBlock, ""] : []),
                ...(dataContextBlock ? [dataContextBlock, ""] : []),
                "## Research Question",
                input.researchQuestion,
                ...(input.analystNotes ? ["", "## Analyst Notes (from the user — facts about the data the profile does not record)", input.analystNotes] : []),
                ...(input.priorRuns ? ["", "## Prior Run Results", input.priorRuns] : []),
                ...(input.userConstraints ? ["", "## User Constraints", input.userConstraints] : []),
            ].join("\n");

            const holder: OutcomeHolder = { outcome: null };
            const persistCtx: PersistContext = {
                analysisId,
                parentPlanId: input.parentPlanId ?? null,
            };
            const innerTools = buildInnerTools(holder, persistCtx, deps.pool, deps.resourcePolicy);
            const planner: AgentDefinition = {
                id: PLANNER_AGENT_ID,
                systemPrompt: composeSystemPrompt(plannerInstructions(deps.resourcePolicy)),
                model: deps.model,
                tools: innerTools.all,
                maxIterations: PLANNER_MAX_ITERATIONS,
            };

            // Merge the outer abort signal with a wall-clock timeout — either
            // cancels the planner promptly.
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]);

            let runError: unknown = null;
            try {
                await runToTerminal(
                    planner,
                    [{ role: "user", content: prompt }],
                    forSubAgent(ctx.session, PLANNER_AGENT_ID),
                    {
                        provider: deps.provider,
                        signal,
                        emit: ctx.emit,
                        runStep: passthroughStep,
                    },
                    {
                        resolved: () => holder.outcome !== null,
                        tools: innerTools.terminal,
                        nudge:
                            "You ended without a terminal outcome. Call submit_plan with " +
                            "your final plan now, or request_clarification / report_blocker " +
                            "if you cannot. Do not reply with prose.",
                    },
                );
            } catch (err) {
                runError = err;
            }

            return ok(
                shapeOutcome({
                    holder,
                    runError,
                    timedOut: signal.aborted && !ctx.signal.aborted,
                    outerAborted: ctx.signal.aborted,
                }),
            );
        },
    });
}
