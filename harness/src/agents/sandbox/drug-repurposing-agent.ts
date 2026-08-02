/**
 * Drug Repurposing Agent — multi-evidence drug-indication mapping specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { drugRepurposingAgentPrompt } from "../../prompts/sandbox/drug-repurposing-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "drug-repurposing-agent",
    capabilities: [
        "signature-based drug repurposing",
        "target-based drug repurposing",
        "genetics-based drug repurposing",
        "network proximity analysis",
        "multi-evidence candidate ranking",
        "clinical evidence mining",
        "drug-indication mapping",
        "preclinical target intelligence (KO + expression)",
    ],
    suitableFor: ["drug-repurposing", "drug-repositioning", "indication-expansion", "target-drug-mapping", "therapeutic-candidates", "perturbation-signatures"],
    // `genomic-variants` carries the Mendelian randomization reference. The
    // genetics-based repurposing strategy turns on whether a target's disease
    // association is causal, and MR is the test — without this the pack points at
    // a reference the agent cannot read.
    skills: ["drug-repurposing", "cheminformatics", "genomic-variants", "shared/omics-general"],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "targetSafety",
        "pubmed",
        "searchGene",
        "lookupAnnotation",
        "searchInteractions",
        "chembl",
        "opentargets",
        "searchClinicalTrials",
        "searchFaers",
        "geneDiseaseEvidence",
        "drugGeneInteractions",
        "genePreclinicalProfile",
        "comptox",
    ],
};

export function createDrugRepurposingAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, drugRepurposingAgentPrompt);
}
