import { describe, expect, test } from "bun:test";
import type { EmitFn, EventSource, PlanPart } from "@inflexa-ai/harness";

import { isSubAgentEvent, readPlanCard } from "./chat_printer.ts";

/** Top-level provenance (callPath length 1) — passes the sub-agent depth filter. */
const TOP: EventSource = { agentId: "cli-chat", callPath: ["cli-chat"] };
/** Sub-agent provenance (callPath length 2) — dropped by the depth filter. */
const SUB: EventSource = { agentId: "planner", callPath: ["cli-chat", "planner"] };

// The classification pieces the TUI adapter reuses instead of duplicating.
describe("isSubAgentEvent", () => {
    test("top-level provenance (callPath length 1) is NOT sub-agent", () => {
        expect(isSubAgentEvent({ type: "tool-started", source: TOP, toolUseId: "t1", name: "grep", input: {} })).toBe(false);
    });

    test("deeper provenance (callPath length > 1) IS sub-agent", () => {
        expect(isSubAgentEvent({ type: "tool-started", source: SUB, toolUseId: "t1", name: "grep", input: {} })).toBe(true);
    });

    test("an event with no source (a text delta) is never sub-agent", () => {
        expect(isSubAgentEvent({ type: "text-delta", text: "hi" })).toBe(false);
    });

    test("a malformed source lacking a callPath array falls through as top-level", () => {
        // `callPath` is external/loop-owned; a non-array must be treated as
        // top-level rather than throwing (the Array.isArray guard).
        const malformed = {
            type: "tool-started",
            source: { agentId: "x", callPath: undefined },
            toolUseId: "t1",
            name: "grep",
            input: {},
        } as unknown as Parameters<EmitFn>[0];
        expect(isSubAgentEvent(malformed)).toBe(false);
    });
});

describe("readPlanCard", () => {
    test("extracts planId, title, and per-step fields", () => {
        const card = readPlanCard({
            type: "data-plan",
            id: "pres-1",
            planId: "pln-abc12345",
            title: "DE",
            steps: [
                {
                    id: "S1",
                    name: "align",
                    agent: "exec",
                    question: "Which reads align?",
                    acceptance_criteria: ["BAM produced"],
                    constraints: ["paired-end"],
                    caveats: ["reference bias"],
                    depends_on: ["S0"],
                    resources: { cpu: 4, memoryGb: 8, gpu: { count: 1 } },
                    maxSteps: 30,
                    track: "alignment",
                    step_type: "analysis",
                },
            ],
        });
        expect(card).toEqual({
            planId: "pln-abc12345",
            title: "DE",
            steps: [
                {
                    id: "S1",
                    name: "align",
                    agent: "exec",
                    question: "Which reads align?",
                    acceptance_criteria: ["BAM produced"],
                    constraints: ["paired-end"],
                    caveats: ["reference bias"],
                    depends_on: ["S0"],
                    resources: { cpu: 4, memoryGb: 8, gpuCount: 1 },
                    track: "alignment",
                    step_type: "analysis",
                },
            ],
        });
    });

    test("an absent optional field reads as empty", () => {
        const card = readPlanCard({
            type: "data-plan",
            id: "pres-1",
            planId: "pln-abc12345",
            steps: [{ id: "S1", name: "align", agent: "exec", question: "q", depends_on: [], maxSteps: 30 }],
        });
        expect(card).toEqual({
            planId: "pln-abc12345",
            title: "",
            steps: [
                {
                    id: "S1",
                    name: "align",
                    agent: "exec",
                    question: "q",
                    acceptance_criteria: [],
                    constraints: [],
                    caveats: [],
                    depends_on: [],
                    resources: null,
                    track: "",
                    step_type: "",
                },
            ],
        });
        expect(readPlanCard({ type: "data-plan", id: "pres-2", planId: "pln-abc12345" }).steps).toEqual([]);
    });

    test("copies each step — no reference to the source part survives", () => {
        const part: PlanPart = {
            type: "data-plan",
            id: "pres-1",
            planId: "pln-abc12345",
            steps: [
                {
                    id: "S1",
                    name: "one",
                    agent: "a1",
                    question: "q",
                    depends_on: ["S0"],
                    constraints: ["fast"],
                    resources: { cpu: 2, memoryGb: 4 },
                    maxSteps: 30,
                },
            ],
        };
        const card = readPlanCard(part);
        const step = part.steps![0]!;
        step.name = "MUTATED";
        step.depends_on[0] = "MUTATED";
        step.constraints![0] = "MUTATED";
        step.resources!.cpu = 99;
        expect(card.steps[0]!.name).toBe("one");
        expect(card.steps[0]!.depends_on).toEqual(["S0"]);
        expect(card.steps[0]!.constraints).toEqual(["fast"]);
        expect(card.steps[0]!.resources).toEqual({ cpu: 2, memoryGb: 4, gpuCount: 0 });
    });
});
