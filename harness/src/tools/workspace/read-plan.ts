/**
 * read_plan tool — gives a stored plan to the model.
 *
 * `show_plan` shows the card of a stored plan to the user, and the model gets no plan text from it. After a
 * summary replaces the conversation, the model holds only the id of each plan. This tool reads the plan again by
 * that id: the outline of the plan, or one step in full with the rules that it cites.
 *
 * Dependency-bearing: the factory captures the database `Pool`. The analysis id comes from the request-scoped
 * `Session`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { scopeResource } from "../../auth/types.js";
import { PLAN_ID_RE } from "../../contracts/schemas/chat-parts.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { PlanOutline } from "../../schemas/plan-schemas.js";
import { planOutline } from "../../schemas/plan-view.js";
import { AnalysisPlanSchema, type AnalysisStep, type ClaimView } from "../../schemas/workflow-state.js";
import { loadPlanRecord, type PlanRowQuerier } from "../../state/plans.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

const ReadPlanInputSchema = z.object({
    planId: z.string().regex(PLAN_ID_RE, "planId must match pln-<8hex>").describe("The plan id (`pln-<8hex>`)."),
    stepId: z.string().min(1).optional().describe("A step id of the plan. Omit for the outline of the plan."),
});

/** The plan lineage: the plan that this plan revises, and the newest revision of this plan. */
type PlanLineage = { readonly planId: string; readonly parentPlanId?: string; readonly supersededBy?: string };

type ReadPlanOutput =
    | { readonly found: false; readonly reason: "plan_not_found" | "step_not_found" }
    | (PlanLineage & { readonly found: true; readonly plan: PlanOutline })
    | (PlanLineage & { readonly found: true; readonly step: AnalysisStep; readonly claims?: readonly ClaimView[] });

export function createReadPlanTool(pool: PlanRowQuerier): Tool<z.infer<typeof ReadPlanInputSchema>, ReadPlanOutput> {
    return defineTool({
        id: "read_plan",
        description:
            "Read a stored plan by its planId, when the conversation no longer holds it. " +
            "Without `stepId`, the result is the outline of the plan. With `stepId`, the result is that step in full, with its settings and the rules that it cites.",
        inputSchema: ReadPlanInputSchema,
        view: {
            input: (input) => input,
            error: true,
        },
        describeCall: ({ planId, stepId }) => (stepId === undefined ? planId : `${planId}: ${stepId}`),
        execute: async ({ planId, stepId }, ctx): Promise<Result<ReadPlanOutput, ToolError>> => {
            const analysisId = scopeResource(ctx.session.scope).resourceId;
            const record = unwrapOrThrow(await loadPlanRecord(pool, planId, { analysisId }));
            // An absent plan and a stored plan that does not parse are expected outcomes, thus they are data and no error.
            const parsed = record === null ? undefined : AnalysisPlanSchema.safeParse(record.plan);
            if (record === null || parsed === undefined || !parsed.success) return ok({ found: false as const, reason: "plan_not_found" as const });

            const lineage: PlanLineage = { planId, parentPlanId: record.parentPlanId ?? undefined, supersededBy: record.supersededBy ?? undefined };
            if (stepId === undefined) return ok({ found: true as const, ...lineage, plan: planOutline(parsed.data) });

            const step = parsed.data.steps.find((candidate) => candidate.id === stepId);
            if (step === undefined) return ok({ found: false as const, reason: "step_not_found" as const });
            const cited = new Set(step.grounding?.claims ?? []);
            const claims = (parsed.data.claims ?? []).filter((view) => cited.has(view.id) && view.snapshot === step.grounding?.snapshot);
            return ok({ found: true as const, ...lineage, step, claims: claims.length > 0 ? claims : undefined });
        },
    });
}
