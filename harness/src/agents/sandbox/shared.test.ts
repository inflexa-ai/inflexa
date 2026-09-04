import { describe, expect, it } from "bun:test";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOULExecutionCore, SOULIdentity, SOULConversationalPrompt } from "../../prompts/SOUL.js";
import {
    sandboxOrientCorePrompt,
    sandboxOrientCorePromptFor,
    sandboxPackageLinkPrompt,
    sandboxAnalysisStepStandardsPrompt,
} from "../../prompts/sandbox-standards.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SubmitExecBody } from "../../sandbox/types.js";
import { makeToolContext } from "../../tools/__fixtures__/tool-context.js";

import { makeFakeSandboxAgentDeps, makeFakeSandboxClient } from "./__fixtures__/deps.js";
import { BASE_SANDBOX_TOOLS, createSandboxAgent } from "./shared.js";
import type { AgentMeta } from "./types.js";
import { SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";
import type { CitationResolver } from "../../citations/types.js";

const meta: AgentMeta = {
    id: "test-agent",
    capabilities: ["test-cap"],
    suitableFor: ["test-suit"],
    skills: [],
    tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGene"],
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
        expect(toolIds).toContain("pubmed");
        expect(toolIds).toContain("search_gene");
        // Nothing else from bio.
        expect(toolIds).not.toContain("chembl");
        expect(toolIds).not.toContain("search_faers");
        expect(toolIds).not.toContain("comptox");
    });

    // Reference discovery reads the store the host already has on disk, so it needs no
    // sandbox and no exec — the same reason it can be attached to the planner, which has
    // no sandbox at all.
    it("wires list_available_refs over the host reference store, issuing no sandbox exec", async () => {
        const submits: SubmitExecBody[] = [];
        const fake = makeFakeSandboxClient();
        const sandboxClient: SandboxClient = {
            ...fake,
            async submitExec(_sandbox, body) {
                submits.push(body);
            },
        };
        const root = await mkdtemp(join(tmpdir(), "shared-refs-"));
        const base = makeFakeSandboxAgentDeps();
        const def = createSandboxAgent({ ...base, sandboxClient, refStorePath: root }, meta, body);
        const tool = def.tools.find((candidate) => candidate.id === "list_available_refs")!;

        const result = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ available: true, state: "empty" });
        expect(submits).toHaveLength(0);
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

    it("resolves the citation tool only when the shared resolver dependency is supplied", () => {
        const citationResolver = {
            resolveOne: async () => {
                throw new Error("not executed in this roster test");
            },
            resolveMany: async () => {
                throw new Error("not executed in this roster test");
            },
        } satisfies CitationResolver;
        const citationMeta = { ...meta, tools: [...BASE_SANDBOX_TOOLS, "resolve_citation"] as const };

        expect(() => createSandboxAgent(makeFakeSandboxAgentDeps(), citationMeta, body)).toThrow(/requires a CitationResolver/);
        const def = createSandboxAgent({ ...makeFakeSandboxAgentDeps(), citationResolver }, citationMeta, body);
        expect(def.tools.map((tool) => tool.id)).toContain("resolve_citation");
    });

    it("declaring the same tool twice does not duplicate it in the resolved list", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), { ...meta, tools: [...BASE_SANDBOX_TOOLS, "pubmed", "pubmed"] }, body);
        const matches = def.tools.filter((t) => t.id === "pubmed");
        expect(matches).toHaveLength(1);
    });
});

describe("createSandboxAgent — the farm-extension seam", () => {
    const extendAnalysisFarm = async () => [];

    it("a bound seam adds link_packages to the always-on substrate, and no meta names it", () => {
        const bare = { ...meta, tools: [] as const };
        const def = createSandboxAgent({ ...makeFakeSandboxAgentDeps(), extendAnalysisFarm }, bare, body);

        expect(def.tools.map((t) => t.id)).toContain("link_packages");
        expect(def.systemPrompt).toContain(sandboxPackageLinkPrompt.trim());
    });

    it("an unbound seam means no tool and no prompt layer, and the composition does not throw", () => {
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);

        expect(def.tools.map((t) => t.id)).not.toContain("link_packages");
        expect(def.systemPrompt).not.toContain(sandboxPackageLinkPrompt.trim());
    });

    it("the layer teaches the absent-lookup trigger and gates the missing report on the link answer", () => {
        // The spec scenario "An absent lookup routes through the link tool": a
        // negative listing must route to `link_packages` BEFORE a missing
        // report — the pool can hold what the farm lock does not.
        const def = createSandboxAgent({ ...makeFakeSandboxAgentDeps(), extendAnalysisFarm }, meta, body);

        expect(def.systemPrompt).toContain("After a failed import, and when `list_available_packages`");
        expect(def.systemPrompt).toContain("Report a package as missing only after");
    });

    it("the layer teaches the ecosystem retry after a two-track collision", () => {
        // The spec scenario "The layer teaches the ecosystem retry": a
        // collision of one name that both tracks hold has a remedy, thus the
        // agent must retry with `ecosystem` before it drops the package.
        const def = createSandboxAgent({ ...makeFakeSandboxAgentDeps(), extendAnalysisFarm }, meta, body);

        expect(def.systemPrompt).toContain("call `link_packages` again for that package");
        expect(def.systemPrompt).toContain("`ecosystem` set to `python` or `r`");
        expect(def.systemPrompt).toContain("Drop the package only after that second call also refuses");
    });

    it("the description names the ecosystem retry", () => {
        // The spec scenario of the same name: the `ecosystem` field exists for
        // this second call, thus a description that calls every collision
        // terminal contradicts the field the tool carries.
        const def = createSandboxAgent({ ...makeFakeSandboxAgentDeps(), extendAnalysisFarm }, meta, body);
        const description = def.tools.find((tool) => tool.id === "link_packages")!.description;

        expect(description).toContain("call this tool again for that package with `ecosystem` set");
        expect(description).toContain("terminal only after that second call also refuses");
    });

    it("the description of list_available_packages stops at absent only when the seam is bound", () => {
        const closedWorld = "only what this tool reports is importable";
        const descriptionOf = (def: ReturnType<typeof createSandboxAgent>): string =>
            def.tools.find((tool) => tool.id === "list_available_packages")!.description;
        const bound = createSandboxAgent({ ...makeFakeSandboxAgentDeps(), extendAnalysisFarm }, meta, body);
        const unbound = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);

        expect(descriptionOf(unbound)).toContain(closedWorld);
        expect(descriptionOf(bound)).not.toContain(closedWorld);
        expect(descriptionOf(bound)).toContain("call `link_packages` before treating it as missing");
    });

    it("the layer follows the seam, and each composition stays byte-stable across its own steps", () => {
        const boundOne = createSandboxAgent({ ...makeFakeSandboxAgentDeps({ stepId: "s1" }), extendAnalysisFarm }, meta, body);
        const boundTwo = createSandboxAgent({ ...makeFakeSandboxAgentDeps({ stepId: "s2" }), extendAnalysisFarm }, meta, body);
        const unbound = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);

        expect(boundTwo.systemPrompt).toBe(boundOne.systemPrompt);
        expect(boundOne.systemPrompt).not.toBe(unbound.systemPrompt);
    });

    it("a realization throw reads as unavailable per request, never as a raw tool error", async () => {
        const def = createSandboxAgent(
            {
                ...makeFakeSandboxAgentDeps(),
                extendAnalysisFarm: async () => {
                    throw new Error("the dependency graph is unreadable");
                },
            },
            meta,
            body,
        );
        const tool = def.tools.find((t) => t.id === "link_packages")!;

        const result = (await tool.execute({ packages: [{ name: "scanpy" }, { name: "Seurat" }] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result).toEqual({
            outcomes: [
                { kind: "unavailable", name: "scanpy", reason: "the dependency graph is unreadable" },
                { kind: "unavailable", name: "Seurat", reason: "the dependency graph is unreadable" },
            ],
        });
    });

    it("link_packages calls the seam with the analysis of the step and returns the outcomes verbatim", async () => {
        const calls: Array<{ analysisId: string; names: string[] }> = [];
        const def = createSandboxAgent(
            {
                ...makeFakeSandboxAgentDeps({ analysisId: "an-42" }),
                extendAnalysisFarm: async (analysisId, requests) => {
                    calls.push({ analysisId, names: requests.map((r) => r.name) });
                    return [
                        { kind: "linked", name: "scanpy", version: "1.10.0" },
                        { kind: "absent", name: "nonesuch", acquisitionPossible: true },
                    ];
                },
            },
            meta,
            body,
        );
        const tool = def.tools.find((t) => t.id === "link_packages")!;

        const result = (await tool.execute({ packages: [{ name: "scanpy" }, { name: "nonesuch" }] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(calls).toEqual([{ analysisId: "an-42", names: ["scanpy", "nonesuch"] }]);
        expect(result).toEqual({
            outcomes: [
                { kind: "linked", name: "scanpy", version: "1.10.0" },
                { kind: "absent", name: "nonesuch", acquisitionPossible: true },
            ],
        });
    });
});

describe("createSandboxAgent — the toolchain keying of the orient core", () => {
    it("the store toolchain keeps the legacy orient core byte-identical", () => {
        expect(sandboxOrientCorePromptFor("store")).toBe(sandboxOrientCorePrompt);

        // The fixture client declares "store", the value the factory gives an
        // embedder that declares nothing.
        const def = createSandboxAgent(makeFakeSandboxAgentDeps(), meta, body);
        expect(def.systemPrompt).toContain(sandboxOrientCorePrompt.trim());
    });

    it("the declared image toolchain states that an acquisition is a host action", () => {
        const image = sandboxOrientCorePromptFor("image");
        expect(image).not.toBe(sandboxOrientCorePrompt);
        expect(image).toContain("An acquisition of a new package is a host action");
        expect(image).toContain("report it as missing");

        // The bag carries no toolchain field: the composition reads the value
        // of the client, thus the text and the environment cannot disagree.
        const deps = makeFakeSandboxAgentDeps();
        const def = createSandboxAgent({ ...deps, sandboxClient: { ...deps.sandboxClient, toolchainSource: "image" } }, meta, body);
        expect(def.systemPrompt).toContain("An acquisition of a new package is a host action");
        expect(def.systemPrompt).not.toContain(sandboxOrientCorePrompt.trim());
    });
});
