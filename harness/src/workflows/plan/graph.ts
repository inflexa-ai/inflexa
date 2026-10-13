/**
 * The graph of a stored plan: each step with its agent, its dependencies, and its
 * level. The levels and the agent fallback are those of `data-dag-state`, so a
 * host draws the same graph before, during, and after a run.
 */

import type { PlanGraphStep } from "../../contracts/chat-parts.js";
import { AnalysisPlanSchema } from "../../schemas/workflow-state.js";
import { computeTopologicalLevels, validatePlanDag } from "../execute-analysis-scheduler.js";

/**
 * Give the graph of a stored plan document, in the order of the plan. An empty
 * step list gives an empty graph. A document that fails the stored plan schema, or
 * whose steps have a duplicate id, a missing dependency, or a cycle, gives `null`
 * (a plan that no run can execute has no levels).
 *
 * The throw of `validatePlanDag` is caught here, at the boundary: the function is a
 * read for a caller that has no use for the typed error.
 */
export function planGraphOf(plan: unknown): PlanGraphStep[] | null {
    const parsed = AnalysisPlanSchema.safeParse(plan);
    if (!parsed.success) return null;
    const steps = parsed.data.steps;
    try {
        validatePlanDag(steps);
    } catch {
        return null;
    }
    const levels = computeTopologicalLevels(steps);
    return steps.map((step) => ({
        id: step.id,
        name: step.name,
        agent: step.agent ?? "unknown",
        dependsOn: [...step.depends_on],
        level: levels.get(step.id) ?? 0,
    }));
}
