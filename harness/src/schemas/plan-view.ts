/**
 * The views of a plan that the conversation agent reads. The plan card shows the whole plan to the user, thus the
 * agent gets an outline: what each step is, how the steps depend on each other, and the grounding of each step by
 * id. One step in full is a separate read. The module imports types only, thus a tool of the workspace can use it
 * with no import of the agent catalog.
 */

import type { PlanClaimTitle, PlanOutline } from "./plan-schemas.js";
import type { AnalysisStep, ClaimView } from "./workflow-state.js";

/** The title of each claim view, for the conversation agent. */
export function claimTitlesOf(views: readonly ClaimView[]): PlanClaimTitle[] {
    return views.map((view) => ({ id: view.id, title: view.title, strength: view.strength }));
}

/** The outline of a plan: each step with the fields that say what it does and how it is grounded. */
export function planOutline(plan: {
    readonly title?: string;
    readonly analytical_narrative: string;
    readonly steps: ReadonlyArray<Pick<AnalysisStep, "id" | "name" | "kind" | "agent" | "question" | "depends_on" | "grounding">>;
}): PlanOutline {
    return {
        title: plan.title,
        analytical_narrative: plan.analytical_narrative,
        steps: plan.steps.map((step) => ({
            id: step.id,
            name: step.name,
            kind: step.kind,
            agent: step.agent,
            question: step.question,
            depends_on: step.depends_on,
            grounding:
                step.grounding === undefined
                    ? undefined
                    : {
                          status: step.grounding.status,
                          template: step.grounding.template,
                          claims: step.grounding.claims,
                          departures: step.grounding.departures,
                      },
        })),
    };
}
