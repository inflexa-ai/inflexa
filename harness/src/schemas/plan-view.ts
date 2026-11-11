/**
 * The views of a plan that the conversation agent reads. The module imports types only, thus a tool of the
 * workspace can use it with no import of the agent catalog.
 */

import type { PlanClaimTitle } from "./plan-schemas.js";
import type { AnalysisStep, ClaimView } from "./workflow-state.js";

/** The title of each claim view, for the conversation agent. */
export function claimTitlesOf(views: readonly ClaimView[]): PlanClaimTitle[] {
    return views.map((view) => ({ id: view.id, title: view.title, strength: view.strength }));
}

/**
 * The plan as the conversation agent reads it: each step without its `grounding.settings`. The settings are a copy
 * of the knowledge answer that the host binds at dispatch. The stored plan and the plan card keep them, and the
 * conversation agent cannot change one, thus they only add to each later request of the thread.
 */
export function planForModel<P extends { readonly steps: ReadonlyArray<Pick<AnalysisStep, "grounding">> }>(plan: P): P {
    return {
        ...plan,
        steps: plan.steps.map((step) => {
            if (step.grounding?.settings === undefined) return step;
            const { settings: _settings, ...grounding } = step.grounding;
            return { ...step, grounding };
        }),
    };
}
