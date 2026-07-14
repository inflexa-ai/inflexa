/**
 * Multi-Omics Integration Agent — cross-modality data integration specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { multiOmicsIntegrationAgentPrompt } from "../../prompts/sandbox/multi-omics-integration-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "multi-omics-integration-agent",
    capabilities: [
        "multi-omics integration",
        "factor analysis",
        "supervised integration",
        "network fusion",
        "cross-modality analysis",
        "preclinical target context (mouse KO, cross-species expression)",
    ],
    suitableFor: ["multi-omics", "cross-modality-integration"],
    skills: ["multi-omics-integration", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "searchPathway", "lookupGoTerm", "searchInteractions", "searchBgeeExpression", "getImpcKoProfile"],
};

export function createMultiOmicsIntegrationAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, multiOmicsIntegrationAgentPrompt);
}
