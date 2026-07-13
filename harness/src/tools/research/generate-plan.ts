/**
 * generatePlan — a loop-driving tool: a focused `runAgent` loop that builds
 * an analysis plan (a DAG of steps).
 *
 * The outer tool receives only the ask from the conversation agent
 * (`researchQuestion`, `userConstraints?`, `parentPlanId?`) and composes the
 * planner's context itself from harness-owned state — the data-profile,
 * prior-runs, and (when iterating) prior-plan briefings, injected as
 * unpersisted initial messages before the user message (see the
 * conversation-briefings spec, D8). It then drives an internal "planner" agent
 * that communicates outcomes EXCLUSIVELY via four terminal tool calls:
 *
 *   - validate_plan(plan)       → non-terminal dry-run (Zod + semantic)
 *   - submit_plan(plan)         → terminal success: re-validates + persists
 *   - request_clarification(…)  → terminal: planner needs more context
 *   - report_blocker(reason)    → terminal: no viable plan
 *
 * The planner is an `AgentDefinition` driven by `runAgent`; the pool and
 * resource id are an explicit `Pool` dependency and the request-scoped
 * `Session`. The planner prompt injects the agent catalog and exposes the
 * terminal-tool surface above.
 */

import type { ModelMessage } from "ai";
import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { formatAgentCatalog } from "../../agents/sandbox-catalog.js";
import { runToTerminal } from "../../loop/run-to-terminal.js";
import { passthroughStep } from "../../loop/run-step.js";
import type { AgentDefinition } from "../../loop/types.js";
import { forSubAgent, scopeResource } from "../../auth/types.js";
import { type ChatProvider } from "../../providers/types.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

import { DEFAULT_SANDBOX_MAX_STEPS, type ResourcePolicy } from "../../config/resource-limits.js";
import { plannerPrompt } from "../../prompts/planner.js";
import { composeBriefing, dataProfileBriefing, priorPlanBriefing, priorRunsBriefing, type ComposedBriefing } from "../../prompts/briefings/index.js";
import { hydratePlanSteps, PlannerPlanSchema, type PlannerPlan, type PlanningAgentOutput } from "../../schemas/plan-schemas.js";
import { validatePlan } from "../../schemas/validate-plan.js";
import { AnalysisPlanSchema, type AnalysisPlan } from "../../schemas/workflow-state.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { insertPlan, loadDataProfileStatus, loadPlan, loadRunIndex } from "../../state/index.js";

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

function zodIssuesToValidationIssues(error: z.ZodError, rootPath = "plan"): ValidationIssue[] {
    return error.issues.map((i) => ({
        path: [rootPath, ...i.path.map((p) => String(p))].join("."),
        code: "schema" as const,
        message: i.message,
    }));
}

/**
 * Full validation: Zod schema + semantic checks. The plan is valid only if
 * BOTH pass.
 */
function fullyValidate(candidate: unknown, resourcePolicy?: ResourcePolicy): { valid: true; plan: PlannerPlan } | { valid: false; issues: ValidationIssue[] } {
    const parsed = PlannerPlanSchema.safeParse(candidate);
    if (!parsed.success) {
        return { valid: false, issues: zodIssuesToValidationIssues(parsed.error) };
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
    const candidatePlan = z.object({ plan: z.unknown() });

    const validatePlanTool = defineTool({
        id: "validate_plan",
        description:
            "Dry-run a candidate plan against the schema and semantic checks " +
            "(agent IDs, DAG cycles, dependency references, unique step IDs, " +
            "resources). Returns {valid, issues}. Non-terminal — call as many " +
            "times as needed to iterate toward a clean plan before submit_plan.",
        inputSchema: candidatePlan,
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
            "or switch to report_blocker if the plan cannot be made valid.",
        inputSchema: candidatePlan,
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

    const reportBlockerTool = defineTool({
        id: "report_blocker",
        description:
            "Terminal. Use when no valid plan can be produced (out of scope, " +
            "data incompatible with every available agent, etc.). Pass a short " +
            "reason. Stop after calling.",
        inputSchema: z.object({ reason: z.string().min(1) }),
        execute: async (input) => {
            if (holder.outcome === null) {
                holder.outcome = { kind: "blocker", reason: input.reason };
            }
            return ok({ recorded: true as const });
        },
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
            "Generate an analysis plan (DAG of steps) for the given research " +
            "question. The tool reads the data profile and prior-run history from " +
            "the analysis itself — do NOT re-type them. Pass the research question, " +
            "any user constraints, and, when revising an existing plan, its " +
            "parentPlanId. Returns a structured plan ready for show_plan and " +
            "execute_plan, or a clarification question if context is insufficient.",
        inputSchema: z.object({
            researchQuestion: z.string().describe("What the user wants to analyze — their goal and specific questions."),
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
            // have surfaced — saves a wasted planner run. A malformed stored plan
            // parses to nothing and simply omits the prior-plan briefing (the
            // planner then treats the request as fresh).
            let priorPlan: AnalysisPlan | null = null;
            if (input.parentPlanId) {
                try {
                    const loaded = unwrapOrThrow(await loadPlan(deps.pool, input.parentPlanId, { analysisId }));
                    if (!loaded) {
                        return ok({
                            event: "error",
                            error: "parentPlanId is not a valid plan for this analysis",
                        } satisfies PlanningAgentOutput);
                    }
                    const parsed = AnalysisPlanSchema.safeParse(loaded);
                    priorPlan = parsed.success ? parsed.data : null;
                } catch {
                    return ok({
                        event: "error",
                        error: "Plan iteration failed — parent plan could not be loaded.",
                    } satisfies PlanningAgentOutput);
                }
            }

            // Compose the planner's context from harness-owned state as
            // unpersisted initial messages, in order [data-profile, prior-runs,
            // prior-plan], each omitted when its input is unavailable. The user
            // message — the actual ask — follows them.
            const briefings: ComposedBriefing[] = [];

            const profile = await loadDataProfileStatus(deps.pool, analysisId).unwrapOr(null);
            if (profile?.status === "completed" && profile.result) {
                briefings.push(composeBriefing(dataProfileBriefing, profile.result));
            }

            const runIndex = await loadRunIndex(deps.pool, analysisId);
            if (runIndex.entries.length > 0) {
                briefings.push(composeBriefing(priorRunsBriefing, runIndex));
            }

            if (priorPlan) {
                briefings.push(composeBriefing(priorPlanBriefing, { planId: input.parentPlanId!, plan: priorPlan }));
            }

            const userMessage: ModelMessage = {
                role: "user",
                content: [
                    "## Research question",
                    input.researchQuestion,
                    ...(input.userConstraints ? ["", "## User constraints", input.userConstraints] : []),
                ].join("\n"),
            };

            const initialMessages: ModelMessage[] = [...briefings.map((b) => b.message), userMessage];

            const holder: OutcomeHolder = { outcome: null };
            const persistCtx: PersistContext = {
                analysisId,
                parentPlanId: input.parentPlanId ?? null,
            };
            const innerTools = buildInnerTools(holder, persistCtx, deps.pool, deps.resourcePolicy);
            const planner: AgentDefinition = {
                id: PLANNER_AGENT_ID,
                systemPrompt: plannerInstructions(deps.resourcePolicy),
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
                    initialMessages,
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
