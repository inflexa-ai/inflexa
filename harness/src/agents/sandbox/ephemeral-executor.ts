/**
 * Ephemeral Executor — read-only sandbox agent for quick computations.
 * Cannot create files; step conventions don't apply.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { ephemeralExecutorPrompt } from "../../prompts/sandbox/ephemeral-executor.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "ephemeral-executor",
    capabilities: ["data inspection", "quick statistics", "data transformation", "table preview"],
    suitableFor: ["bulk-rna-seq", "single-cell", "proteomics", "metabolomics", "genomics", "transcriptomics", "general-omics"],
    skills: ["shared/omics-general"],
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
    plannable: false,
};

export function createEphemeralExecutorAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, ephemeralExecutorPrompt, {
        appendAnalysisStepStandards: false,
        readOnly: true,
    });
}
