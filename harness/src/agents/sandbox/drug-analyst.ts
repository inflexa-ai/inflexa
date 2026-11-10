/**
 * Drug Analyst — the work on compounds, exposure, safety, and drug repurposing, with the lookups of outside
 * evidence about compounds, targets, adverse events, trials, and approvals.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { drugAnalystPrompt } from "../../prompts/sandbox/drug-analyst.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "drug-analyst",
    description:
        "The work on drugs and compounds: chemical structures and their activity, exposure and response in patients, safety and adverse events, and the use of a drug for a new indication.",
    skills: [
        "cheminformatics",
        "shared/omics-general",
        "translational-safety",
        "pkpd-clinical-response",
        "statistical-modeling",
        "drug-repurposing",
        "genomic-variants",
    ],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "pubmed",
        "searchGene",
        "lookupAnnotation",
        "searchInteractions",
        "chembl",
        "drugGeneInteractions",
        "pubchem",
        "targetSafety",
        "opentargets",
        "searchFaers",
        "comptox",
        "genePreclinicalProfile",
        "searchClinicalTrials",
        "searchRegulatoryApprovals",
        "geneDiseaseEvidence",
    ],
};

export function createDrugAnalystAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, drugAnalystPrompt);
}
