/**
 * Genomic Variant Agent — variant calling, annotation, and GWAS specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { genomicVariantAgentPrompt } from "../../prompts/sandbox/genomic-variant-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "genomic-variant-agent",
    capabilities: ["variant calling", "variant annotation", "GWAS", "CNV detection", "structural variant detection", "variant filtering"],
    suitableFor: ["wgs", "wes", "gwas", "cnv-sv", "targeted-panels"],
    skills: ["genomic-variants", "shared/omics-general"],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "pubmed",
        "searchGene",
        "searchPathway",
        "lookupGoTerm",
        "searchInteractions",
        "searchClinvar",
        "searchDgidb",
        "searchGwasCatalog",
    ],
};

export function createGenomicVariantAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, genomicVariantAgentPrompt);
}
