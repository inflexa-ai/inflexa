import { describe, expect, test } from "bun:test";

import type { EvalCase } from "../lib/case.js";
import { PROFILER_ID } from "../lib/sandbox.js";
import { overrideAgentIds, overrideSandboxAgent, withSandboxAgent } from "../lib/sandbox-agent.js";

function stepCase(agentId: string, tools: EvalCase["tools"]): EvalCase {
    return {
        id: "override-unit",
        set: "dev",
        agent: "sandbox",
        source: "unit",
        user: "Run the DE.",
        sandbox: { agentId, stepId: "T1S1", files: {}, packages: [] },
        tools,
        maxSteps: 4,
        grade: () => ({ pass: true, detail: "" }),
    };
}

describe("the override of a sandbox agent", () => {
    test("replaces the agent id, keeps the case id, and drops the script of each tool that the new agent does not hold", () => {
        const { evalCase, dropped } = withSandboxAgent(
            stepCase("analyst", { list_available_refs: { ok: {} }, search_geo_datasets: { ok: {} } }),
            { agentId: "drug-analyst" },
            new Set(["list_available_refs", "execute_command"]),
        );
        expect(evalCase.id).toBe("override-unit");
        expect(evalCase.sandbox?.agentId).toBe("drug-analyst");
        expect(Object.keys(evalCase.tools ?? {})).toEqual(["list_available_refs"]);
        expect(dropped).toEqual(["search_geo_datasets"]);
    });

    test("keeps a case of the profiler", () => {
        const profiler = stepCase(PROFILER_ID, { list_available_refs: { ok: {} } });
        expect(withSandboxAgent(profiler, { agentId: "drug-analyst" }, new Set())).toEqual({ evalCase: profiler, dropped: [] });
    });

    test("reads the tool ids from the real agent, thus a script tool of the analyst that the drug analyst lacks is dropped", async () => {
        const [overridden] = await overrideSandboxAgent(
            [stepCase("analyst", { list_available_refs: { ok: {} }, search_geo_datasets: { ok: {} } })],
            "drug-analyst",
        );
        expect(overridden?.evalCase.sandbox?.agentId).toBe("drug-analyst");
        expect(overridden?.dropped).toEqual(["search_geo_datasets"]);
    });

    test("offers each step agent and not the profiler", () => {
        expect(overrideAgentIds()).toContain("drug-analyst");
        expect(overrideAgentIds()).not.toContain(PROFILER_ID);
    });
});
