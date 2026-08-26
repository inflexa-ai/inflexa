/**
 * Data Profiler — characterizes datasets for downstream analysis planning.
 * Produces a JSON summary (no scripts/output/figures), so step conventions
 * are not appended.
 */

import type { AgentDefinition } from "../../loop/types.js";
import { dataProfilerPrompt } from "../../prompts/sandbox/data-profiler.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent, type SandboxAgentDeps } from "./shared.js";
import type { AgentMeta } from "./types.js";

export const meta: AgentMeta = {
    id: "data-profiler",
    capabilities: ["data profiling", "literature review", "methodology research", "analysis planning", "experimental design analysis"],
    suitableFor: ["bulk-rna-seq", "single-cell", "proteomics", "metabolomics", "genomics", "transcriptomics", "chemical-structures", "compound-screening"],
    skills: [],
    // `scanInputs` is the profiler's own instrument: the workflow injects one scan into
    // its briefing, and the tool is how it re-scans a subtree it wants to group
    // differently. Declared rather than bolted on, so the resolved roster stays
    // `meta.tools` plus the always-on set.
    tools: [...BASE_SANDBOX_TOOLS, "scanInputs"],
    plannable: false,
};

export function createDataProfilerAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, dataProfilerPrompt, {
        appendAnalysisStepStandards: false,
    });
}
