/**
 * The methods of the steps of one run, read after the steps ran. The stored plan of the run gives the
 * grounding of each step and the claim views, and the step directories give the decision records. The
 * synthesis checks a method reference against these methods, and the pin of a report session takes
 * their sources as citations.
 *
 * The plan is a stored document that an older schema can have written. Thus the read takes the two
 * fields that it needs leniently: a step with no valid grounding has no grounding, and a plan with no
 * valid claim views has none.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { StepMethods, StepMethodsSource } from "../contracts/chat-parts.js";
import type { DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { ClaimViewSchema, GroundingSchema } from "../schemas/workflow-state.js";
import type { Querier } from "../state/db.js";
import { loadPlan } from "../state/plans.js";
import { isSafeId, stepWritePrefix } from "../workspace/paths.js";
import { readStepMethods } from "./step-methods.js";

/** The two fields of a stored plan that the methods read. Each other field passes. */
const StoredPlanMethodsSchema = z.looseObject({
    steps: z.array(z.looseObject({ id: z.string(), grounding: GroundingSchema.optional().catch(undefined) })).catch([]),
    claims: z.array(ClaimViewSchema).optional().catch(undefined),
});

/** The methods of one step of a run, and the full list of its sources for the citation evidence. */
export type RunStepMethods = {
    readonly stepId: string;
    readonly methods: StepMethods;
    readonly sources: readonly StepMethodsSource[];
};

/**
 * Read the methods of the steps of one run. `stepIds` selects the steps, and it defaults to the steps of
 * the plan. A run with no plan has no grounding, thus only its decision records give methods. A step with
 * no methods is absent from the result. A failed plan read is an error, because a store fault is not
 * absence.
 */
export async function readRunMethods(args: {
    readonly pool: Querier;
    readonly analysisId: string;
    readonly runId: string;
    readonly planId: string | null;
    readonly workspaceRoot: string;
    readonly stepIds?: readonly string[];
    readonly logger: Logger;
}): Promise<Result<RunStepMethods[], DbError>> {
    if (!isSafeId(args.runId)) return ok([]);
    let plan: z.infer<typeof StoredPlanMethodsSchema> = { steps: [] };
    if (args.planId !== null) {
        const loaded = await loadPlan(args.pool, args.planId, { analysisId: args.analysisId });
        if (loaded.isErr()) return err(loaded.error);
        const parsed = StoredPlanMethodsSchema.safeParse(loaded.value);
        if (parsed.success) plan = parsed.data;
    }

    const groundingById = new Map(plan.steps.map((step) => [step.id, step.grounding]));
    const out: RunStepMethods[] = [];
    for (const stepId of args.stepIds ?? plan.steps.map((step) => step.id)) {
        // A step id of the plan comes from a model, thus an id that cannot name a directory reads nothing.
        if (!isSafeId(stepId)) continue;
        const { methods, sources } = await readStepMethods({
            grounding: groundingById.get(stepId),
            claimViews: plan.claims ?? [],
            writePrefix: stepWritePrefix({ workspaceRoot: args.workspaceRoot, runId: args.runId, stepId }),
            logger: args.logger.with({ runId: args.runId, stepId }),
        });
        if (methods) out.push({ stepId, methods, sources });
    }
    return ok(out);
}
