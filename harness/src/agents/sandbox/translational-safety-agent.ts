/**
 * Translational Safety Agent — drug safety / toxicology / adverse-event specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { translationalSafetyAgentPrompt } from "../../prompts/sandbox/translational-safety-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "translational-safety-agent",
    capabilities: [
        "safety biomarker analysis",
        "structural safety assessment",
        "adverse event profiling",
        "target safety assessment",
        "CYP liability analysis",
        "drug-drug interaction assessment",
        "in-vitro toxicology screening",
        "CTCAE grading",
        "hepatotoxicity assessment",
        "cardiotoxicity assessment",
        "nephrotoxicity assessment",
        "hematological toxicity assessment",
        "mouse KO phenotype lookup",
        "cross-species baseline expression lookup",
        "matched negative gene set for a tissue risk benchmark from tissue expression, PPI connectivity, and mouse and human phenotype annotations (annotation-free or tested-clean negatives)",
        "expression and PPI connectivity matching",
    ],
    suitableFor: [
        "safety-biomarkers",
        "adverse-events",
        "toxicity-data",
        "compound-safety",
        "clinical-safety-labs",
        "drug-interaction-data",
        "pharmacogenomic-data",
        "gene-lists",
    ],
    skills: ["translational-safety", "cheminformatics", "shared/omics-general"],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "targetSafety",
        "pubmed",
        "searchGene",
        "lookupAnnotation",
        "searchInteractions",
        "opentargets",
        "searchFaers",
        "drugGeneInteractions",
        "comptox",
        "genePreclinicalProfile",
    ],
};

export function createTranslationalSafetyAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, translationalSafetyAgentPrompt);
}
