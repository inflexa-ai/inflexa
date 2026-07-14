/**
 * Statistical Modeling Agent — survival analysis, ML, and biomarker discovery specialist.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { statisticalModelingAgentPrompt } from "../../prompts/sandbox/statistical-modeling-agent.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "statistical-modeling-agent",
    capabilities: [
        "survival analysis",
        "machine learning",
        "classification",
        "regression",
        "mixed-effects models",
        "biomarker discovery",
        "feature selection",
        "biomarker qualification",
        "predictive vs prognostic biomarker testing",
        "cutpoint optimization",
        "multi-marker panel development",
        "ROC and precision-recall analysis",
    ],
    suitableFor: [
        "survival",
        "classification",
        "regression",
        "mixed-models",
        "biomarker-discovery",
        "biomarker-qualification",
        "treatment-response",
        "patient-stratification",
    ],
    skills: ["statistical-modeling", "shared/omics-general"],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed"],
};

export function createStatisticalModelingAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, statisticalModelingAgentPrompt);
}
