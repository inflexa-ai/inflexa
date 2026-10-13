import { describe, expect, it } from "bun:test";

import { computeTopologicalLevels } from "../execute-analysis-scheduler.js";
import { planGraphOf } from "./graph.js";

function step(id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) {
    return {
        id,
        name: `Name of ${id}`,
        track: "1",
        step_type: "analysis",
        question: "Which genes change?",
        acceptance_criteria: [],
        depends_on: dependsOn,
        maxSteps: 10,
        agent: "rna-seq",
        ...extra,
    };
}

function planOf(steps: unknown[]) {
    return { analytical_narrative: "why", steps, created_at: "2026-10-01T00:00:00.000Z" };
}

describe("planGraphOf", () => {
    const diamond = [step("T1S1"), step("T1S2", ["T1S1"]), step("T2S1", ["T1S1"]), step("T1S3", ["T1S2", "T2S1"])];

    it("gives the levels of a diamond plan in the order of the plan", () => {
        const graph = planGraphOf(planOf(diamond));

        expect(graph).toEqual([
            { id: "T1S1", name: "Name of T1S1", agent: "rna-seq", dependsOn: [], level: 0 },
            { id: "T1S2", name: "Name of T1S2", agent: "rna-seq", dependsOn: ["T1S1"], level: 1 },
            { id: "T2S1", name: "Name of T2S1", agent: "rna-seq", dependsOn: ["T1S1"], level: 1 },
            { id: "T1S3", name: "Name of T1S3", agent: "rna-seq", dependsOn: ["T1S2", "T2S1"], level: 2 },
        ]);
    });

    it("gives the levels that the run stream computes for the same steps", () => {
        const levels = computeTopologicalLevels(diamond);
        const graphLevels = Object.fromEntries((planGraphOf(planOf(diamond)) ?? []).map((s) => [s.id, s.level]));
        expect(graphLevels).toEqual(Object.fromEntries(levels));
    });

    it("gives the agent unknown to a step with no agent", () => {
        const graph = planGraphOf(planOf([step("T1S1", [], { agent: undefined })]));
        expect(graph?.[0]?.agent).toBe("unknown");
    });

    it("gives null for a cycle", () => {
        expect(planGraphOf(planOf([step("T1S1", ["T1S2"]), step("T1S2", ["T1S1"])]))).toBeNull();
    });

    it("gives null for a duplicate step id", () => {
        expect(planGraphOf(planOf([step("T1S1"), step("T1S1")]))).toBeNull();
    });

    it("gives null for a missing dependency", () => {
        expect(planGraphOf(planOf([step("T1S1", ["T9S9"])]))).toBeNull();
    });

    it("gives null for a document that is not a plan", () => {
        expect(planGraphOf({ title: "no steps" })).toBeNull();
        expect(planGraphOf(null)).toBeNull();
    });

    it("gives an empty graph for a plan with no step", () => {
        expect(planGraphOf(planOf([]))).toEqual([]);
    });
});
