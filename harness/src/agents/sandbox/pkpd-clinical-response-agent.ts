/**
 * PK/PD & Clinical Response Agent — PK/PD modeling and clinical response specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { pkpdClinicalResponseAgentPrompt } from "../../prompts/sandbox/pkpd-clinical-response-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "pkpd-clinical-response-agent",
    capabilities: [
        "non-compartmental PK analysis",
        "population PK covariate modeling",
        "exposure-response modeling",
        "dose-response curve fitting",
        "clinical response classification",
        "RECIST evaluation",
        "responder stratification",
        "therapeutic window identification",
        "waterfall and spider plots",
        "pharmacodynamic biomarker tracking",
        "PD marker time-series analysis",
        "PK-PD hysteresis analysis",
        "tissue-of-action expression lookup",
        "preclinical KO tolerability prior",
    ],
    suitableFor: [
        "pharmacokinetic-data",
        "concentration-time-data",
        "dose-response-data",
        "clinical-response-data",
        "exposure-response-data",
        "pk-omics-integration",
        "pharmacodynamic-biomarker-data",
        "longitudinal-pd-data",
    ],
    skills: ["pkpd-clinical-response", "statistical-modeling", "shared/omics-general"],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "searchPubMed",
        "getArticleDetails",
        "getArticleFullText",
        "searchGene",
        "searchPathway",
        "lookupGoTerm",
        "searchInteractions",
        "searchClinicalTrials",
        "searchFaers",
        "searchPharmgkb",
        "searchCompounds",
        "getBioactivity",
        "searchTargets",
        "getMechanism",
        "getDrugInfo",
        "searchDgidb",
        "searchBgeeExpression",
        "getImpcKoProfile",
    ],
};

export function createPkpdClinicalResponseAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, pkpdClinicalResponseAgentPrompt);
}
