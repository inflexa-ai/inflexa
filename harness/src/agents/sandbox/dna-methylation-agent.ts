/**
 * DNA Methylation Agent — methylation array and bisulfite sequencing specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { dnaMethylationAgentPrompt } from "../../prompts/sandbox/dna-methylation-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "dna-methylation-agent",
    capabilities: ["methylation array analysis", "bisulfite-seq analysis", "DMP detection", "DMR detection", "methylation clocks", "cell type deconvolution"],
    suitableFor: ["methylation-array", "wgbs", "rrbs", "epic", "450k"],
    skills: ["dna-methylation", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "searchPathway", "lookupGoTerm", "searchInteractions"],
};

export function createDnaMethylationAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, dnaMethylationAgentPrompt);
}
