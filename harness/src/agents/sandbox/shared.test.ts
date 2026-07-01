import { describe, expect, it } from "bun:test";

import { SOULKernelPrompt, SOULConversationalPrompt } from "../../prompts/SOUL.js";

import { makeFakeSandboxAgentDeps } from "./__fixtures__/deps.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent } from "./shared.js";
import type { AgentMeta } from "./types.js";
import { SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";

const meta: AgentMeta = {
    id: "test-agent",
    capabilities: ["test-cap"],
    suitableFor: ["test-suit"],
    skills: [],
    tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "searchGene"],
};

const body = "# Test Agent\n\nDo testy things.";

// Stable, placeholder-free header lines from each sandbox layer. The full
// prompts carry `{{WORKING_DIR}}` / `{{ANALYSIS_ROOT}}` placeholders that are
// substituted into the composed prompt, so the raw prompt text is not a
// substring — assert on the header marker instead.
const ORIENT_CORE_MARKER = "# Sandbox Orient-Core";
const ANALYSIS_STEP_MARKER = "# Sandbox Analysis-Step Conventions";

describe("createSandboxAgent", () => {
    it("returns an AgentDefinition with id, model, composed prompt, tools, maxIterations", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);

        expect(def.id).toBe("test-agent");
        expect(def.model).toBe("claude-opus-4-7");
        expect(def.maxIterations).toBe(SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS);

        // System prompt = SOUL kernel + agent body + sandbox layer (no conversational).
        expect(def.systemPrompt).toContain(SOULKernelPrompt.trim());
        expect(def.systemPrompt).not.toContain(SOULConversationalPrompt.trim());
        expect(def.systemPrompt).toContain(body.trim());
        expect(def.systemPrompt).toContain(ORIENT_CORE_MARKER);
        expect(def.systemPrompt).toContain(ANALYSIS_STEP_MARKER);
    });

    it("resolves meta.tools to exactly the declared bio/research tools + workspace surface", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);

        const toolIds = def.tools.map((t) => t.id);
        // Workspace surface is always wired (5 tools: execute_command, write_file,
        // edit_file, read-file, grep).
        expect(toolIds).toContain("execute_command");
        expect(toolIds).toContain("write_file");
        expect(toolIds).toContain("edit_file");
        expect(toolIds).toContain("read_file");
        expect(toolIds).toContain("grep");
        // BASE_SANDBOX_TOOLS: listAvailablePackages, listAvailableRefs, resolveLibraryId, queryDocs, inspectRun.
        expect(toolIds).toContain("list_available_packages");
        expect(toolIds).toContain("list_available_refs");
        expect(toolIds).toContain("resolve_library_id");
        expect(toolIds).toContain("query_docs");
        expect(toolIds).toContain("inspect_run");
        // Plus the two declared bio tools.
        expect(toolIds).toContain("search_pubmed");
        expect(toolIds).toContain("search_gene");
        // Nothing else from bio.
        expect(toolIds).not.toContain("search_compounds");
        expect(toolIds).not.toContain("search_faers");
        expect(toolIds).not.toContain("search_toxcast");
    });

    it("readOnly drops write_file/edit_file but keeps execute_command + read tools", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body, {
            readOnly: true,
        });

        const toolIds = def.tools.map((t) => t.id);
        // Write surface is gone.
        expect(toolIds).not.toContain("write_file");
        expect(toolIds).not.toContain("edit_file");
        // execute_command + all read tools stay.
        expect(toolIds).toContain("execute_command");
        expect(toolIds).toContain("read_file");
        expect(toolIds).toContain("list_files");
        expect(toolIds).toContain("file_stat");
        expect(toolIds).toContain("grep");
    });

    it("default (writable) sandbox agent has write_file + edit_file", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);
        const toolIds = def.tools.map((t) => t.id);
        expect(toolIds).toContain("write_file");
        expect(toolIds).toContain("edit_file");
    });

    it("appendAnalysisStepStandards=false drops the analysis-step layer", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body, {
            appendAnalysisStepStandards: false,
        });

        expect(def.systemPrompt).toContain(ORIENT_CORE_MARKER);
        expect(def.systemPrompt).not.toContain(ANALYSIS_STEP_MARKER);
    });

    it("per-agent defaultMaxSteps overrides the default cap", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), { ...meta, defaultMaxSteps: 35 }, body);
        expect(def.maxIterations).toBe(35);
    });

    it("unknown SandboxToolName throws at composition time, not at first call", () => {
        expect(() =>
            createSandboxAgent(
                makeFakeSandboxAgentDeps(),
                // @ts-expect-error — unknown name is the whole point of the test.
                { ...meta, tools: [...BASE_SANDBOX_TOOLS, "thisToolDoesNotExist"] },
                body,
            ),
        ).toThrow(/unknown SandboxToolName "thisToolDoesNotExist"/);
    });

    it("declaring the same tool twice does not duplicate it in the resolved list", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), { ...meta, tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "searchPubMed"] }, body);
        const matches = def.tools.filter((t) => t.id === "search_pubmed");
        expect(matches).toHaveLength(1);
    });
});
