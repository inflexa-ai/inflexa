import { describe, expect, it } from "bun:test";

import { sandboxAnalysisStepStandardsPrompt } from "../../prompts/sandbox-standards.js";
import { bulkTranscriptomicsAgentPrompt } from "../../prompts/sandbox/bulk-transcriptomics-agent.js";
import { dataProfilerPrompt } from "../../prompts/sandbox/data-profiler.js";

import { makeFakeSandboxAgentDeps } from "./__fixtures__/deps.js";
import { createSandboxAgents, SANDBOX_AGENT_META } from "./index.js";

describe("createSandboxAgents", () => {
    const deps = makeFakeSandboxAgentDeps();
    const agents = createSandboxAgents(deps);

    it("returns one AgentDefinition per registered meta entry (key parity)", () => {
        expect(Object.keys(agents).sort()).toEqual(Object.keys(SANDBOX_AGENT_META).sort());
    });

    it("covers the full ported roster (22 agents)", () => {
        expect(Object.keys(agents)).toHaveLength(22);
    });

    it("every AgentDefinition.tools is meta.tools plus the always-on set", () => {
        // Always-on read surface every sandbox agent gets regardless of meta.
        const ALWAYS_ON_READ = ["execute_command", "read_file", "list_files", "file_stat", "grep"];
        // Writable agents also get the mutate pair. ephemeral-executor is read-only.
        const READ_ONLY_AGENTS = new Set(["ephemeral-executor"]);

        for (const [id, def] of Object.entries(agents)) {
            const meta = SANDBOX_AGENT_META[id]!;
            const toolIds = new Set(def.tools.map((t) => t.id));

            for (const required of ALWAYS_ON_READ) {
                expect(toolIds.has(required), `${id} should have ${required}`).toBe(true);
            }

            const writable = !READ_ONLY_AGENTS.has(id);
            expect(toolIds.has("write_file"), `${id} write_file`).toBe(writable);
            expect(toolIds.has("edit_file"), `${id} edit_file`).toBe(writable);

            // The fixture deps wire no blockerHolder / embedding / skillsDir, so the
            // resolved surface is exactly the always-on workspace tools + meta.tools.
            const alwaysOnCount = ALWAYS_ON_READ.length + (writable ? 2 : 0);
            const expected = alwaysOnCount + new Set(meta.tools).size;
            expect(def.tools.length, `${id} tool count`).toBe(expected);
        }
    });

    it("every AgentDefinition.systemPrompt contains the sandbox layer markers", () => {
        for (const [id, def] of Object.entries(agents)) {
            expect(def.systemPrompt.length, `${id} prompt empty`).toBeGreaterThan(100);
            // The orient-core prompt carries `{{WORKING_DIR}}` / `{{ANALYSIS_ROOT}}`
            // placeholders substituted into the composed prompt — assert on the
            // placeholder-free header marker instead of the raw prompt text.
            expect(def.systemPrompt.includes("# Sandbox Orient-Core"), `${id} missing sandboxOrientCorePrompt`).toBe(true);
        }
    });

    it("appendAnalysisStepStandards=false agents omit the analysis-step layer", () => {
        const dataProfiler = agents["data-profiler"]!;
        const ephemeral = agents["ephemeral-executor"]!;
        expect(dataProfiler.systemPrompt.includes(sandboxAnalysisStepStandardsPrompt.trim())).toBe(false);
        expect(ephemeral.systemPrompt.includes(sandboxAnalysisStepStandardsPrompt.trim())).toBe(false);
    });

    it("standard agents include the analysis-step layer", () => {
        const bulk = agents["bulk-transcriptomics-agent"]!;
        expect(bulk.systemPrompt.includes(sandboxAnalysisStepStandardsPrompt.trim())).toBe(true);
    });

    it("every AgentDefinition.model equals deps.model", () => {
        for (const [id, def] of Object.entries(agents)) {
            expect(def.model, `${id} model`).toBe("claude-opus-4-7");
        }
    });

    it("per-agent prompt text appears verbatim in the composed systemPrompt", () => {
        // Spot-check parity for two agents — one with appendAnalysisStepStandards
        // (bulk-transcriptomics-agent) and one without (data-profiler).
        expect(agents["bulk-transcriptomics-agent"]!.systemPrompt.includes(bulkTranscriptomicsAgentPrompt.trim())).toBe(true);
        expect(agents["data-profiler"]!.systemPrompt.includes(dataProfilerPrompt.trim())).toBe(true);
    });

    it("network-agent has the per-meta defaultMaxSteps override (35)", () => {
        expect(agents["network-agent"]!.maxIterations).toBe(35);
    });

    it("non-plannable agents flagged in meta carry plannable=false", () => {
        expect(SANDBOX_AGENT_META["data-profiler"]!.plannable).toBe(false);
        expect(SANDBOX_AGENT_META["scientific-executor"]!.plannable).toBe(false);
        expect(SANDBOX_AGENT_META["ephemeral-executor"]!.plannable).toBe(false);
    });
});
