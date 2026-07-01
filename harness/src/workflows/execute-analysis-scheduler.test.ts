/**
 * Unit tests for the pure DAG scheduler. Covers `scheduleReady`,
 * `computeTopologicalLevels`, and `validatePlanDag` error surfaces.
 *
 * The schedule tests use small explicit DAGs — independent steps, a linear
 * chain, a diamond, and a parallel fan-out — because they're the shapes the
 * parent workflow actually drives.
 */

import { describe, expect, it } from "bun:test";
import {
    CycleError,
    DuplicateStepIdError,
    MissingDependencyError,
    type PlanStep,
    computeTopologicalLevels,
    scheduleReady,
    validatePlanDag,
} from "./execute-analysis-scheduler.js";

function step(id: string, ...deps: string[]): PlanStep {
    return { id, depends_on: deps };
}

describe("scheduleReady", () => {
    it("returns every independent step on the first call", () => {
        const plan = [step("A"), step("B"), step("C")];
        expect(scheduleReady(plan, new Set())).toEqual(["A", "B", "C"]);
    });

    it("unblocks a linear chain in declared order", () => {
        const plan = [step("A"), step("B", "A"), step("C", "B")];
        expect(scheduleReady(plan, new Set())).toEqual(["A"]);
        expect(scheduleReady(plan, new Set(["A"]))).toEqual(["B"]);
        expect(scheduleReady(plan, new Set(["A", "B"]))).toEqual(["C"]);
        expect(scheduleReady(plan, new Set(["A", "B", "C"]))).toEqual([]);
    });

    it("diamond — both branches start together when root completes", () => {
        // A -> B, A -> C, (B,C) -> D
        const plan = [step("A"), step("B", "A"), step("C", "A"), step("D", "B", "C")];
        expect(scheduleReady(plan, new Set(["A"]))).toEqual(["B", "C"]);
        // After dispatching B and C they're in the startedSet; D still blocked on C.
        const started = new Set(["A", "B", "C"]);
        expect(scheduleReady(plan, new Set(["A", "B"]), started)).toEqual([]);
        expect(scheduleReady(plan, new Set(["A", "B", "C"]), started)).toEqual(["D"]);
    });

    it("excludes already-started steps so the same step is not dispatched twice", () => {
        const plan = [step("A"), step("B", "A")];
        // A is started but not completed — must NOT be re-dispatched.
        expect(scheduleReady(plan, new Set(), new Set(["A"]))).toEqual([]);
    });

    it("respects startedSet for in-flight siblings", () => {
        const plan = [step("A"), step("B", "A"), step("C", "A")];
        expect(scheduleReady(plan, new Set(["A"]), new Set(["B"]))).toEqual(["C"]);
    });
});

describe("validatePlanDag", () => {
    it("throws DuplicateStepIdError when two steps share an id", () => {
        expect(() => validatePlanDag([step("A"), step("A")])).toThrow(DuplicateStepIdError);
    });

    it("throws MissingDependencyError when a dep is not in the plan", () => {
        let caught: unknown;
        try {
            validatePlanDag([step("B", "A")]);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(MissingDependencyError);
        const err = caught as MissingDependencyError;
        expect(err.stepId).toBe("B");
        expect(err.missingDependency).toBe("A");
    });

    it("throws CycleError on a 2-step self-cycle and reports the involved steps", () => {
        let caught: unknown;
        try {
            validatePlanDag([step("A", "B"), step("B", "A")]);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CycleError);
        const err = caught as CycleError;
        expect(new Set(err.involvedSteps)).toEqual(new Set(["A", "B"]));
    });

    it("accepts a valid DAG and returns the step map", () => {
        const plan = [step("A"), step("B", "A"), step("C", "A", "B")];
        const stepMap = validatePlanDag(plan);
        expect(stepMap.size).toBe(3);
        expect(stepMap.get("C")!.depends_on).toEqual(["A", "B"]);
    });
});

describe("computeTopologicalLevels", () => {
    it("assigns level 0 to every step in a fully parallel plan", () => {
        const plan = [step("A"), step("B"), step("C")];
        const levels = computeTopologicalLevels(plan);
        expect(levels.get("A")).toBe(0);
        expect(levels.get("B")).toBe(0);
        expect(levels.get("C")).toBe(0);
    });

    it("assigns successive levels in a linear chain", () => {
        const plan = [step("A"), step("B", "A"), step("C", "B"), step("D", "C")];
        const levels = computeTopologicalLevels(plan);
        expect(levels.get("A")).toBe(0);
        expect(levels.get("B")).toBe(1);
        expect(levels.get("C")).toBe(2);
        expect(levels.get("D")).toBe(3);
    });

    it("levels in a diamond are root=0, branches=1, join=2", () => {
        const plan = [step("A"), step("B", "A"), step("C", "A"), step("D", "B", "C")];
        const levels = computeTopologicalLevels(plan);
        expect(levels.get("A")).toBe(0);
        expect(levels.get("B")).toBe(1);
        expect(levels.get("C")).toBe(1);
        expect(levels.get("D")).toBe(2);
    });

    it("uneven branch lengths — join takes max(level(deps)) + 1", () => {
        // A -> B -> D, A -> C -> E -> D  (D should be level 3, not 2)
        const plan = [step("A"), step("B", "A"), step("C", "A"), step("E", "C"), step("D", "B", "E")];
        const levels = computeTopologicalLevels(plan);
        expect(levels.get("D")).toBe(3);
    });
});
