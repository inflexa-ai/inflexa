/**
 * Translational Safety Agent — drug safety / toxicology / adverse-event specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { translationalSafetyAgentPrompt } from "../../prompts/sandbox/translational-safety-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

/**
 * Named once, because the capability phrase is the key of its own data requirement below and a
 * plan step copies it verbatim. Two spellings of one capability would lose the pre-launch check.
 */
const MATCHED_NEGATIVE_CAPABILITY =
    "matched negative gene set for a tissue risk benchmark (annotation_free or tested_clean negatives) matched on tissue expression and PPI connectivity with mouse and human phenotype annotation exclusions";

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
        MATCHED_NEGATIVE_CAPABILITY,
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
    // The method of this capability reads six opt-in datasets. Without any one of them a negatives
    // file would carry a label the run cannot defend, so the launch refuses rather than spend a run.
    // The recommended datasets it also reads (the expression table, the network, the gene tables,
    // the GO collection) stay out: a default store holds them, and declaring one would refuse a
    // launch an embedder already provisioned.
    dataRequirements: [
        {
            capability: MATCHED_NEGATIVE_CAPABILITY,
            datasets: [
                "string-aliases-human",
                "mgi-mouse-human-homology",
                "impc-phenotyping",
                "hpo-annotations",
                "opentargets-mouse-phenotype",
                "opentargets-target-safety-event",
            ],
        },
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
