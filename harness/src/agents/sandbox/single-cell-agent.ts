/**
 * Single-Cell Agent — single-cell RNA-seq analysis specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { singleCellAgentPrompt } from "../../prompts/sandbox/single-cell-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "single-cell-agent",
    capabilities: [
        "quality control",
        "normalization",
        "clustering",
        "cell type annotation",
        "differential expression",
        "trajectory inference",
        "cell-cell communication",
        "TF activity inference",
        "RNA velocity",
    ],
    suitableFor: ["scrna-seq", "snrna-seq", "cytof", "mass-cytometry"],
    skills: ["single-cell", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "getArticleFullText", "searchGeoDatasets"],
};

export function createSingleCellAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, singleCellAgentPrompt);
}
