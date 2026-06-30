/**
 * Spatial Omics Agent — spatially-resolved transcriptomics and proteomics specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { spatialOmicsAgentPrompt } from "../../prompts/sandbox/spatial-omics-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "spatial-omics-agent",
    capabilities: ["spatial statistics", "spatial domain detection", "deconvolution", "niche analysis", "spatial autocorrelation", "ligand-receptor spatial"],
    suitableFor: ["visium", "merfish", "slide-seq", "codex", "xenium", "mibi", "imc"],
    skills: ["spatial-omics", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "getArticleFullText", "searchGeoDatasets"],
};

export function createSpatialOmicsAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, spatialOmicsAgentPrompt);
}
