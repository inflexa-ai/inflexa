import { describe, expect, it } from "bun:test";

import { sandboxAnalysisStepStandardsPrompt, sandboxOrientCorePrompt } from "../../../prompts/sandbox-standards.js";
import { bulkTranscriptomicsAgentPrompt } from "../../../prompts/sandbox/bulk-transcriptomics-agent.js";
import { dataProfilerPrompt } from "../../../prompts/sandbox/data-profiler.js";

import { makeFakeSandboxAgentDeps } from "../__fixtures__/deps.js";
import { createSandboxAgents, SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS, SANDBOX_AGENT_META } from "../index.js";
import { BASE_SANDBOX_TOOLS } from "../shared.js";
import { presentGet } from "../../../lib/present.js";

describe("createSandboxAgents", () => {
    const deps = makeFakeSandboxAgentDeps();
    const agents = createSandboxAgents(deps);

    it("returns one AgentDefinition per registered meta entry (key parity)", () => {
        expect(Object.keys(agents).sort()).toEqual(Object.keys(SANDBOX_AGENT_META).sort());
    });

    it("covers the full ported roster (21 agents)", () => {
        expect(Object.keys(agents)).toHaveLength(21);
    });

    it("every agent lists the knowledge template through the base list, because the template follows the step, not the specialist", () => {
        expect(BASE_SANDBOX_TOOLS).toContain("knowledgeTemplate");
        for (const [id, meta] of Object.entries(SANDBOX_AGENT_META)) {
            expect(meta.tools.includes("knowledgeTemplate"), `${id} lists knowledgeTemplate`).toBe(true);
        }
    });

    it("every AgentDefinition.tools is meta.tools plus the always-on set", () => {
        // Always-on read surface every sandbox agent gets regardless of meta.
        const ALWAYS_ON_READ = ["execute_command", "read_file", "list_files", "file_stat", "grep"];
        // `inspect_data_profile` is always-on too, and deliberately absent from the
        // `SandboxToolName` allowlist: no file carries the data profile (the profiler's
        // scratch tree is deleted on completion), so every agent must be able to pull it
        // rather than re-derive the dataset's facts from the raw bytes.
        const ALWAYS_ON_PROFILE = ["inspect_data_profile"];
        // The two lease tools: the agent holds its sandbox through them, whatever its meta declares.
        const ALWAYS_ON_LEASE = ["acquire_sandbox", "release_sandbox"];
        for (const [id, def] of Object.entries(agents)) {
            const meta = presentGet(SANDBOX_AGENT_META, id);
            const all = [...def.tools, ...(def.scriptTools ?? [])];
            const toolIds = new Set(all.map((t) => t.id));

            for (const required of [...ALWAYS_ON_READ, ...ALWAYS_ON_PROFILE, ...ALWAYS_ON_LEASE]) {
                expect(toolIds.has(required), `${id} should have ${required}`).toBe(true);
            }

            expect(toolIds.has("write_file"), `${id} write_file`).toBe(true);
            expect(toolIds.has("edit_file"), `${id} edit_file`).toBe(true);

            // The fixture deps wire no blocker / embedding / skillsDir, so the
            // resolved surface is exactly the always-on tools + meta.tools. The
            // knowledge template is the one allowlist member that resolves to
            // nothing without a knowledge client, thus it does not count here.
            const alwaysOnCount = ALWAYS_ON_READ.length + ALWAYS_ON_PROFILE.length + ALWAYS_ON_LEASE.length + 2;
            const declared = new Set(meta.tools);
            declared.delete("knowledgeTemplate");
            const expected = alwaysOnCount + declared.size;
            expect(toolIds.has("knowledge_template"), `${id} knowledge_template without a client`).toBe(false);
            expect(all.length, `${id} tool count`).toBe(expected);
            // The lookups of outside sources run in a script, and the environment of the step stays direct.
            for (const tool of def.scriptTools ?? []) {
                expect(
                    ["list_available_packages", "list_available_refs", "scan_inputs", "execute_command"].includes(tool.id),
                    `${id} ${tool.id} in a script`,
                ).toBe(false);
            }
        }
    });

    it("gives the Amass regulatory tool to the drug-repurposing agent only, and the patent tool to no sandbox agent", () => {
        for (const [id, def] of Object.entries(agents)) {
            const toolIds = new Set([...def.tools, ...(def.scriptTools ?? [])].map((t) => t.id));
            expect(toolIds.has("search_regulatory_approvals"), `${id} search_regulatory_approvals`).toBe(id === "drug-repurposing-agent");
            expect(toolIds.has("search_patents"), `${id} search_patents`).toBe(false);
        }
    });

    it("every AgentDefinition.systemPrompt contains the sandbox layer verbatim", () => {
        for (const [id, def] of Object.entries(agents)) {
            expect(def.systemPrompt.length, `${id} prompt empty`).toBeGreaterThan(100);
            expect(def.systemPrompt.includes(sandboxOrientCorePrompt.trim()), `${id} missing sandboxOrientCorePrompt`).toBe(true);
        }
    });

    it("no agent's systemPrompt carries a per-step value — the whole catalog is cacheable", () => {
        // Composition is a pure function of the agent type: the fixture's analysis,
        // run, and step coordinates must reach no agent's prefix. One leak (an id, a
        // path, a leftover placeholder) and that agent's cache never hits again.
        for (const [id, def] of Object.entries(agents)) {
            expect(def.systemPrompt.includes("{{"), `${id} unsubstituted placeholder`).toBe(false);
            for (const leak of ["analysis-001", "run-001", "step-001", "/tmp/sessions"]) {
                expect(def.systemPrompt.includes(leak), `${id} leaks "${leak}"`).toBe(false);
            }
        }
    });

    it("appendAnalysisStepStandards=false agents omit the analysis-step layer", () => {
        const dataProfiler = presentGet(agents, "data-profiler");
        expect(dataProfiler.systemPrompt.includes(sandboxAnalysisStepStandardsPrompt.trim())).toBe(false);
    });

    it("standard agents include the analysis-step layer", () => {
        const bulk = presentGet(agents, "bulk-transcriptomics-agent");
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
        expect(presentGet(agents, "bulk-transcriptomics-agent").systemPrompt.includes(bulkTranscriptomicsAgentPrompt.trim())).toBe(true);
        expect(presentGet(agents, "data-profiler").systemPrompt.includes(dataProfilerPrompt.trim())).toBe(true);
    });

    it("every agent takes the shared default cap — no per-agent override", () => {
        for (const [id, meta] of Object.entries(SANDBOX_AGENT_META)) {
            expect(meta.defaultMaxSteps, id).toBeUndefined();
        }
        for (const [id, def] of Object.entries(agents)) {
            expect(def.maxIterations, id).toBe(SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS);
        }
    });

    it("non-plannable agents flagged in meta carry plannable=false", () => {
        expect(presentGet(SANDBOX_AGENT_META, "data-profiler").plannable).toBe(false);
        expect(presentGet(SANDBOX_AGENT_META, "scientific-executor").plannable).toBe(false);
    });
});
