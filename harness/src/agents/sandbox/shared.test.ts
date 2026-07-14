import { describe, expect, it } from "bun:test";

import { SOULExecutionCore, SOULIdentity, SOULConversationalPrompt } from "../../prompts/SOUL.js";
import { sandboxOrientCorePrompt, sandboxAnalysisStepStandardsPrompt } from "../../prompts/sandbox-standards.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SubmitExecBody } from "../../sandbox/types.js";
import { makeToolContext } from "../../tools/__fixtures__/tool-context.js";

import { makeFakeSandboxAgentDeps, makeFakeSandboxClient } from "./__fixtures__/deps.js";
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

const ORIENT_CORE_MARKER = "# Sandbox Orient-Core";
const ANALYSIS_STEP_MARKER = "# Sandbox Analysis-Step Conventions";

describe("createSandboxAgent", () => {
    it("returns an AgentDefinition with id, model, composed prompt, tools, maxIterations", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);

        expect(def.id).toBe("test-agent");
        expect(def.model).toBe("claude-opus-4-7");
        expect(def.maxIterations).toBe(SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS);

        // System prompt = SOUL execution core + agent body + sandbox layer. A
        // sandbox agent is headless: it carries every hard guardrail, and
        // neither human-facing layer.
        expect(def.systemPrompt).toContain(SOULExecutionCore.trim());
        expect(def.systemPrompt).not.toContain(SOULIdentity.trim());
        expect(def.systemPrompt).not.toContain(SOULConversationalPrompt.trim());
        expect(def.systemPrompt).toContain(body.trim());
        // The sandbox layers are static, so they appear verbatim — nothing is
        // substituted into them on the way in.
        expect(def.systemPrompt).toContain(sandboxOrientCorePrompt.trim());
        expect(def.systemPrompt).toContain(sandboxAnalysisStepStandardsPrompt.trim());
    });

    it("composes a systemPrompt that is a pure function of the agent type — byte-identical across steps", () => {
        // The cacheable prefix. Two different steps, of two different runs, of two
        // different analyses, on the same agent: if any per-step value leaked into
        // the system prompt, every step would pay a full cache write and read
        // nothing back. Byte equality is the whole invariant.
        const stepOne = createSandboxAgent(
            makeFakeSandboxAgentDeps({
                analysisId: "analysis-001",
                runId: "run-001",
                stepId: "step-001",
                allowedWritePrefix: "/tmp/sessions/analysis-001/runs/run-001/step-001",
            }),
            meta,
            body,
        );
        const stepTwo = createSandboxAgent(
            makeFakeSandboxAgentDeps({
                analysisId: "analysis-999",
                runId: "run-777",
                stepId: "qc-and-normalize",
                workflowId: "wf-777",
                allowedWritePrefix: "/tmp/sessions/analysis-001/runs/run-777/qc-and-normalize",
            }),
            meta,
            body,
        );

        expect(stepTwo.systemPrompt).toBe(stepOne.systemPrompt);
    });

    it("leaks no per-step value and no unsubstituted placeholder into the systemPrompt", () => {
        const def = createSandboxAgent(
            makeFakeSandboxAgentDeps({
                analysisId: "analysis-001",
                runId: "run-001",
                stepId: "step-001",
            }),
            meta,
            body,
        );

        // No placeholder survives (there are none left to substitute) …
        expect(def.systemPrompt).not.toContain("{{");
        // … and no concrete coordinate is interpolated in its place.
        for (const leak of ["analysis-001", "run-001", "step-001", "/tmp/sessions"]) {
            expect(def.systemPrompt).not.toContain(leak);
        }
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

    it("wires list_available_refs as a workflow tool through step-bound replay-safe exec coordinates", async () => {
        const submits: SubmitExecBody[] = [];
        const fake = makeFakeSandboxClient();
        const sandboxClient: SandboxClient = {
            ...fake,
            async submitExec(_sandbox, body) {
                submits.push(body);
            },
            async awaitExec(_sandbox, execId) {
                return {
                    execId,
                    exitCode: 0,
                    stdout: JSON.stringify({ state: "empty", entries: [], scannedEntries: 0, truncated: false }),
                    stderr: "",
                    durationMs: 1,
                    timedOut: false,
                };
            },
        };
        const base = makeFakeSandboxAgentDeps();
        const def = createSandboxAgent({ ...base, sandboxClient }, meta, body);
        const tool = def.tools.find((candidate) => candidate.id === "list_available_refs")!;

        expect(tool.executionMode).toBe("workflow");
        const result = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ available: true, state: "empty" });
        expect(submits).toHaveLength(1);
        expect(submits[0]!.execId).toBe("wf-001:step-001:fn-1");
        expect(submits[0]!.command.slice(0, 2)).toEqual(["python3", "-c"]);
    });

    it("wires inspect_data_profile as always-on substrate — no meta declares it", () => {
        // The profile is the only record of what the input dataset IS, and no file
        // carries it, so it is not in the `SandboxToolName` allowlist at all: every
        // sandbox agent gets it regardless of what its meta names.
        const bare = { ...meta, tools: [] as const };
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), bare, body);

        expect(def.tools.map((t) => t.id)).toContain("inspect_data_profile");
    });

    it("readOnly keeps inspect_data_profile — reading the profile is not a mutation", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body, { readOnly: true });

        expect(def.tools.map((t) => t.id)).toContain("inspect_data_profile");
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
