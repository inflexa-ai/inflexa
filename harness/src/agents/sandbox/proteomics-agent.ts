/**
 * Proteomics Agent — mass spectrometry and protein quantification specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { proteomicsAgentPrompt } from "../../prompts/sandbox/proteomics-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "proteomics-agent",
    capabilities: ["protein quantification", "differential abundance", "imputation", "normalization", "PTM analysis", "phosphoproteomics"],
    suitableFor: ["dda-proteomics", "dia-proteomics", "tmt-proteomics", "olink", "somascan"],
    skills: ["proteomics", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed"],
};

export function createProteomicsAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, proteomicsAgentPrompt);
}
