/**
 * The planner catalog: the id, the description, and the live lookups of each enabled executor of the resolved agent
 * catalog. The planner reads it when it makes a plan, thus a new executor reaches the next plan.
 */

import { executorsOf, type ResolvedCatalog } from "../catalog/resolve.js";
import { liveSourcesOf } from "../connectors/build.js";

/** Planner-facing metadata for one executor. */
export type PlannerAgentMeta = {
    readonly id: string;
    readonly description: string;
    /** The public databases that the agent queries at run time, thus a step of the agent needs no staged copy of them. */
    readonly liveSources: readonly string[];
};

/** The executors that the planner can assign to a plan step. */
export function plannerCatalogOf(resolved: ResolvedCatalog): readonly PlannerAgentMeta[] {
    return executorsOf(resolved).map((agent) => ({ id: agent.id, description: agent.description, liveSources: liveSourcesOf(agent.attachments.connectors) }));
}

/**
 * Render the catalog as the markdown block the planner prompt expects in
 * place of its `{{AGENT_CATALOG}}` placeholder.
 */
export function formatAgentCatalog(catalog: readonly PlannerAgentMeta[]): string {
    return catalog
        .map((meta) => {
            const live = meta.liveSources.length === 0 ? "" : `, live lookups: [${meta.liveSources.join(", ")}]`;
            return `- **${meta.id}**: ${meta.description}${live}`;
        })
        .join("\n");
}
