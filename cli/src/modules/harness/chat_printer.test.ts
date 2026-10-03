import { describe, expect, test } from "bun:test";
import type { PlanPart } from "@inflexa-ai/harness";
import type { ChatFrame, EventSource } from "@inflexa-ai/harness/contracts/index.js";

import { isSubAgentEvent, readFileReference, readPlanCard, readPresentation, subAgentActivityLabel } from "./chat_printer.ts";

/** Top-level provenance (callPath length 1) — passes the sub-agent depth filter. */
const TOP: EventSource = { agentId: "cli-chat", callPath: ["cli-chat"] };
/** Sub-agent provenance (callPath length 2) — dropped by the depth filter. */
const SUB: EventSource = { agentId: "planner", callPath: ["cli-chat", "planner"] };

// The classification pieces the TUI adapter reuses instead of duplicating.
describe("isSubAgentEvent", () => {
    test("top-level provenance (callPath length 1) is NOT sub-agent", () => {
        expect(isSubAgentEvent({ type: "tool-started", source: TOP, toolUseId: "t1", name: "grep" })).toBe(false);
    });

    test("deeper provenance (callPath length > 1) IS sub-agent", () => {
        expect(isSubAgentEvent({ type: "tool-started", source: SUB, toolUseId: "t1", name: "grep" })).toBe(true);
    });

    test("a part frame with no source is never sub-agent", () => {
        expect(isSubAgentEvent({ type: "data-run-card", runId: "r1", title: "t", stepCount: 1 } as ChatFrame)).toBe(false);
    });

    test("a malformed source lacking a callPath array falls through as top-level", () => {
        // `callPath` arrives over the wire; a non-array must be treated as top-level rather than
        // throwing (the Array.isArray guard).
        const malformed = {
            type: "tool-started",
            source: { agentId: "x", callPath: undefined },
            toolUseId: "t1",
            name: "grep",
        } as unknown as ChatFrame;
        expect(isSubAgentEvent(malformed)).toBe(false);
    });
});

describe("subAgentActivityLabel", () => {
    test("names the agent and its tool on a start and on a finish", () => {
        expect(subAgentActivityLabel({ type: "tool-started", source: SUB, toolUseId: "t1", name: "bash" })).toBe("planner: bash");
        expect(subAgentActivityLabel({ type: "tool-finished", source: SUB, toolUseId: "t1", name: "bash", outcome: "ok" })).toBe("planner: bash done");
    });

    test("names the agent that starts a model request", () => {
        expect(subAgentActivityLabel({ type: "iteration", source: SUB })).toBe("planner: thinking");
    });

    test("a text delta describes no activity", () => {
        expect(subAgentActivityLabel({ type: "text-delta", text: "prose", source: SUB })).toBeNull();
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

describe("readPresentation", () => {
    test("text-shaped markdown/code/table become inline bodies", () => {
        expect(readPresentation({ type: "data-presentation", id: "p", title: "T", content: { kind: "markdown", body: "hi" } })).toEqual({
            shape: "inline",
            title: "T",
            body: { kind: "markdown", body: "hi" },
        });
        expect(readPresentation({ type: "data-presentation", id: "p", content: { kind: "code", code: "x", language: "r" } })).toEqual({
            shape: "inline",
            title: undefined,
            body: { kind: "code", code: "x", language: "r" },
        });
        expect(readPresentation({ type: "data-presentation", id: "p", content: { kind: "table", headers: ["a"], rows: [["1"]] } })).toEqual({
            shape: "inline",
            title: undefined,
            body: { kind: "table", headers: ["a"], rows: [["1"]], caption: undefined },
        });
    });

    test("echart becomes an openable entry carrying the deep-copied spec + pres id + dataPath", () => {
        const spec = { series: [{ type: "scatter" }] };
        const out = readPresentation({
            type: "data-presentation",
            id: "pres-chart",
            title: "Volcano",
            content: { kind: "echart", spec, dataPath: "runs/r/out.csv" },
        });
        expect(out.shape).toBe("card");
        if (out.shape === "card" && out.entry.target.kind === "echart") {
            expect(out.entry.target.presId).toBe("pres-chart");
            expect(out.entry.target.dataPath).toBe("runs/r/out.csv");
            // Deep copy: mutating the source spec does not reach the readout (copy-on-receive).
            spec.series[0]!.type = "MUTATED";
            expect(out.entry.target.spec).toEqual({ series: [{ type: "scatter" }] });
        }
    });

    test("a structure card, which has no renderer here, degrades to an inline note (observed, not swallowed)", () => {
        const out = readPresentation({
            type: "data-presentation",
            id: "p",
            content: {
                kind: "structure",
                format: "pdb",
                url: "https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.pdb",
                provider: "alphafold",
                accession: "P04637",
                version: 4,
            },
        });
        expect(out.shape).toBe("inline");
        if (out.shape === "inline" && out.body.kind === "markdown") expect(out.body.body).toContain("unsupported presentation: structure");
    });
});

describe("readFileReference", () => {
    test("each file becomes an openable entry; a multi-file gallery carries its containing folder", () => {
        const out = readFileReference({
            type: "data-file-reference",
            id: "g",
            title: "Figures",
            files: [{ path: "runs/r/figures/a.png" }, { path: "runs/r/figures/b.png", caption: "heatmap" }],
        });
        expect(out.title).toBe("Figures");
        expect(out.entries.map((e) => e.name)).toEqual(["a.png", "b.png"]);
        expect(out.entries[1]?.caption).toBe("heatmap");
        expect(out.folderPath).toBe("runs/r/figures");
    });

    test("a single-file reference carries no folder affordance", () => {
        const out = readFileReference({ type: "data-file-reference", id: "g", files: [{ path: "runs/r/out.csv" }] });
        expect(out.entries[0]?.name).toBe("out.csv");
        expect(out.folderPath).toBeUndefined();
    });
});
