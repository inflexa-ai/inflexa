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

    it("rejects the run-phase synthesis id", () => {
        const result = validatePlan(plan([step({ id: "synthesis" })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("reserved name"))).toBe(true);
    });

    it("rejects the run-phase synthesis id case-insensitively (SYNTHESIS)", () => {
        const result = validatePlan(plan([step({ id: "SYNTHESIS" })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("reserved name"))).toBe(true);
    });

    it("rejects a step id with a path separator", () => {
        const result = validatePlan(plan([step({ id: "a/b" })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("unsafe id"))).toBe(true);
    });

    it("rejects a '..' step id", () => {
        const result = validatePlan(plan([step({ id: ".." })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("unsafe id"))).toBe(true);
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

describe("validatePlan package entries", () => {
    it("passes an absent packages array — stored plans from before the field carry none", () => {
        const result = validatePlan(plan([step({ id: "T1S1" })]));
        expect(result.valid).toBe(true);
    });

    it("passes the requirement forms: a bare name, and name==version", () => {
        const result = validatePlan(plan([step({ id: "T1S1", packages: ["scanpy", "numpy==1.26.4", "ANCOM-BC2"] })]));
        expect(result.valid).toBe(true);
    });

    it("refuses a store directory, naming the step and the entry", () => {
        const result = validatePlan(plan([step({ id: "T1S1", packages: ["/mnt/libs/store/scanpy-1.12.3-e71bae79"] })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("T1S1") && e.includes("/mnt/libs/store/scanpy-1.12.3-e71bae79"))).toBe(true);
    });

    it("refuses a URL", () => {
        const result = validatePlan(plan([step({ id: "T1S1", packages: ["https://example.com/pkg.whl"] })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("package location"))).toBe(true);
    });

    it("refuses a relative path", () => {
        const result = validatePlan(plan([step({ id: "T1S1", packages: ["./vendor/pkg"] })]));
        expect(result.valid).toBe(false);
    });

    it("refuses a version specifier that is not ==, naming the two permitted forms", () => {
        // The link pass splits on `==` only, thus an unrefused range becomes a
        // package NAME and the pool refuses a package it holds.
        for (const entry of ["numpy>=1.26", "numpy<2", "scanpy~=1.10", "scanpy!=1.9", "numpy=1.26"]) {
            const result = validatePlan(plan([step({ id: "T1S1", packages: [entry] })]));
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("T1S1") && e.includes(entry) && e.includes("name==version"))).toBe(true);
        }
    });

    it("passes the prefixed form of each ecosystem", () => {
        const result = validatePlan(plan([step({ id: "T1S1", packages: ["python:igraph", "r:decoupleR==2.17.0"] })]));
        expect(result.valid).toBe(true);
    });

    it("refuses a prefix that is neither python: nor r:, naming the two permitted prefixes", () => {
        const result = validatePlan(plan([step({ id: "T1S1", packages: ["bioc:fgsea"] })]));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("T1S1") && e.includes("bioc:fgsea") && e.includes('"python:"') && e.includes('"r:"'))).toBe(true);
    });
});
