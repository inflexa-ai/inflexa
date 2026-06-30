/**
 * Enrichment Agent — pathway and gene set enrichment specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { enrichmentAgentPrompt } from "../../prompts/sandbox/enrichment-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "enrichment-agent",
    capabilities: ["pathway enrichment", "gene set enrichment", "GO analysis", "functional annotation"],
    suitableFor: ["gene-lists", "ranked-lists", "score-matrices", "general-omics"],
    skills: ["enrichment", "shared/omics-general"],
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

export function createEnrichmentAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, enrichmentAgentPrompt);
}
