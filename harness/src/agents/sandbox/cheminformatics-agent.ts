/**
 * Cheminformatics Agent — molecular structure analysis, SAR triage, QSAR
 * modeling, and chemical tractability assessment.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { cheminformaticsAgentPrompt } from "../../prompts/sandbox/cheminformatics-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "cheminformatics-agent",
    capabilities: [
        "molecular property profiling",
        "scaffold decomposition",
        "structural alert filtering",
        "SAR analysis",
        "chemical diversity assessment",
        "compound library characterization",
        "QSAR modeling",
        "chemical space visualization",
        "ADMET prediction",
        "molecular descriptor calculation",
        "structure-activity relationship",
        "target engagement assessment",
        "occupancy estimation",
        "drug perturbation signature matching",
        "CMap-style connectivity scoring",
        "selectivity profiling",
        "kinase selectivity analysis",
    ],
    suitableFor: [
        "chemical-structures",
        "smiles-data",
        "compound-activity-data",
        "compound-libraries",
        "target-compound-queries",
        "sar-data",
        "target-engagement-data",
        "selectivity-panel-data",
        "perturbation-signatures",
    ],
    skills: ["cheminformatics", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "searchPathway", "lookupGoTerm", "searchInteractions", "chembl", "searchDgidb", "pubchem"],
};

export function createCheminformaticsAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, cheminformaticsAgentPrompt);
}
