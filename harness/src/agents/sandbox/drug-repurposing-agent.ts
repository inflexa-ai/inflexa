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
    skills: ["drug-repurposing", "cheminformatics", "shared/omics-general"],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "checkSafetyPanel",
        "searchPubMed",
        "getArticleDetails",
        "getArticleFullText",
        "searchGene",
        "searchPathway",
        "lookupGoTerm",
        "searchInteractions",
        "searchCompounds",
        "getBioactivity",
        "searchTargets",
        "getMechanism",
        "getDrugInfo",
        "searchOpenTargets",
        "getTargetSafety",
        "searchClinicalTrials",
        "searchFaers",
        "searchGwasCatalog",
        "searchClinvar",
        "searchDisgenet",
        "searchDrugbank",
        "searchDgidb",
        "searchBgeeExpression",
        "getImpcKoProfile",
        "searchToxcast",
        "searchCtxHazard",
        "searchCtxChemical",
        "searchCtxExposure",
    ],
};

export function createDrugRepurposingAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, drugRepurposingAgentPrompt);
}
