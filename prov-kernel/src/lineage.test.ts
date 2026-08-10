import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProvDocument } from "@inflexa-ai/tsprov";
import { createProvDocumentModel, PROV_UNIFY_OPTIONS, type ProvDocumentModel } from "./document.js";
import { applyProvEvent } from "./events.js";
import { computeLineage, computeReachable, deriveLineageModel, findFileEntity, type LineageModel } from "./lineage.js";
import type { ProvActor, ProvCommandRef, ProvFileRef, ProvModelId, ProvStepRef } from "./types.js";

// The read model is tested against two sources: the committed golden fixture (the exact stored
// bytes every consumer reads) and documents built with the real event switch — the record shapes
// production writes — round-tripped through PROV-JSON like a stored column.

const goldenJson = readFileSync(new URL("./__fixtures__/golden-document.json", import.meta.url), "utf8");
const provModel = createProvDocumentModel();

function nodeOf(model: LineageModel, qn: string): LineageModel["nodes"][number] | undefined {
    return model.nodes.find((n) => n.qn === qn);
}

function edgeOf(model: LineageModel, id: string): LineageModel["edges"][number] | undefined {
    return model.edges.find((e) => e.id === id);
}

function qns(model: LineageModel): string[] {
    return model.nodes.map((n) => n.qn);
}

describe("deriveLineageModel — golden fixture", () => {
    const model = deriveLineageModel(goldenJson)._unsafeUnwrap();

    test("derives every PROV element into a node, plus the undeclared endpoints", () => {
        // 6 declared entities + 2 synthesized from relation endpoints the document references but
        // never declares (the resolved script and the failed command's output).
        const entities = model.nodes.filter((n) => n.kind === "analysis" || n.kind === "input" || n.kind === "file");
        expect(entities.map((n) => n.qn).sort()).toEqual([
            "inflexa:analysis-a-golden",
            "inflexa:file-18bvqsvo19q9p",
            "inflexa:file-2cl35k0tb4udj",
            "inflexa:file-2oo1fa1324nay",
            "inflexa:file-8cpsktnfc9if",
            "inflexa:file-c0kyjyc0bmim",
            "inflexa:file-monvuc8rxoat",
            "inflexa:input-39n74a7sqlbvc",
        ]);
        expect(model.nodes.filter((n) => n.kind === "activity")).toHaveLength(8);
        expect(model.nodes.filter((n) => n.kind === "agent")).toHaveLength(3);
    });

    test("maps the dialect attributes onto entity nodes", () => {
        expect(nodeOf(model, "inflexa:file-18bvqsvo19q9p")).toMatchObject({
            kind: "file",
            label: "runs/r1/s1/output/result.csv",
            path: "runs/r1/s1/output/result.csv",
            hash: "sha256:bbb",
            size: 10,
            producer: "command",
        });
        expect(nodeOf(model, "inflexa:file-2cl35k0tb4udj")).toMatchObject({
            kind: "file",
            path: "data/inputs/counts.csv",
            hash: "sha256:aaa",
            source: "data",
            fileId: "file-1",
        });
        expect(nodeOf(model, "inflexa:analysis-a-golden")).toMatchObject({
            kind: "analysis",
            label: "Golden Analysis",
            name: "Golden Analysis",
            slug: "golden-analysis",
        });
        expect(nodeOf(model, "inflexa:input-39n74a7sqlbvc")).toMatchObject({ kind: "input", path: "data/inputs/counts.csv", isDir: false });
    });

    test("a synthesized endpoint node carries the QName-derived kind and label only", () => {
        const plotQn = provModel.fileQName({ path: "runs/r1/s1/output/plot.png", hash: "sha256:eee" });
        const plot = nodeOf(model, plotQn);
        expect(plot).toEqual({ kind: "file", qn: plotQn, label: plotQn.slice("inflexa:".length) });
    });

    test("classifies activities and reads their terminal attributes", () => {
        expect(nodeOf(model, "inflexa:run-r1")).toMatchObject({
            kind: "activity",
            activity: "run",
            label: "r1",
            runId: "r1",
            status: "completed",
            durationMs: 200000,
            planSummary: "golden plan",
        });
        const run = nodeOf(model, "inflexa:run-r1");
        if (run?.kind === "activity") {
            expect(run.startTime).toBeDefined();
            expect(run.endTime).toBeDefined();
        }
        expect(nodeOf(model, "inflexa:step-r1-s1")).toMatchObject({
            kind: "activity",
            activity: "step",
            runId: "r1",
            stepId: "s1",
            status: "completed",
            durationMs: 100000,
        });
        // A command carries no runId/stepId attribute — both inherit from the informing step.
        expect(nodeOf(model, "inflexa:cmd-r1-s1-302d2bs8ad5ko")).toMatchObject({
            kind: "activity",
            activity: "command",
            label: "python run.py",
            command: "python run.py",
            args: "--seed 42",
            exitCode: 0,
            durationMs: 1200,
            runId: "r1",
            stepId: "s1",
        });
        expect(nodeOf(model, "inflexa:cmd-r1-s1-3on7qauhakeey")).toMatchObject({
            kind: "activity",
            activity: "command",
            exitCode: 1,
            unresolvedScript: "runs/r1/s1/scripts/analyze.R",
        });
        expect(nodeOf(model, "inflexa:cmd-r1-s1-1gmep6ya47zjz")).toMatchObject({ kind: "activity", activity: "file_tool", tool: "write_file" });
        expect(nodeOf(model, "inflexa:action-golden-1")).toMatchObject({ kind: "activity", activity: "action", actionType: "CreateAnalysis" });
    });

    test("classifies agents", () => {
        expect(nodeOf(model, "inflexa:agent-user-u-42")).toMatchObject({ kind: "agent", agent: "user", email: "golden@example.com" });
        expect(nodeOf(model, "inflexa:agent-system")).toMatchObject({
            kind: "agent",
            agent: "system",
            label: "golden-host",
            version: "1.0.0",
            commit: "deadbeef",
        });
        expect(nodeOf(model, "inflexa:agent-model-1j48pc6rh4s2c")).toMatchObject({
            kind: "agent",
            agent: "model",
            label: "anthropic/golden-model",
            model: "anthropic/golden-model",
        });
    });

    test("keys edges by their deterministic dialect ids, in the PROV assertion orientation", () => {
        expect(edgeOf(model, "inflexa:gen-18bvqsvo19q9p")).toEqual({
            id: "inflexa:gen-18bvqsvo19q9p",
            kind: "generated",
            from: "inflexa:file-18bvqsvo19q9p",
            to: "inflexa:cmd-r1-s1-302d2bs8ad5ko",
        });
        expect(edgeOf(model, "inflexa:used-cmd-r1-s1-302d2bs8ad5ko-2cl35k0tb4udj")).toEqual({
            id: "inflexa:used-cmd-r1-s1-302d2bs8ad5ko-2cl35k0tb4udj",
            kind: "used",
            from: "inflexa:cmd-r1-s1-302d2bs8ad5ko",
            to: "inflexa:file-2cl35k0tb4udj",
        });
        expect(edgeOf(model, "inflexa:informed-r1-s1")).toEqual({
            id: "inflexa:informed-r1-s1",
            kind: "informed",
            from: "inflexa:step-r1-s1",
            to: "inflexa:run-r1",
        });
        expect(edgeOf(model, "inflexa:assoc-run-r1-71ngm22zaedy")).toEqual({
            id: "inflexa:assoc-run-r1-71ngm22zaedy",
            kind: "associated",
            from: "inflexa:run-r1",
            to: "inflexa:agent-system",
        });
        expect(edgeOf(model, "inflexa:deriv-18bvqsvo19q9p")).toEqual({
            id: "inflexa:deriv-18bvqsvo19q9p",
            kind: "derived",
            from: "inflexa:file-18bvqsvo19q9p",
            to: "inflexa:analysis-a-golden",
        });
        expect(edgeOf(model, "inflexa:attr-18bvqsvo19q9p-71ngm22zaedy")).toEqual({
            id: "inflexa:attr-18bvqsvo19q9p-71ngm22zaedy",
            kind: "attributed",
            from: "inflexa:file-18bvqsvo19q9p",
            to: "inflexa:agent-system",
        });
    });

    test("keys an anonymous lifecycle relation by a value-derived fallback id", () => {
        expect(edgeOf(model, "generated:inflexa:analysis-a-golden->inflexa:action-golden-1")).toMatchObject({ kind: "generated" });
        expect(edgeOf(model, "used:inflexa:action-golden-2->inflexa:input-39n74a7sqlbvc")).toMatchObject({ kind: "used" });
    });

    test("derives exactly the seven edge kinds with no dangling endpoint; delegation is not an edge", () => {
        // 12 associations + 6 generations + 5 attributions + 5 usages + 4 derivations +
        // 4 communications; the model delegation is skipped.
        expect(model.edges).toHaveLength(36);
        expect(model.edges.some((e) => e.id.startsWith("inflexa:delegation-"))).toBe(false);
        const nodeQns = new Set(qns(model));
        for (const edge of model.edges) {
            expect(nodeQns.has(edge.from)).toBe(true);
            expect(nodeQns.has(edge.to)).toBe(true);
        }
    });

    test("is deterministic — the same bytes give the same model", () => {
        expect(deriveLineageModel(goldenJson)._unsafeUnwrap()).toEqual(model);
    });

    test("bytes that do not parse return prov_corrupt", () => {
        expect(deriveLineageModel("not prov json")._unsafeUnwrapErr().type).toBe("prov_corrupt");
    });
});

// The traversal fixtures: the canonical chain counts.csv → command A (Rscript) → de_results.csv →
// command B (python) → heatmap.png, plus a file-tool-written script read by A, a leaf file with
// only the step-level generation, and a step-level read of counts.csv.
const system: ProvActor = { kind: "system", label: "kernel-test", version: "0.0.1" };
const model: ProvModelId = "anthropic/test-model";
const stepRef: ProvStepRef = { runId: "run-001", stepId: "step-de" };

const countsKey = { path: "data/inputs/counts.csv", hash: "hashCount1" };
const deResultsKey = { path: "runs/run-001/step-de/output/de_results.csv", hash: "hashDe0001" };
const heatmapKey = { path: "runs/run-001/step-de/figures/heatmap.png", hash: "hashHeat01" };
const scriptKey = { path: "runs/run-001/step-de/scripts/de.R", hash: "hashScr001" };
const leafKey = { path: "runs/run-001/step-de/output/leaf.txt", hash: "hashLeaf01" };

const cmdA: ProvCommandRef = {
    kind: "command",
    command: "Rscript scripts/de.R",
    exitCode: 0,
    scriptPath: scriptKey.path,
    outputs: [deResultsKey],
    inputs: [
        { ...countsKey, source: "data", fileId: "file-1" },
        { ...scriptKey, source: "step" },
    ],
};
const cmdB: ProvCommandRef = { kind: "command", command: "python plot.py", exitCode: 0, outputs: [heatmapKey], inputs: [{ ...deResultsKey, source: "step" }] };
const writeScript: ProvCommandRef = { kind: "file_tool", tool: "write_file", outputs: [scriptKey] };

function fileRefOf(key: { path: string; hash: string }, producer: "command" | "file_tool" = "command"): ProvFileRef {
    return { ...key, size: 100, producer };
}

function chainDoc(m: ProvDocumentModel): ProvDocument {
    const doc = m.freshDocument({ analysisId: "a1" });
    applyProvEvent(m, doc, { type: "run_started", analysisId: "a1", actor: system, run: { runId: "run-001", startedAtMs: 1_700_000_000_000 } });
    applyProvEvent(m, doc, {
        type: "step_completed",
        analysisId: "a1",
        actor: system,
        outcome: { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1_700_000_001_500 },
        model,
    });
    applyProvEvent(m, doc, { type: "command_executed", analysisId: "a1", actor: system, step: stepRef, command: writeScript, model });
    applyProvEvent(m, doc, {
        type: "file_written",
        analysisId: "a1",
        actor: system,
        file: fileRefOf(scriptKey, "file_tool"),
        step: stepRef,
        generation: "command",
    });
    applyProvEvent(m, doc, { type: "command_executed", analysisId: "a1", actor: system, step: stepRef, command: cmdA, model });
    applyProvEvent(m, doc, { type: "file_written", analysisId: "a1", actor: system, file: fileRefOf(deResultsKey), step: stepRef, generation: "command" });
    applyProvEvent(m, doc, { type: "command_executed", analysisId: "a1", actor: system, step: stepRef, command: cmdB, model });
    applyProvEvent(m, doc, { type: "file_written", analysisId: "a1", actor: system, file: fileRefOf(heatmapKey), step: stepRef, generation: "command" });
    applyProvEvent(m, doc, { type: "file_written", analysisId: "a1", actor: system, file: fileRefOf(leafKey), step: stepRef, generation: "step" });
    applyProvEvent(m, doc, { type: "input_used", analysisId: "a1", actor: system, step: stepRef, input: { ...countsKey, source: "data", fileId: "file-1" } });
    return doc;
}

/** The model of a built document, read from the same bytes a host stores. */
function modelFrom(doc: ProvDocument): LineageModel {
    return deriveLineageModel(doc.unified(PROV_UNIFY_OPTIONS).serialize("json"))._unsafeUnwrap();
}

const chainModel = modelFrom(chainDoc(provModel));
const fileQn = (key: { path: string; hash: string }): string => provModel.fileQName(key);
const aQn = provModel.commandQName(stepRef, cmdA.outputs);
const bQn = provModel.commandQName(stepRef, cmdB.outputs);
const writeQn = provModel.commandQName(stepRef, writeScript.outputs);
const stepQn = provModel.stepQName(stepRef);

describe("computeLineage — backward", () => {
    const walk = computeLineage(chainModel, [fileQn(heatmapKey)], { direction: "backward" });

    test("walks the chain heatmap → B → de_results → A → counts + script → write_file", () => {
        expect(qns(walk).sort()).toEqual([fileQn(heatmapKey), bQn, fileQn(deResultsKey), aQn, fileQn(countsKey), fileQn(scriptKey), writeQn].sort());
        expect(edgeOf(walk, "inflexa:gen-" + fileQn(heatmapKey).slice("inflexa:file-".length))).toMatchObject({ kind: "generated", to: bQn });
        expect(walk.edges).toContainEqual(expect.objectContaining({ kind: "used", from: aQn, to: fileQn(countsKey) }));
        expect(walk.edges).toContainEqual(expect.objectContaining({ kind: "used", from: aQn, to: fileQn(scriptKey) }));
        expect(walk.edges).toContainEqual(expect.objectContaining({ kind: "generated", from: fileQn(scriptKey), to: writeQn }));
    });

    test("traverses only generation and usage — the derived edge, the informed spine, and the agents stay out", () => {
        expect(qns(walk)).not.toContain("inflexa:analysis-a1");
        expect(qns(walk)).not.toContain("inflexa:run-run-001");
        expect(walk.nodes.some((n) => n.kind === "agent")).toBe(false);
        expect(walk.edges.every((e) => e.kind === "generated" || e.kind === "used")).toBe(true);
    });

    test("a leaf file's generator is its step, and the step's own reads lie behind it", () => {
        const leafWalk = computeLineage(chainModel, [fileQn(leafKey)], { direction: "backward" });
        expect(leafWalk.edges).toContainEqual(expect.objectContaining({ kind: "generated", from: fileQn(leafKey), to: stepQn }));
        // The step-level read of counts.csv is one hop further.
        expect(qns(leafWalk)).toContain(fileQn(countsKey));
    });

    test("a cross-run prior read chains into the producing run's command", () => {
        const doc = chainDoc(provModel);
        const readerStep: ProvStepRef = { runId: "run-002", stepId: "step-model" };
        const modelKey = { path: "runs/run-002/step-model/output/model.bin", hash: "hashModel1" };
        const fit: ProvCommandRef = {
            kind: "command",
            command: "python fit.py",
            exitCode: 0,
            outputs: [modelKey],
            inputs: [{ ...deResultsKey, source: "prior" }],
        };
        applyProvEvent(provModel, doc, {
            type: "step_completed",
            analysisId: "a1",
            actor: system,
            outcome: { runId: "run-002", stepId: "step-model", status: "completed", completedAtMs: 1_700_000_003_000 },
            model,
        });
        applyProvEvent(provModel, doc, { type: "command_executed", analysisId: "a1", actor: system, step: readerStep, command: fit, model });
        applyProvEvent(provModel, doc, {
            type: "file_written",
            analysisId: "a1",
            actor: system,
            file: fileRefOf(modelKey),
            step: readerStep,
            generation: "command",
        });

        const walk2 = computeLineage(modelFrom(doc), [fileQn(modelKey)], { direction: "backward" });
        const fitQn = provModel.commandQName(readerStep, fit.outputs);
        // The prior read IS run-001's entity — the walk continues into its producing command.
        expect(walk2.edges).toContainEqual(expect.objectContaining({ kind: "used", from: fitQn, to: fileQn(deResultsKey) }));
        expect(walk2.edges).toContainEqual(expect.objectContaining({ kind: "generated", from: fileQn(deResultsKey), to: aQn }));
        expect(qns(walk2)).toContain(fileQn(countsKey));
    });

    test("a write-then-self-read command terminates, with both edges in the result", () => {
        const doc = provModel.freshDocument({ analysisId: "a1" });
        const selfKey = { path: "runs/run-001/step-de/output/self.csv", hash: "hashSelf01" };
        const selfRead: ProvCommandRef = { kind: "command", command: "bash gen.sh", exitCode: 0, outputs: [selfKey], inputs: [{ ...selfKey, source: "step" }] };
        applyProvEvent(provModel, doc, { type: "command_executed", analysisId: "a1", actor: system, step: stepRef, command: selfRead, model });
        applyProvEvent(provModel, doc, {
            type: "file_written",
            analysisId: "a1",
            actor: system,
            file: fileRefOf(selfKey),
            step: stepRef,
            generation: "command",
        });

        const genQn = provModel.commandQName(stepRef, selfRead.outputs);
        const walk3 = computeLineage(modelFrom(doc), [fileQn(selfKey)], { direction: "backward" });
        expect(qns(walk3).sort()).toEqual([fileQn(selfKey), genQn].sort());
        expect(walk3.edges).toContainEqual(expect.objectContaining({ kind: "generated", from: fileQn(selfKey), to: genQn }));
        expect(walk3.edges).toContainEqual(expect.objectContaining({ kind: "used", from: genQn, to: fileQn(selfKey) }));
    });
});

describe("computeLineage — forward", () => {
    test("walks from the staged input to every derived output", () => {
        const walk = computeLineage(chainModel, [fileQn(countsKey)], { direction: "forward" });
        // counts is read by command A and, at step grain, by the step; their outputs chain on.
        expect(qns(walk)).toContain(aQn);
        expect(qns(walk)).toContain(stepQn);
        expect(qns(walk)).toContain(fileQn(deResultsKey));
        expect(qns(walk)).toContain(fileQn(leafKey));
        expect(qns(walk)).toContain(bQn);
        expect(qns(walk)).toContain(fileQn(heatmapKey));
        expect(walk.edges).toContainEqual(expect.objectContaining({ kind: "used", from: stepQn, to: fileQn(countsKey) }));
        expect(walk.edges).toContainEqual(expect.objectContaining({ kind: "generated", from: fileQn(leafKey), to: stepQn }));
    });
});

describe("computeLineage — depth", () => {
    test("depth counts file hops from a file root; the truncation lands on a file node", () => {
        const walk = computeLineage(chainModel, [fileQn(heatmapKey)], { direction: "backward", depth: 1 });
        expect(qns(walk).sort()).toEqual([fileQn(heatmapKey), bQn, fileQn(deResultsKey)].sort());
        // The cut file's own producer lies beyond the bound.
        expect(walk.edges.some((e) => e.kind === "generated" && e.from === fileQn(deResultsKey))).toBe(false);
    });

    test("an activity root spends one edge less — its direct files sit at the first file hop", () => {
        const walk = computeLineage(chainModel, [bQn], { direction: "backward", depth: 1 });
        expect(qns(walk).sort()).toEqual([bQn, fileQn(deResultsKey)].sort());
        expect(walk.edges).toEqual([expect.objectContaining({ kind: "used", from: bQn, to: fileQn(deResultsKey) })]);
    });

    test("a multi-root walk bounds each node by its minimum distance over all roots", () => {
        // heatmap alone at depth 1 stops at de_results; de_results as a second root reaches on.
        const walk = computeLineage(chainModel, [fileQn(heatmapKey), fileQn(deResultsKey)], { direction: "backward", depth: 1 });
        expect(qns(walk)).toContain(aQn);
        expect(qns(walk)).toContain(fileQn(countsKey));
    });

    test("a root the model does not contain adds nothing", () => {
        expect(computeLineage(chainModel, ["inflexa:file-nope"], { direction: "backward" })).toEqual({ nodes: [], edges: [], truncated: [] });
    });
});

describe("computeLineage — truncated", () => {
    test("the file cut by the bound is truncated; an unbounded walk reports none", () => {
        expect(computeLineage(chainModel, [fileQn(heatmapKey)], { direction: "backward", depth: 1 }).truncated).toEqual([fileQn(deResultsKey)]);
        expect(computeLineage(chainModel, [fileQn(heatmapKey)], { direction: "backward" }).truncated).toEqual([]);
    });

    test("a node at the bound with nothing beyond it stays unmarked", () => {
        // At depth 2 both counts and the script sit at the bound: the script's write_file producer
        // lies beyond, counts has no producer at all.
        const walk = computeLineage(chainModel, [fileQn(heatmapKey)], { direction: "backward", depth: 2 });
        expect(qns(walk)).toContain(fileQn(countsKey));
        expect(walk.truncated).toEqual([fileQn(scriptKey)]);
    });

    test("an activity root's bound cuts on its file, one edge earlier", () => {
        expect(computeLineage(chainModel, [bQn], { direction: "backward", depth: 1 }).truncated).toEqual([fileQn(deResultsKey)]);
    });

    test("a forward walk truncates on the file whose readers lie beyond", () => {
        const walk = computeLineage(chainModel, [fileQn(countsKey)], { direction: "forward", depth: 1 });
        expect(walk.truncated).toEqual([fileQn(deResultsKey)]);
        // The leaf sits at the same bound with no reader beyond it.
        expect(qns(walk)).toContain(fileQn(leafKey));
    });

    test("a second root inside the bound un-truncates what it re-expands", () => {
        const walk = computeLineage(chainModel, [fileQn(heatmapKey), fileQn(deResultsKey)], { direction: "backward", depth: 1 });
        expect(qns(walk)).toContain(fileQn(countsKey));
        expect(walk.truncated).toEqual([fileQn(scriptKey)]);
    });
});

describe("computeLineage — truncated is equivalent to the depth+1 diff derivation", () => {
    // The re-derivation a consumer would otherwise run: the same walk one file hop wider reveals
    // exactly the edges the bounded walk left unexpanded, and each such edge's walk-direction
    // source that sits inside the bounded scope is a truncation point.
    function diffTruncated(model: LineageModel, roots: readonly string[], direction: "forward" | "backward", depth: number): string[] {
        const bounded = computeLineage(model, roots, { direction, depth });
        const scoped = new Set(qns(bounded));
        const reached = new Set(bounded.edges.map((e) => e.id));
        const out = new Set<string>();
        for (const edge of computeLineage(model, roots, { direction, depth: depth + 1 }).edges) {
            if (reached.has(edge.id)) continue;
            const source = direction === "backward" ? edge.from : edge.to;
            if (scoped.has(source)) out.add(source);
        }
        return [...out].sort();
    }

    function selfReadModel(): LineageModel {
        const doc = provModel.freshDocument({ analysisId: "a1" });
        const selfKey = { path: "runs/run-001/step-de/output/self.csv", hash: "hashSelf01" };
        const selfRead: ProvCommandRef = { kind: "command", command: "bash gen.sh", exitCode: 0, outputs: [selfKey], inputs: [{ ...selfKey, source: "step" }] };
        applyProvEvent(provModel, doc, { type: "command_executed", analysisId: "a1", actor: system, step: stepRef, command: selfRead, model });
        applyProvEvent(provModel, doc, {
            type: "file_written",
            analysisId: "a1",
            actor: system,
            file: fileRefOf(selfKey),
            step: stepRef,
            generation: "command",
        });
        return modelFrom(doc);
    }

    function crossRunModel(): LineageModel {
        const doc = chainDoc(provModel);
        const readerStep: ProvStepRef = { runId: "run-002", stepId: "step-model" };
        const modelKey = { path: "runs/run-002/step-model/output/model.bin", hash: "hashModel1" };
        const fit: ProvCommandRef = {
            kind: "command",
            command: "python fit.py",
            exitCode: 0,
            outputs: [modelKey],
            inputs: [{ ...deResultsKey, source: "prior" }],
        };
        applyProvEvent(provModel, doc, {
            type: "step_completed",
            analysisId: "a1",
            actor: system,
            outcome: { runId: "run-002", stepId: "step-model", status: "completed", completedAtMs: 1_700_000_003_000 },
            model,
        });
        applyProvEvent(provModel, doc, { type: "command_executed", analysisId: "a1", actor: system, step: readerStep, command: fit, model });
        applyProvEvent(provModel, doc, {
            type: "file_written",
            analysisId: "a1",
            actor: system,
            file: fileRefOf(modelKey),
            step: readerStep,
            generation: "command",
        });
        return modelFrom(doc);
    }

    const fixtures: [string, LineageModel][] = [
        ["chain", chainModel],
        ["golden", deriveLineageModel(goldenJson)._unsafeUnwrap()],
        ["self-read", selfReadModel()],
        ["cross-run", crossRunModel()],
    ];

    for (const [name, fixture] of fixtures) {
        test(`${name}: every root set, both directions, depths 0–4`, () => {
            const rootSets: string[][] = [
                ...fixture.nodes.map((n) => [n.qn]),
                fixture.nodes.filter((n) => n.kind === "file").map((n) => n.qn),
                [fixture.nodes.find((n) => n.kind === "activity")!.qn, fixture.nodes.find((n) => n.kind === "file")!.qn],
            ];
            for (const roots of rootSets) {
                for (const direction of ["backward", "forward"] as const) {
                    for (let depth = 0; depth <= 4; depth++) {
                        const inWalk = [...computeLineage(fixture, roots, { direction, depth }).truncated].sort();
                        expect(inWalk).toEqual(diffTruncated(fixture, roots, direction, depth));
                    }
                }
            }
        });
    }
});

describe("computeReachable — golden document", () => {
    const golden = deriveLineageModel(goldenJson)._unsafeUnwrap();

    test("both directions from a consumed input reaches the full dataflow cone and nothing else", () => {
        const sub = computeReachable(golden, ["inflexa:file-2cl35k0tb4udj"], { direction: "both" });
        expect(qns(sub).sort()).toEqual([
            "inflexa:cmd-r1-s1-1gmep6ya47zjz",
            "inflexa:cmd-r1-s1-302d2bs8ad5ko",
            "inflexa:cmd-r1-s1-3on7qauhakeey",
            "inflexa:file-18bvqsvo19q9p",
            "inflexa:file-2cl35k0tb4udj",
            "inflexa:file-2oo1fa1324nay",
            "inflexa:file-8cpsktnfc9if",
            "inflexa:file-c0kyjyc0bmim",
            "inflexa:file-monvuc8rxoat",
            "inflexa:step-r1-s1",
        ]);
    });

    test("a produced file reaches its agents via associated/attributed and the analysis via derived", () => {
        const sub = computeReachable(golden, ["inflexa:file-18bvqsvo19q9p"], { direction: "both" });
        const reached = new Set(qns(sub));
        expect(reached.has("inflexa:file-18bvqsvo19q9p")).toBe(true);
        expect(reached.has("inflexa:cmd-r1-s1-302d2bs8ad5ko")).toBe(true);
        expect(reached.has("inflexa:step-r1-s1")).toBe(true);
        expect(reached.has("inflexa:run-r1")).toBe(true);
        expect(reached.has("inflexa:analysis-a-golden")).toBe(true);
        expect(reached.has("inflexa:agent-system")).toBe(true);
        // A sibling command's exclusive output is not in this file's cone.
        expect(reached.has("inflexa:file-c0kyjyc0bmim")).toBe(false);
    });

    test("edgeKinds narrows the closure", () => {
        // Generation/usage alone: no spine, no analysis, no agents.
        const dataflow = computeReachable(golden, ["inflexa:file-18bvqsvo19q9p"], { direction: "both", edgeKinds: ["generated", "used"] });
        expect(dataflow.nodes.some((n) => n.kind === "agent")).toBe(false);
        expect(qns(dataflow)).not.toContain("inflexa:analysis-a-golden");
        expect(qns(dataflow)).not.toContain("inflexa:run-r1");
        // Adding the informed spine reaches the run; the agents still need associated/attributed.
        const withSpine = computeReachable(golden, ["inflexa:file-18bvqsvo19q9p"], { direction: "both", edgeKinds: ["generated", "used", "informed"] });
        expect(qns(withSpine)).toContain("inflexa:run-r1");
        expect(withSpine.nodes.some((n) => n.kind === "agent")).toBe(false);
    });

    test("a root the model does not contain adds nothing", () => {
        expect(computeReachable(golden, ["inflexa:file-nope"], { direction: "both" })).toEqual({ nodes: [], edges: [] });
    });
});

describe("computeReachable — directions on the chain", () => {
    test("backward is the upstream closure only, forward the downstream only", () => {
        const backward = new Set(qns(computeReachable(chainModel, [fileQn(deResultsKey)], { direction: "backward" })));
        expect(backward.has(aQn)).toBe(true);
        expect(backward.has(fileQn(countsKey))).toBe(true);
        expect(backward.has(bQn)).toBe(false);
        expect(backward.has(fileQn(heatmapKey))).toBe(false);

        const forward = new Set(qns(computeReachable(chainModel, [fileQn(deResultsKey)], { direction: "forward" })));
        expect(forward.has(bQn)).toBe(true);
        expect(forward.has(fileQn(heatmapKey))).toBe(true);
        expect(forward.has(aQn)).toBe(false);
    });

    test("restricted to generation/usage it reaches exactly the unbounded lineage scope", () => {
        const walk = computeLineage(chainModel, [fileQn(heatmapKey)], { direction: "backward" });
        const sub = computeReachable(chainModel, [fileQn(heatmapKey)], { direction: "backward", edgeKinds: ["generated", "used"] });
        expect(sub).toEqual({ nodes: walk.nodes, edges: walk.edges });
    });
});

describe("deriveLineageModel — tolerance", () => {
    // The dialect records input removal as the anonymous, timed lifecycle relation
    // wasInvalidatedBy(input, action, time) — SPEC.md.
    const removalJson = JSON.stringify({
        prefix: { inflexa: "https://inflexa.ai/prov#" },
        entity: { "inflexa:input-gone": { "prov:type": "inflexa:Input", "inflexa:path": "data/inputs/old.csv" } },
        activity: { "inflexa:action-a1-3": { "prov:type": "inflexa:RemoveInput" } },
        wasInvalidatedBy: {
            "_:id1": {
                "prov:entity": "inflexa:input-gone",
                "prov:activity": "inflexa:action-a1-3",
                "prov:time": "2023-11-14T22:13:19.500000+00:00",
            },
        },
    });

    test("an anonymous lifecycle relation gets a value-derived fallback id", () => {
        const derived = deriveLineageModel(removalJson)._unsafeUnwrap();
        expect(derived.edges).toEqual([
            {
                id: "invalidated:inflexa:input-gone->inflexa:action-a1-3",
                kind: "invalidated",
                from: "inflexa:input-gone",
                to: "inflexa:action-a1-3",
            },
        ]);
    });

    test("an identified invalidation keys by its dialect id", () => {
        const doc = JSON.parse(removalJson) as Record<string, Record<string, unknown>>;
        doc["wasInvalidatedBy"] = { "inflexa:inv-1": doc["wasInvalidatedBy"]!["_:id1"] };
        const derived = deriveLineageModel(JSON.stringify(doc))._unsafeUnwrap();
        expect(derived.edges).toEqual([{ id: "inflexa:inv-1", kind: "invalidated", from: "inflexa:input-gone", to: "inflexa:action-a1-3" }]);
    });

    test("synthesizes minimal nodes for undeclared relation endpoints", () => {
        const doc = JSON.parse(removalJson) as Record<string, unknown>;
        delete doc["entity"];
        delete doc["activity"];
        const derived = deriveLineageModel(JSON.stringify(doc))._unsafeUnwrap();
        expect(derived.nodes).toEqual([
            { kind: "input", qn: "inflexa:input-gone", label: "input-gone" },
            { kind: "activity", qn: "inflexa:action-a1-3", activity: "action", label: "action-a1-3" },
        ]);
    });

    test("a statement kind outside the seven is skipped, not an error", () => {
        const doc = JSON.parse(removalJson) as Record<string, unknown>;
        doc["agent"] = { "inflexa:agent-system": {}, "inflexa:agent-model-x": {} };
        doc["actedOnBehalfOf"] = {
            "inflexa:delegation-x-y": { "prov:delegate": "inflexa:agent-model-x", "prov:responsible": "inflexa:agent-system" },
        };
        const derived = deriveLineageModel(JSON.stringify(doc))._unsafeUnwrap();
        // The agents derive as nodes; the delegation contributes no edge.
        expect(derived.nodes.filter((n) => n.kind === "agent")).toHaveLength(2);
        expect(derived.edges.map((e) => e.kind)).toEqual(["invalidated"]);
    });
});

describe("findFileEntity", () => {
    const golden = deriveLineageModel(goldenJson)._unsafeUnwrap();

    test("matches a file entity by path + content hash", () => {
        expect(findFileEntity(golden, { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" })?.qn).toBe("inflexa:file-18bvqsvo19q9p");
        // A read input in the shared (path, hash) space matches too.
        expect(findFileEntity(golden, { path: "data/inputs/counts.csv", hash: "sha256:aaa" })?.qn).toBe("inflexa:file-2cl35k0tb4udj");
    });

    test("misses when the hash differs", () => {
        expect(findFileEntity(golden, { path: "runs/r1/s1/output/result.csv", hash: "sha256:other" })).toBeUndefined();
    });
});
