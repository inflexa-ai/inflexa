/**
 * Scientific Executor — versatile general-purpose analysis executor.
 * Non-plannable: invoked outside the plan DAG.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { scientificExecutorPrompt } from "../../prompts/sandbox/scientific-executor.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "scientific-executor",
    capabilities: [
        "differential expression",
        "statistical testing",
        "clustering",
        "dimensionality reduction",
        "pathway enrichment",
        "machine learning",
        "visualization",
        "data transformation",
    ],
    suitableFor: ["bulk-rna-seq", "single-cell", "proteomics", "metabolomics", "genomics", "transcriptomics", "general-omics"],
    skills: [
        "bulk-transcriptomics",
        "single-cell",
        "multimodal-single-cell",
        "spatial-omics",
        "proteomics",
        "metabolomics",
        "genomic-variants",
        "dna-methylation",
        "chromatin-regulation",
        "microbiome",
        "enrichment",
        "network-regulatory",
        "statistical-modeling",
        "multi-omics-integration",
        "cheminformatics",
        "translational-safety",
        "pkpd-clinical-response",
        "immune-profiling",
        "drug-repurposing",
        "shared/omics-general",
    ],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "searchPathway", "lookupGoTerm", "searchInteractions"],
    plannable: false,
};

export function createScientificExecutorAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, scientificExecutorPrompt);
}
