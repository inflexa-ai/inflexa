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
