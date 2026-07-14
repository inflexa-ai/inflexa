/**
 * Network Agent — network and regulatory analysis specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { networkAgentPrompt } from "../../prompts/sandbox/network-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "network-agent",
    capabilities: ["network analysis", "co-expression networks", "regulatory analysis", "module detection", "TF activity inference"],
    suitableFor: ["expression-matrices", "correlation-matrices", "general-omics"],
    skills: ["network-regulatory", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "searchPathway", "lookupGoTerm", "searchInteractions"],
    defaultMaxSteps: 35,
};

export function createNetworkAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, networkAgentPrompt);
}
