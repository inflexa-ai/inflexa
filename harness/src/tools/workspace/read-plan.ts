/**
 * readPlan tool — gives the text of a stored plan to the model.
 *
 * `show_plan` shows the card of a stored plan to the user, and the model gets
 * no plan text from it. After a summary replaces the conversation, the model
 * holds only the id of each plan. This tool reads the plan again by that id.
 *
 * With no step id, the result is the view that `generate_plan` gave: the plan
 * with no `grounding.settings`. With step ids, the result holds only those
 * steps, each with its settings.
 *
 * Dependency-bearing: the factory captures the database `Pool`. The analysis
 * id comes from the request-scoped `Session`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { scopeResource } from "../../auth/types.js";
import { PLAN_ID_RE } from "../../contracts/schemas/chat-parts.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { PlanClaimTitle } from "../../schemas/plan-schemas.js";
import { claimTitlesOf, planForModel } from "../../schemas/plan-view.js";
import { AnalysisPlanSchema, type AnalysisPlan } from "../../schemas/workflow-state.js";
import { loadPlanRecord, type PlanRowQuerier } from "../../state/plans.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

/** The cap of the result: a stored plan is as long as the result of `generate_plan`. */
const READ_PLAN_RESULT_CAP = 96 * 1024;

const ReadPlanInputSchema = z.object({
    planId: z
        .string()
        .regex(PLAN_ID_RE, "planId must match pln-<8hex>")
        .describe("Plan ID (`pln-<8hex>`) from `generate_plan`, from `inspect_run`, or from the conversation summary"),
    stepIds: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
            "The ids of the steps to read in full, each with its `grounding.settings` (for example `T1S2`). Omit to read the whole plan with no settings.",
        ),
});

/** The plan of the result: the stored plan with no claim views, because `claims` gives their titles. */
type PlanText = Omit<AnalysisPlan, "claims">;

type ReadPlanOutput =
    | { found: false; reason: "plan_not_found" }
    | {
          found: true;
          planId: string;
          parentPlanId?: string;
          supersededBy?: string;
          plan: PlanText;
          claims?: PlanClaimTitle[];
          /** The ids of `stepIds` that the plan does not hold. */
          absentStepIds?: string[];
      };

/** The plan with only the steps of `stepIds`, and the claim titles that those steps cite. */
function stepsOf(plan: AnalysisPlan, stepIds: readonly string[]): { plan: PlanText; claims: PlanClaimTitle[]; absent: string[] } {
    const { claims: views = [], ...text } = plan;
    const wanted = new Set(stepIds);
    const steps = plan.steps.filter((step) => wanted.has(step.id));
    const cited = new Set(steps.flatMap((step) => step.grounding?.claims ?? []));
    const held = new Set(steps.map((step) => step.id));
    return {
        plan: { ...text, steps },
        claims: claimTitlesOf(views.filter((view) => cited.has(view.id))),
        absent: stepIds.filter((id) => !held.has(id)),
    };
}

export function createReadPlanTool(pool: PlanRowQuerier): Tool<z.infer<typeof ReadPlanInputSchema>, ReadPlanOutput> {
    return defineTool({
        id: "read_plan",
        description:
            "Read the text of a STORED plan by its planId. Use it when you do not hold the plan in this conversation, for example after a `[Conversation Summary]` replaced it: " +
            "to compare two plans, to answer a question about a step, or to explain an earlier plan. " +
            "With no `stepIds`, the result is the plan as `generate_plan` gave it: each step with its `grounding` and no `grounding.settings`, and `claims` with the title and the strength of each cited rule. " +
            "With `stepIds`, the result holds only those steps, each with its `grounding.settings` (the name, the value, and the source of each parameter), " +
            "and `absentStepIds` names each id that the plan does not hold. Read the settings of a step only when the question is about a value. " +
            "`parentPlanId` names the plan that this plan revises, and `supersededBy` names the newest revision of this plan. " +
            "The call shows nothing to the user: `show_plan` shows the card of a stored plan. " +
            "`found: false` with `plan_not_found` means that this analysis holds no plan with that id.",
        inputSchema: ReadPlanInputSchema,
        resultCap: READ_PLAN_RESULT_CAP,
        view: {
            input: (input) => input,
            error: true,
        },
        describeCall: ({ planId, stepIds }) => (stepIds === undefined ? planId : `${planId}: ${stepIds.join(", ")}`),
        execute: async ({ planId, stepIds }, ctx): Promise<Result<ReadPlanOutput, ToolError>> => {
            const analysisId = scopeResource(ctx.session.scope).resourceId;
            const record = unwrapOrThrow(await loadPlanRecord(pool, planId, { analysisId }));
            // An absent plan and a stored plan that does not parse are expected outcomes, thus they are data and no error.
            const parsed = record === null ? undefined : AnalysisPlanSchema.safeParse(record.plan);
            if (record === null || parsed === undefined || !parsed.success) return ok({ found: false as const, reason: "plan_not_found" as const });

            const lineage = { planId, parentPlanId: record.parentPlanId ?? undefined, supersededBy: record.supersededBy ?? undefined };
            if (stepIds !== undefined) {
                const { plan, claims, absent } = stepsOf(parsed.data, stepIds);
                return ok({
                    found: true as const,
                    ...lineage,
                    plan,
                    claims: claims.length > 0 ? claims : undefined,
                    absentStepIds: absent.length > 0 ? absent : undefined,
                });
            }
            const { claims: views = [], ...text } = parsed.data;
            return ok({ found: true as const, ...lineage, plan: planForModel(text), claims: views.length > 0 ? claimTitlesOf(views) : undefined });
        },
    });
}
