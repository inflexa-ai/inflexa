/**
 * Prior-plan briefing — the plan under iteration, composed only by the planner
 * (see the conversation-briefings spec, D7). It is NOT composed in the main
 * conversation.
 *
 * `render` is PURE over `{ planId, plan }` where `plan` is the parsed
 * `AnalysisPlan` the composition site loaded (`loadPlan`). The content is the
 * analytical narrative, one line per step (id, agent, name, question,
 * dependencies), and the iteration guidance to preserve unchanged steps and
 * reuse step ids so downstream references survive.
 */

import type { AnalysisPlan } from "../../schemas/workflow-state.js";
import type { BriefingDefinition } from "./types.js";

export const PRIOR_PLAN_BRIEFING_NAME = "prior-plan";

/** The iteration guidance — preserve unchanged steps, reuse ids. */
const ITERATION_GUIDANCE =
    "The user is iterating on this plan. Preserve steps and IDs that are " +
    "not being changed; modify only what the user constraints describe. " +
    "Reuse step IDs when a step's purpose is unchanged so downstream " +
    "references survive.";

/** Typed input for the prior-plan briefing — the plan id and its parsed plan. */
export interface PriorPlanInput {
    readonly planId: string;
    readonly plan: AnalysisPlan;
}

function renderStepLine(step: AnalysisPlan["steps"][number]): string {
    const agent = step.agent ? ` (${step.agent})` : "";
    const deps = step.depends_on.length ? ` [deps: ${step.depends_on.join(", ")}]` : "";
    return `- **${step.id}**${agent}: ${step.name} — ${step.question}${deps}`;
}

function renderContent(input: PriorPlanInput): string {
    const { planId, plan } = input;
    return [
        `## Prior plan (${planId} — being iterated)`,
        "",
        ...(plan.analytical_narrative ? [`**Analytical narrative:** ${plan.analytical_narrative}`, ""] : []),
        "**Steps:**",
        ...plan.steps.map(renderStepLine),
        "",
        ITERATION_GUIDANCE,
    ].join("\n");
}

export const priorPlanBriefing: BriefingDefinition<PriorPlanInput> = {
    name: PRIOR_PLAN_BRIEFING_NAME,
    description: "The stored analysis plan the planner is being asked to iterate on.",
    mode: "standing",
    render(input) {
        const stepCount = input.plan.steps.length;
        return {
            content: renderContent(input),
            caption: `iterating ${input.planId} · ${stepCount} step${stepCount === 1 ? "" : "s"}`,
        };
    },
};
