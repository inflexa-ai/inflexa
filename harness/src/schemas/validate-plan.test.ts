import { describe, expect, it } from "bun:test";

import { KNOWN_AGENT_IDS } from "../agents/sandbox-catalog.js";
import { STEP_SUBDIRS } from "../workspace/paths.js";
import type { AnalysisPlan, AnalysisStep } from "./workflow-state.js";
import { validatePlan } from "./validate-plan.js";

const AGENT = KNOWN_AGENT_IDS[0]!;

function step(over: Partial<AnalysisStep> & { id: string }): AnalysisStep {
    return {
        name: over.id,
        track: "T1",
        step_type: "analysis",
        question: "q",
        acceptance_criteria: ["a"],
        depends_on: [],
        status: "pending",
        resources: { cpu: 1, memoryGb: 2 },
        agent: AGENT,
        maxSteps: 10,
        ...over,
    };
}

function plan(steps: AnalysisStep[]): AnalysisPlan {
    return {
        analytical_narrative: "n",
        steps,
        created_at: new Date().toISOString(),
    };
}

describe("validatePlan", () => {
    it("accepts a well-formed single-step plan", () => {
        const result = validatePlan(plan([step({ id: "T1S1" })]));
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it("rejects a step id equal to a reserved artifact subdir name (figures)", () => {
        const result = validatePlan(plan([step({ id: "figures" })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("reserved name"))).toBe(true);
    });

    it("rejects reserved names case-insensitively (OUTPUT)", () => {
        const result = validatePlan(plan([step({ id: "OUTPUT" })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("reserved name"))).toBe(true);
    });

    it("rejects every reserved subdir name", () => {
        for (const reserved of STEP_SUBDIRS) {
            const result = validatePlan(plan([step({ id: reserved })]));
            expect(result.valid).toBe(false);
        }
    });
});

describe("validatePlan per-step resource ceiling", () => {
    const ceiling = { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 };

    it("accepts a step under the ceiling", () => {
        const result = validatePlan(plan([step({ id: "T1S1", resources: { cpu: 2, memoryGb: 4 } })]), { perStepCeiling: ceiling });
        expect(result.valid).toBe(true);
    });

    it("accepts a step exactly at the ceiling", () => {
        const result = validatePlan(plan([step({ id: "T1S1", resources: { cpu: 4, memoryGb: 8 } })]), { perStepCeiling: ceiling });
        expect(result.valid).toBe(true);
    });

    it("rejects an over-CPU step naming the step, the request, and the ceiling", () => {
        const result = validatePlan(plan([step({ id: "T1S1", resources: { cpu: 8, memoryGb: 4 } })]), { perStepCeiling: ceiling });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('"T1S1"');
        expect(result.errors[0]).toContain("cpu: 8");
        expect(result.errors[0]).toContain("4 per step");
    });

    it("rejects an over-memory step naming the step, the request, and the ceiling", () => {
        const result = validatePlan(plan([step({ id: "T1S1", resources: { cpu: 4, memoryGb: 16 } })]), { perStepCeiling: ceiling });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('"T1S1"');
        expect(result.errors[0]).toContain("memoryGb: 16");
        expect(result.errors[0]).toContain("8 per step");
    });

    it("reports both dimensions when both exceed the ceiling", () => {
        const result = validatePlan(plan([step({ id: "T1S1", resources: { cpu: 8, memoryGb: 16 } })]), { perStepCeiling: ceiling });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(2);
    });

    it("skips the ceiling check when no options are passed (legacy call)", () => {
        const result = validatePlan(plan([step({ id: "T1S1", resources: { cpu: 64, memoryGb: 512 } })]));
        expect(result.valid).toBe(true);
    });
});
