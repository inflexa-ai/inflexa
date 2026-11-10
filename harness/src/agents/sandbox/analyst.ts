/**
 * Analyst — each analysis of data: the omics modalities, the statistics, the genetic variants, and the
 * preparation of MDV assets. The methods are in the skills.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { analystPrompt } from "../../prompts/sandbox/analyst.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "analyst",
    description:
        "Each analysis of data: the omics modalities, single-cell and spatial data, genetic variants, statistics and machine learning, enrichment and networks, multi-omics integration, and the preparation of MDV assets.",
    skills: [
        "bulk-transcriptomics",
        "shared/omics-general",
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
        "immune-profiling",
        "mdv-preparation",
    ],
    // The lookups of the gene spaces and the variants. The drug, safety, and trial lookups belong to the drug
    // analyst: their descriptions are load on each request of a step that does not use them.
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "pubmed",
        "searchGeoDatasets",
        "searchGene",
        "resolveGeneIds",
        "lookupAnnotation",
        "searchInteractions",
        "humanbase",
        "getVariantFrequencies",
        "getProteinDomains",
    ],
};

export function createAnalystAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, analystPrompt);
}
