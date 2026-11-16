import { describe, expect, it } from "bun:test";

import { sandboxAnalysisStepStandardsPrompt, sandboxOrientCorePrompt } from "../../../prompts/sandbox-standards.js";
import { analystPrompt } from "../../../prompts/sandbox/analyst.js";
import { dataProfilerPrompt } from "../../../prompts/sandbox/data-profiler.js";
import { BUILTIN_AGENTS, builtinAgent } from "../../../catalog/builtins.js";
import type { CatalogServices } from "../../../catalog/equip.js";
import { createInMemoryCatalog, createInMemorySkillStore } from "../../../catalog/memory.js";
import { agentIdentityOf, resolveCatalog } from "../../../catalog/resolve.js";
import { buildConnectorTools } from "../../../connectors/build.js";
import type { AgentDefinition } from "../../../loop/types.js";

import { makeFakeSandboxAgentDeps } from "../__fixtures__/deps.js";
import { buildProfilerAgent, buildStepAgent, SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "../index.js";
import { presentGet } from "../../../lib/present.js";

const SANDBOX_AGENT_IDS = ["analyst", "drug-analyst", "data-profiler"] as const;

// A table, a paper, or a compressed file of the analysis reads on the host, thus each agent reads them in a script.
const READ_SCRIPT_TOOLS = ["read_table", "read_pdf", "list_archive"];

const skills = createInMemorySkillStore(
    [...new Set(BUILTIN_AGENTS.flatMap((agent) => agent.defaults.skills))].map((name) => ({ name, description: `The ${name} skill.` })),
);
const services: CatalogServices = { catalog: createInMemoryCatalog({ skills }), connectorBase: {} };
const deps = makeFakeSandboxAgentDeps();

const agents: Record<string, AgentDefinition> = {
    analyst: await buildStepAgent(services, deps, "analyst", undefined),
    "drug-analyst": await buildStepAgent(services, deps, "drug-analyst", undefined),
    "data-profiler": await buildProfilerAgent(services, deps),
};

describe("the sandbox agents of the catalog", () => {
    it("builds each built-in executor and the profiler under its own id", () => {
        for (const id of SANDBOX_AGENT_IDS) expect(presentGet(agents, id).id).toBe(id);
    });

    it("every AgentDefinition is the role tools plus the tools of its connectors", async () => {
        const resolved = await resolveCatalog(services.catalog);
        // The workspace, lease, profile, skill, and environment tools: each sandbox agent gets them whatever it attaches.
        const ROLE_TOOLS = [
            "acquire_sandbox",
            "release_sandbox",
            "execute_command",
            "write_file",
            "edit_file",
            "read_file",
            "list_files",
            "file_stat",
            "grep",
            "inspect_data_profile",
            "skill_search",
            "skill_read",
            "list_available_packages",
            "list_available_refs",
        ];
        for (const id of SANDBOX_AGENT_IDS) {
            const def = presentGet(agents, id);
            const connectorIds = presentGet(Object.fromEntries(resolved.agents), id).attachments.connectors;
            const connectorTools = (await buildConnectorTools(services.catalog, resolved, connectorIds, services.connectorBase)).map((tool) => tool.id);

            // The fixture deps wire no blocker, embedding, store, seam, or template step, thus the
            // direct surface is exactly the role tools, with no run_template.
            expect(new Set(def.tools.map((t) => t.id)), id).toEqual(new Set([...ROLE_TOOLS, ...(id === "data-profiler" ? ["scan_inputs"] : [])]));
            // The lookups of outside sources run in a script, and the environment of the step stays direct.
            expect(new Set((def.scriptTools ?? []).map((t) => t.id)), id).toEqual(new Set([...connectorTools, ...READ_SCRIPT_TOOLS]));
        }
    });

    it("gives the Amass regulatory tool to the drug analyst only, and the patent tool to no sandbox agent", () => {
        for (const [id, def] of Object.entries(agents)) {
            const toolIds = new Set([...def.tools, ...(def.scriptTools ?? [])].map((t) => t.id));
            expect(toolIds.has("search_regulatory_approvals"), `${id} search_regulatory_approvals`).toBe(id === "drug-analyst");
            expect(toolIds.has("search_patents"), `${id} search_patents`).toBe(false);
        }
    });

    it("gives each host lookup only to the agents that need it, as script tools", () => {
        const holders: Record<string, readonly string[]> = {
            humanbase: ["analyst"],
            // The analyst maps genes to the Entrez IDs of HumanBase and to the UniProt accessions of InterPro.
            resolve_gene_ids: ["analyst"],
            get_protein_domains: ["analyst", "drug-analyst"],
        };
        for (const [id, def] of Object.entries(agents)) {
            for (const [toolId, agentIds] of Object.entries(holders)) {
                expect(
                    def.tools.some((t) => t.id === toolId),
                    `${id} declares ${toolId} directly`,
                ).toBe(false);
                expect(
                    (def.scriptTools ?? []).some((t) => t.id === toolId),
                    `${id} ${toolId}`,
                ).toBe(agentIds.includes(id));
            }
        }
    });

    it("gives the gnomAD frequency tool to the analyst only, as a script tool", () => {
        for (const [id, def] of Object.entries(agents)) {
            expect(
                def.tools.some((t) => t.id === "get_variant_frequencies"),
                `${id} declares get_variant_frequencies directly`,
            ).toBe(false);
            expect(
                (def.scriptTools ?? []).some((t) => t.id === "get_variant_frequencies"),
                `${id} get_variant_frequencies`,
            ).toBe(id === "analyst");
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

    it("the profiler omits the analysis-step layer", () => {
        const dataProfiler = presentGet(agents, "data-profiler");
        expect(dataProfiler.systemPrompt.includes(sandboxAnalysisStepStandardsPrompt.trim())).toBe(false);
    });

    it("an executor includes the analysis-step layer", () => {
        const analyst = presentGet(agents, "analyst");
        expect(analyst.systemPrompt.includes(sandboxAnalysisStepStandardsPrompt.trim())).toBe(true);
    });

    it("the step contract holds no working preference, which belongs to the agent body", () => {
        expect(sandboxAnalysisStepStandardsPrompt).not.toContain("## Language Policy");
        expect(sandboxAnalysisStepStandardsPrompt).not.toContain("## Figure Standards");
        for (const id of ["analyst", "drug-analyst"]) expect(presentGet(agents, id).systemPrompt, id).toContain("## How You Work");
    });

    it("every AgentDefinition.model equals deps.model", () => {
        for (const [id, def] of Object.entries(agents)) {
            expect(def.model, `${id} model`).toBe("claude-opus-4-7");
        }
    });

    it("per-agent prompt text appears verbatim in the composed systemPrompt", () => {
        // Spot-check parity for two agents — one with appendAnalysisStepStandards
        // (analyst) and one without (data-profiler).
        expect(presentGet(agents, "analyst").systemPrompt.includes(analystPrompt.trim())).toBe(true);
        expect(presentGet(agents, "data-profiler").systemPrompt.includes(dataProfilerPrompt.trim())).toBe(true);
    });

    it("every agent takes the shared default cap — no per-agent override", () => {
        for (const id of SANDBOX_AGENT_IDS) {
            expect(builtinAgent(id).defaultMaxSteps, id).toBeUndefined();
        }
        for (const [id, def] of Object.entries(agents)) {
            expect(def.maxIterations, id).toBe(SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS);
        }
    });

    it("a step on the profiler runs on the analyst, because the profiler is not an executor", async () => {
        expect(builtinAgent("data-profiler").role).toBe("profiler");
        const def = await buildStepAgent(services, deps, "data-profiler", undefined);
        expect(def.id).toBe("analyst");
        expect(def.tools.map((t) => t.id)).not.toContain("scan_inputs");
    });
});

describe("buildStepAgent with the identity of the workflow input", () => {
    it("keeps the prompt of the identity, and takes the tools from the catalog of the moment", async () => {
        const resolved = await resolveCatalog(services.catalog);
        const identity = {
            ...agentIdentityOf(presentGet(Object.fromEntries(resolved.agents), "analyst")),
            prompt: "# Kept prompt\n\nThe prompt of the start.",
        };

        const def = await buildStepAgent(services, deps, "analyst", identity);

        expect(def.systemPrompt).toContain("# Kept prompt");
        expect(def.systemPrompt).not.toContain(analystPrompt.trim());
        expect((def.scriptTools ?? []).map((t) => t.id)).toEqual((presentGet(agents, "analyst").scriptTools ?? []).map((t) => t.id));
    });

    it("runs an agent that the catalog no longer holds with no attachments", async () => {
        const identity = { id: "lipid-analyst", name: "Lipid analyst", role: "executor" as const, prompt: "You analyze lipids.", promptHash: "x" };

        const def = await buildStepAgent(services, deps, "lipid-analyst", identity);

        expect(def.id).toBe("lipid-analyst");
        expect(new Set((def.scriptTools ?? []).map((t) => t.id))).toEqual(new Set(READ_SCRIPT_TOOLS));
    });
});
