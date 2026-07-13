import { describe, expect, test } from "bun:test";

import { planToDag, type PlanDagStep } from "./plan_dag.ts";

const step = (id: string, depends_on: string[] = [], name = id): PlanDagStep => ({ id, name, depends_on });

describe("planToDag", () => {
    test("renders a linear plan with connected box anchors", () => {
        const graph = planToDag([step("A"), step("B", ["A"])], { maxNameLength: 8 })._unsafeUnwrap();
        expect(graph).toBe(
            [
                "┌────────────┐",
                "│ A A        │",
                "└──────┬─────┘",
                "       │",
                "       │",
                "       │",
                "┌──────┴─────┐",
                "│ B B        │",
                "└────────────┘",
            ].join("\n"),
        );
    });

    test("renders a branching merge with crisp junctions", () => {
        const graph = planToDag([step("A"), step("B", ["A"]), step("C", ["A"]), step("D", ["B", "C"])], {
            maxNameLength: 8,
        })._unsafeUnwrap();
        expect(graph).toBe(
            [
                "         ┌────────────┐",
                "         │ A A        │",
                "         └──────┬─────┘",
                "                │",
                "       ┌────────┴────────┐",
                "       │                 │",
                "┌──────┴─────┐    ┌──────┴─────┐",
                "│ B B        │    │ C C        │",
                "└──────┬─────┘    └──────┬─────┘",
                "       │                 │",
                "       └────────┬────────┘",
                "                │",
                "         ┌──────┴─────┐",
                "         │ D D        │",
                "         └────────────┘",
            ].join("\n"),
        );
    });

    test("fan-out width is driven by parallel boxes and labels truncate", () => {
        const graph = planToDag([step("A"), ...Array.from({ length: 5 }, (_, index) => step(`B${index}`, ["A"], "a deliberately overlong step name"))], {
            maxNameLength: 8,
        })._unsafeUnwrap();
        const lines = graph.split("\n");
        expect(Math.max(...lines.map((line) => line.length))).toBe(91);
        expect(graph).toContain("a delib…");
        expect(graph).toContain("┼");
    });

    test("cycle guard renders cyclic nodes at level zero", () => {
        const graph = planToDag([step("A", ["B"]), step("B", ["A"])])._unsafeUnwrap();
        expect(graph.split("\n")).toHaveLength(3);
        expect(graph).toContain("A");
        expect(graph).toContain("B");
    });

    test("unknown dependencies are skipped", () => {
        const graph = planToDag([step("A", ["missing"])])._unsafeUnwrap();
        const root = planToDag([step("A")])._unsafeUnwrap();
        expect(graph).toBe(root);
    });
});
