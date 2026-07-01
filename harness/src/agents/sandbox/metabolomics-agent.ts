/**
 * Metabolomics Agent — metabolomics and lipidomics analysis specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { metabolomicsAgentPrompt } from "../../prompts/sandbox/metabolomics-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "metabolomics-agent",
    capabilities: ["peak detection", "feature alignment", "metabolite annotation", "normalization", "statistical analysis", "pathway mapping"],
    suitableFor: ["untargeted-metabolomics", "targeted-metabolomics", "lipidomics"],
    skills: ["metabolomics", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "getArticleFullText"],
};

export function createMetabolomicsAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, metabolomicsAgentPrompt);
}
