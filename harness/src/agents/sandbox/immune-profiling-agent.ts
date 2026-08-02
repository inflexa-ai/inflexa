/**
 * Immune Profiling Agent — immune deconvolution and IO biomarker specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { immuneProfilingAgentPrompt } from "../../prompts/sandbox/immune-profiling-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "immune-profiling-agent",
    capabilities: [
        "immune cell deconvolution",
        "immune signature scoring",
        "checkpoint expression analysis",
        "tumor microenvironment classification",
        "TCR/BCR repertoire analysis",
        "immune-clinical outcome correlation",
        "IO response prediction",
    ],
    suitableFor: [
        "bulk-immune-profiling",
        "tumor-microenvironment",
        "io-biomarkers",
        "immune-deconvolution",
        "checkpoint-expression",
        "tcr-bcr-data",
        "immune-cell-composition",
    ],
    // `single-cell` carries the scirpy reference, which is the route from 10x
    // VDJ / AIRR files to called clonotypes — the input every repertoire metric
    // in `immune-profiling` assumes it already has.
    skills: ["immune-profiling", "single-cell", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "lookupAnnotation", "searchInteractions", "searchGeoDatasets", "opentargets"],
};

export function createImmuneProfilingAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, immuneProfilingAgentPrompt);
}
