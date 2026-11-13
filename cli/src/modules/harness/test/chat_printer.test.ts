import { describe, expect, test } from "bun:test";
import type { PlanPart } from "@inflexa-ai/harness";
import type { ChatFrame, EventSource } from "@inflexa-ai/harness/contracts/index.js";

import { isSubAgentEvent, readFileReference, readPlanCard, readPresentation, subAgentActivityLabel } from "../chat_printer.ts";
import { present } from "../../../lib/present.ts";

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
        const partFrame: ChatFrame = { type: "data-run-card", id: "p1", runId: "r1", planId: "pln-1", title: "t", stepCount: 1 };
        expect(isSubAgentEvent(partFrame)).toBe(false);
    });

    test("a malformed source lacking a callPath array falls through as top-level", () => {
        // `callPath` arrives over the wire; a non-array must be treated as top-level rather than
        // throwing (the Array.isArray guard).
        const source: EventSource = { agentId: "x", callPath: ["x"] };
        // The type forbids a source with no `callPath`, thus the value is forced at runtime.
        Object.assign(source, { callPath: undefined });
        const malformed: ChatFrame = { type: "tool-started", source, toolUseId: "t1", name: "grep" };
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
    test("joins each claim of a grounded step to its view by the id and the snapshot, and dedupes the sources", () => {
        const source = { doi: "10.1093/bioinformatics/btw014", title: "edgeR QL", year: 2016 };
        const card = readPlanCard({
            type: "data-plan",
            id: "pres-1",
            planId: "pln-abc12345",
            steps: [
                {
                    id: "T1S2",
                    name: "Fit",
                    agent: "bulk",
                    question: "q",
                    depends_on: [],
                    maxSteps: 30,
                    grounding: {
                        status: "grounded",
                        snapshot: "sha256:71ac",
                        claims: ["R-0028@d560", "R-0031@e7d0", "R-0099@0000", "R-0040@e7d0"],
                        template: "tpl-edger-ql@1.8.0",
                        settings: [
                            { step: "differential_expression", name: "fdr", value: 0.05, source: "doi:10.1093/bioinformatics/btw014" },
                            { step: "differential_expression", name: "contrasts", value: ["a", "b"] },
                        ],
                        reason: "edgeR per R-0028",
                    },
                },
            ],
            claims: [
                { id: "R-0028@d560", snapshot: "sha256:71ac", title: "Use the QL F-test", statement: "s", strength: "consensus", evidence: [source] },
                // The same paper under a DOI in a different case is one source.
                {
                    id: "R-0031@e7d0",
                    snapshot: "sha256:71ac",
                    statement: "Filter the low counts",
                    strength: "moderate",
                    evidence: [{ ...source, doi: "10.1093/BIOINFORMATICS/btw014" }],
                },
                // A view of the same id in a different release does not match.
                { id: "R-0099@0000", snapshot: "sha256:ffff", title: "Another release", statement: "s", strength: "weak", evidence: [] },
                // A url keeps its case, thus two urls that differ in case are two sources.
                {
                    id: "R-0040@e7d0",
                    snapshot: "sha256:71ac",
                    title: "Read the manual",
                    statement: "s",
                    strength: "weak",
                    evidence: [
                        { url: "https://example.org/A.pdf", title: "Manual A", year: 2020 },
                        { url: "https://example.org/a.pdf", title: "Manual a", year: 2020 },
                    ],
                },
            ],
        });

        expect(present(card.steps[0]).grounding).toEqual({
            status: "grounded",
            snapshot: "sha256:71ac",
            template: "tpl-edger-ql@1.8.0",
            reason: "edgeR per R-0028",
            rules: [
                { id: "R-0028@d560", title: "Use the QL F-test", strength: "consensus" },
                { id: "R-0031@e7d0", title: "Filter the low counts", strength: "moderate" },
                { id: "R-0099@0000", title: "", strength: "" },
                { id: "R-0040@e7d0", title: "Read the manual", strength: "weak" },
            ],
            settings: [
                { step: "differential_expression", name: "fdr", value: "0.05", source: "doi:10.1093/bioinformatics/btw014" },
                { step: "differential_expression", name: "contrasts", value: "a, b", source: "" },
            ],
            departures: [],
            sources: [
                { title: "edgeR QL", year: 2016, ref: "doi:10.1093/bioinformatics/btw014" },
                { title: "Manual A", year: 2020, ref: "https://example.org/A.pdf" },
                { title: "Manual a", year: 2020, ref: "https://example.org/a.pdf" },
            ],
        });
    });

    test("shows a setting as the run binds it: the value of a departure, or not applied, with the departure as its source", () => {
        const card = readPlanCard({
            type: "data-plan",
            id: "pres-1",
            planId: "pln-abc12345",
            steps: [
                {
                    id: "T1S1",
                    name: "QC",
                    agent: "bulk",
                    question: "q",
                    depends_on: [],
                    maxSteps: 30,
                    grounding: {
                        status: "grounded",
                        snapshot: "sha256:71ac",
                        claims: ["R-0001@e7d0", "R-0147@3c1d"],
                        settings: [
                            { step: "qc_sample_structure", name: "n_top_genes_pca", value: 500, source: "doi:10.1186/s13059-014-0550-8" },
                            { step: "qc_bias", name: "gc_bias", value: true },
                            { step: "qc_bias", name: "alpha", value: 0.05 },
                            { step: "differential_expression", name: "covariates", value: ["batch"] },
                        ],
                        departures: [
                            { rule: "R-0001@e7d0", setting: "n_top_genes_pca", value: 364, reason: "the panel holds 364 targets" },
                            { rule: "R-0001@e7d0", setting: "covariates", value: [], reason: "the design has no covariate" },
                            { rule: "R-0147@3c1d", setting: "gc_bias", reason: "the inputs hold no amplicon sequence" },
                            { rule: "R-0147@3c1d", reason: "the plan runs no length diagnostic" },
                        ],
                        reason: "QC per R-0001@e7d0",
                    },
                },
            ],
        });

        const grounding = present(card.steps[0]).grounding;
        expect(grounding?.settings).toEqual([
            { step: "qc_sample_structure", name: "n_top_genes_pca", value: "364", source: "departure from R-0001@e7d0" },
            { step: "qc_bias", name: "gc_bias", value: "true", source: "not applied: departure from R-0147@3c1d" },
            { step: "qc_bias", name: "alpha", value: "0.05", source: "" },
            { step: "differential_expression", name: "covariates", value: "[]", source: "departure from R-0001@e7d0" },
        ]);
        expect(grounding?.departures).toEqual([
            { rule: "R-0001@e7d0", change: "value", setting: "n_top_genes_pca", value: "364", reason: "the panel holds 364 targets" },
            { rule: "R-0001@e7d0", change: "value", setting: "covariates", value: "[]", reason: "the design has no covariate" },
            { rule: "R-0147@3c1d", change: "not_applied", setting: "gc_bias", value: "", reason: "the inputs hold no amplicon sequence" },
            { rule: "R-0147@3c1d", change: "left_out", setting: "", value: "", reason: "the plan runs no length diagnostic" },
        ]);
    });

    test("gives no grounding to a step that has none", () => {
        const card = readPlanCard({
            type: "data-plan",
            id: "pres-1",
            planId: "pln-abc12345",
            steps: [{ id: "S1", name: "align", agent: "exec", question: "q", depends_on: [], maxSteps: 30 }],
        });

        expect(present(card.steps[0]).grounding).toBeUndefined();
    });

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
                    maxSteps: 30,
                },
            ],
        };
        const card = readPlanCard(part);
        const step = present(present(part.steps)[0]);
        step.name = "MUTATED";
        step.depends_on[0] = "MUTATED";
        present(step.constraints)[0] = "MUTATED";
        expect(present(card.steps[0]).name).toBe("one");
        expect(present(card.steps[0]).depends_on).toEqual(["S0"]);
        expect(present(card.steps[0]).constraints).toEqual(["fast"]);
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
            present(spec.series[0]).type = "MUTATED";
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
