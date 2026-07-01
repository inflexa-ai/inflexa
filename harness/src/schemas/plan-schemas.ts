/**
 * Planning schemas — used by the generatePlan tool and executeAnalysis
 * workflow to produce and validate analysis plans.
 */

import { z } from "zod";
import { AnalysisStepSchema, AnalysisPlanSchema } from "./workflow-state.js";
import type { AnalysisPlan } from "./workflow-state.js";
import { PLANNABLE_AGENT_IDS as plannableAgentIds } from "../agents/sandbox-catalog.js";
import { DEFAULT_SANDBOX_MAX_STEPS } from "../config/resource-limits.js";

// ── Slim planner schemas (no execution-time fields) ──────────────────

/** Step schema for planner output — omits fields populated at execution time
 *  and the hardcoded sandbox turn budget. */
export const PlanStepSchema = AnalysisStepSchema.omit({
    status: true,
    timeout: true,
    summary: true,
    artifactIds: true,
    error: true,
    maxSteps: true,
})
    .required({ agent: true, resources: true })
    .extend({
        agent: z.enum(plannableAgentIds).describe("Sandbox agent ID from the available agents list"),
    });

export type PlanStep = z.infer<typeof PlanStepSchema>;

/** Plan schema for planner output — uses PlanStepSchema for steps and requires
 *  a concise title (optional on the persistence schema for historical plans). */
export const PlannerPlanSchema = AnalysisPlanSchema.extend({
    title: z.string().min(1).max(80).describe("Concise human-readable plan name (3–8 words)"),
    steps: z.array(PlanStepSchema),
});

export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;

/** Hydrate slim planner output into a full AnalysisPlan with execution-time defaults. */
export function hydratePlanSteps(plannerPlan: PlannerPlan): AnalysisPlan {
    return {
        ...plannerPlan,
        steps: plannerPlan.steps.map((s) => ({
            ...s,
            status: "pending" as const,
            maxSteps: DEFAULT_SANDBOX_MAX_STEPS,
        })),
    };
}

// ── Planning agent structured output ─────────────────────────────────

/** Schema for the planning agent's structured output. */
export const PlanningAgentOutputSchema = z.object({
    event: z.enum(["plan_complete", "clarification_needed", "error"]),
    planId: z.string().optional(),
    plan: PlannerPlanSchema.optional(),
    question: z.string().optional(),
    questionContext: z.string().optional(),
    error: z.string().optional(),
});

export type PlanningAgentOutput = z.infer<typeof PlanningAgentOutputSchema>;
