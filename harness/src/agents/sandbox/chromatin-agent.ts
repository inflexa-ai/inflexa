/**
 * Chromatin & Regulation Agent — chromatin accessibility and TF binding specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { chromatinAgentPrompt } from "../../prompts/sandbox/chromatin-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "chromatin-agent",
    capabilities: ["peak calling", "differential binding", "differential accessibility", "motif analysis", "footprinting", "signal visualization"],
    suitableFor: ["atac-seq", "chip-seq", "cut-and-tag", "cut-and-run", "scatac-seq"],
    skills: ["chromatin-regulation", "shared/omics-general"],
    tools: [
        ...BASE_SANDBOX_TOOLS,
        "searchPubMed",
        "getArticleDetails",
        "getArticleFullText",
        "searchGene",
        "searchPathway",
        "lookupGoTerm",
        "searchInteractions",
    ],
};

export function createChromatinAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, chromatinAgentPrompt);
}
