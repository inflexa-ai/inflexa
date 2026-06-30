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
    tools: [...BASE_SANDBOX_TOOLS],
    // Profiling fans out one programmatic pass per input file (head/wc preview +
    // a Python script + read-back) before the single submit_profile, so a
    // many-file analysis needs more headroom than the sandbox default.
    defaultMaxSteps: 85,
    plannable: false,
};

export function createDataProfilerAgent(deps: SandboxAgentDeps): AgentDefinition {
    return createSandboxAgent(deps, meta, dataProfilerPrompt, {
        appendAnalysisStepStandards: false,
    });
}
