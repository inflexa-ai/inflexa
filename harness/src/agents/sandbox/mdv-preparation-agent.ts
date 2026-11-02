/**
 * MDV Preparation Agent — turns single-cell, scATAC-seq, spatial transcriptomics, and spatial
 * proteomics data into curated, validated projects for MDV (Multi-Dimensional Viewer).
 */

import type { AgentDefinition } from "../../loop/types.js";
import { mdvPreparationAgentPrompt } from "../../prompts/sandbox/mdv-preparation-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "mdv-preparation-agent",
    capabilities: [
        "MDV project preparation",
        "single-cell data to MDV conversion",
        "spatial data to MDV conversion",
        "metadata curation for visualization",
        "MDV view building",
        "MDV project validation",
    ],
    suitableFor: [
        "scrna-seq",
        "snrna-seq",
        "scatac-seq",
        "multiome",
        "cosmx",
        "xenium",
        "visium",
        "merfish",
        "codex",
        "imc",
        "mibi",
        "anndata",
        "mudata",
        "spatialdata",
    ],
    skills: ["mdv-preparation", "single-cell", "spatial-omics", "chromatin-regulation", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS],
};

export function createMdvPreparationAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, mdvPreparationAgentPrompt);
}
