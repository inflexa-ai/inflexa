/**
 * Bulk Transcriptomics Agent — bulk RNA-seq and microarray analysis specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { bulkTranscriptomicsAgentPrompt } from "../../prompts/sandbox/bulk-transcriptomics-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "bulk-transcriptomics-agent",
    capabilities: [
        "differential expression",
        "normalization",
        "batch correction",
        "quality control",
        "count-based statistical modeling",
        "microarray analysis",
    ],
    suitableFor: ["bulk-rna-seq", "microarray"],
    skills: ["bulk-transcriptomics", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGeoDatasets"],
};

export function createBulkTranscriptomicsAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, bulkTranscriptomicsAgentPrompt);
}
