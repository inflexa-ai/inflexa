/** Adhoc Executor — writable sandbox agent for focused, unplanned work. */

import type { AgentDefinition } from "../../loop/types.js";
import { adhocExecutorPrompt } from "../../prompts/sandbox/adhoc-executor.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "adhoc-executor",
    capabilities: ["data inspection", "quick statistics", "data transformation", "table preview"],
    suitableFor: ["bulk-rna-seq", "single-cell", "proteomics", "metabolomics", "genomics", "transcriptomics", "general-omics"],
    skills: ["shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene", "searchPathway", "lookupGoTerm", "searchInteractions"],
    plannable: false,
};

export function createAdhocExecutorAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, adhocExecutorPrompt);
}
