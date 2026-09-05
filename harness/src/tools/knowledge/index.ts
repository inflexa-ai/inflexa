/**
 * Knowledge barrel — the three tools of the knowledge plane and the client
 * seam they share.
 *
 * `createKnowledgeTools` gives the two planner tools when a client is bound,
 * and nothing when it is not. Absence is the default state of the open-source
 * host, and it is a normal condition: no tool attaches, no description enters
 * the context, and the planner works from the prose skills as it does today.
 * The template tool binds per step, because it needs the mutator of the step.
 */

import type { Tool } from "../define-tool.js";
import type { KnowledgeClient } from "./client.js";
import { createKnowledgeCheckTool } from "./check.js";
import { createKnowledgeRecommendTool } from "./recommend.js";

export * from "./client.js";
export * from "./check.js";
export * from "./recommend.js";
export * from "./situation.js";
export * from "./template.js";

export interface KnowledgeToolsDeps {
    readonly client?: KnowledgeClient;
}

/** The planner tools: `knowledge_recommend` and `knowledge_check`, or an empty list with no client. */
export function createKnowledgeTools(deps: KnowledgeToolsDeps): Tool[] {
    if (!deps.client) return [];
    return [createKnowledgeRecommendTool({ client: deps.client }), createKnowledgeCheckTool({ client: deps.client })];
}
