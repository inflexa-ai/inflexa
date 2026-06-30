/**
 * Microbiome Agent — amplicon and metagenomic analysis specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { microbiomeAgentPrompt } from "../../prompts/sandbox/microbiome-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "microbiome-agent",
    capabilities: ["diversity analysis", "differential abundance", "taxonomic profiling", "functional profiling", "compositional analysis"],
    suitableFor: ["16s-amplicon", "its-amplicon", "shotgun-metagenomics", "functional-profiling"],
    skills: ["microbiome", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "getArticleFullText"],
};

export function createMicrobiomeAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, microbiomeAgentPrompt);
}
