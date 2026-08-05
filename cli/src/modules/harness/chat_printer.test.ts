import { describe, expect, test } from "bun:test";
import type { EmitFn, EventSource } from "@inflexa-ai/harness";

import { isSubAgentEvent, readAskPart, readPlanCard, readRunCard } from "./chat_printer.ts";

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
            id: "pres-1",
            planId: "pln-abc",
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
                    track: "alignment",
                    step_type: "analysis",
                },
            ],
        });
        expect(card).toEqual({
            planId: "pln-abc",
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

    test("coerces missing/mistyped fields to empty rather than throwing", () => {
        // Missing title/steps and a non-string planId all collapse to empties.
        const card = readPlanCard({ planId: 42, steps: "not-an-array" });
        expect(card).toEqual({ planId: "", title: "", steps: [] });
    });

    test("copies each step — no reference to the source data survives", () => {
        const steps = [{ id: "S1", name: "one", agent: "a1", depends_on: ["S0"], constraints: ["fast"], resources: { cpu: 2, memoryGb: 4 } }];
        const card = readPlanCard({ planId: "pln-abc", steps });
        steps[0]!.name = "MUTATED";
        steps[0]!.depends_on[0] = "MUTATED";
        steps[0]!.resources.cpu = 99;
        expect(card.steps[0]!.name).toBe("one");
        expect(card.steps[0]!.depends_on).toEqual(["S0"]);
        expect(card.steps[0]!.resources).toEqual({ cpu: 2, memoryGb: 4, gpuCount: 0 });
    });

    test("coerces malformed nested step fields without throwing", () => {
        const card = readPlanCard({ planId: "pln-abc", steps: [{ depends_on: ["S0", 1], resources: "large", constraints: {} }] });
        expect(card.steps[0]).toEqual({
            id: "",
            name: "",
            agent: "",
            question: "",
            acceptance_criteria: [],
            constraints: [],
            caveats: [],
            depends_on: ["S0"],
            resources: null,
            track: "",
            step_type: "",
        });
    });
});

describe("readRunCard", () => {
    test("extracts runId, title, and stepCount", () => {
        expect(readRunCard({ id: "pres-r", runId: "run-xyz", planId: "pln-abc", title: "DE run", stepCount: 3 })).toEqual({
            runId: "run-xyz",
            title: "DE run",
            stepCount: 3,
        });
    });

    test("coerces missing/mistyped fields to empty/zero rather than throwing", () => {
        expect(readRunCard({ runId: 7 })).toEqual({ runId: "", title: "", stepCount: 0 });
    });
});

describe("readAskPart", () => {
    test("extracts askId (from id), title, command, detail, and a recognized status", () => {
        expect(
            readAskPart({ id: "ask-1", title: "Run inflexa refs", command: "inflexa refs list", detail: "reads local reference data", status: "pending" }),
        ).toEqual({
            askId: "ask-1",
            title: "Run inflexa refs",
            command: "inflexa refs list",
            detail: "reads local reference data",
            status: "pending",
        });
    });

    test("omits detail when absent and reads a terminal status", () => {
        expect(readAskPart({ id: "ask-2", title: "t", command: "c", status: "resolved" })).toEqual({
            askId: "ask-2",
            title: "t",
            command: "c",
            status: "resolved",
        });
    });

    test("coerces missing/mistyped fields to empty and a MISSING status to expired — never pending", () => {
        // A malformed payload must not resurrect a prompt: the status floor is a terminal value.
        expect(readAskPart({ id: 7, command: {} })).toEqual({ askId: "", title: "", command: "", status: "expired" });
    });

    test("an UNRECOGNIZED status string maps to expired, the safe terminal", () => {
        expect(readAskPart({ id: "ask-3", title: "t", command: "c", status: "granted" })).toEqual({
            askId: "ask-3",
            title: "t",
            command: "c",
            status: "expired",
        });
    });

    test("copy-on-receive: mutating the source data after read does not change the result", () => {
        const data: { id: string; title: string; command: string; status: string } = { id: "ask-4", title: "orig", command: "c", status: "pending" };
        const read = readAskPart(data);
        data.title = "MUTATED";
        data.command = "MUTATED";
        expect(read.title).toBe("orig");
        expect(read.command).toBe("c");
    });
});
