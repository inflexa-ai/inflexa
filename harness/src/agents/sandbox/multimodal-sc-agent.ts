/**
 * Multimodal Single-Cell Agent — multi-modal single-cell integration specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { multimodalScAgentPrompt } from "../../prompts/sandbox/multimodal-sc-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "multimodal-sc-agent",
    capabilities: ["multimodal integration", "joint embedding", "cross-modality analysis", "protein quantification", "chromatin accessibility"],
    suitableFor: ["cite-seq", "multiome", "tea-seq", "dogma-seq"],
    skills: ["multimodal-single-cell", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed"],
};

export function createMultimodalScAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, multimodalScAgentPrompt);
}
