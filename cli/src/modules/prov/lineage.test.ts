import { describe, expect, test } from "bun:test";
import { ProvDocument } from "@inflexa-ai/tsprov";

import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ProvActor, ProvCommandRef, ProvFileRef, ProvStepRef } from "../../types/prov.ts";
import {
    appendCommandExecuted,
    appendFileWritten,
    appendInputUsed,
    appendRunStarted,
    appendStepCompleted,
    commandQName,
    fileQName,
    freshDocument,
    PROV_UNIFY_OPTIONS,
} from "./document.ts";
import { buildLineageIndex, formatJson, formatTree, resolveFileRef, walkLineage, type LineageFile } from "./lineage.ts";

// The traversal is tested against documents built with the REAL builders — the exact record shapes
// production writes (deterministic QNames, identified relations, shared (path, hash) entity space)
// — then round-tripped through PROV-JSON like the stored column, so the walk sees what the CLI sees.

const analysis: Analysis = {
    id: "a1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("Lineage Analysis"),
    slug: "lineage-analysis",
    anchorId: "anchor1",
    projectId: null,
};
const system: ProvActor = { kind: "system", version: "0.0.1", commit: "abc1234" };
const stepRef: ProvStepRef = { runId: "run-001", stepId: "step-de" };

// The canonical chain: counts.csv (staged data) → command A (Rscript) → de_results.csv → command B
// (python) → heatmap.png, plus a file-tool-written script read by A and a leaf file with only the
// step-level generation.
const countsKey = { path: "data/inputs/counts.csv", hash: "hashCount1" };
const deResultsKey = { path: "runs/run-001/step-de/output/de_results.csv", hash: "hashDe0001" };
const heatmapKey = { path: "runs/run-001/step-de/figures/heatmap.png", hash: "hashHeat01" };
const scriptKey = { path: "runs/run-001/step-de/scripts/de.R", hash: "hashScr001" };

const cmdA: ProvCommandRef = {
    kind: "command",
    command: "Rscript scripts/de.R",
    exitCode: 0,
    durationMs: 1200,
    scriptPath: scriptKey.path,
    outputs: [deResultsKey],
    inputs: [
        { ...countsKey, source: "data", fileId: "file-1" },
        { ...scriptKey, source: "step" },
    ],
};
const cmdB: ProvCommandRef = {
    kind: "command",
    command: "python plot.py",
    exitCode: 0,
    outputs: [heatmapKey],
    inputs: [{ ...deResultsKey, source: "step" }],
};
const writeScript: ProvCommandRef = { kind: "file_tool", tool: "write_file", outputs: [scriptKey] };
const leafFileRef: ProvFileRef = { path: "runs/run-001/step-de/output/leaf.txt", hash: "hashLeaf01", size: 24, producer: "command" };

function fileRefOf(key: { path: string; hash: string }, producer: "command" | "file_tool" = "command"): ProvFileRef {
    return { ...key, size: 100, producer };
}

/** The canonical document, round-tripped through PROV-JSON exactly like the stored column bytes. */
function canonicalDoc(): ProvDocument {
    const doc = freshDocument(analysis);
    appendRunStarted(doc, "a1", system, { runId: "run-001", planSummary: "DE analysis", startedAtMs: 1_700_000_000_000 });
    appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1_700_000_001_500 });
    appendCommandExecuted(doc, "a1", system, stepRef, writeScript);
    appendFileWritten(doc, "a1", system, fileRefOf(scriptKey, "file_tool"), stepRef, "command");
    appendCommandExecuted(doc, "a1", system, stepRef, cmdA);
    appendFileWritten(doc, "a1", system, fileRefOf(deResultsKey), stepRef, "command");
    appendCommandExecuted(doc, "a1", system, stepRef, cmdB);
    appendFileWritten(doc, "a1", system, fileRefOf(heatmapKey), stepRef, "command");
    appendFileWritten(doc, "a1", system, leafFileRef, stepRef, "step");
    appendInputUsed(doc, "a1", system, stepRef, { ...countsKey, source: "data", fileId: "file-1" });
    return ProvDocument.deserialize(doc.unified(PROV_UNIFY_OPTIONS).serialize("json"), "json");
}

const index = buildLineageIndex(canonicalDoc().unified(PROV_UNIFY_OPTIONS));

/** The single activity beneath `file`, asserted present. */
function onlyActivity(file: LineageFile) {
    expect(file.activities).toHaveLength(1);
    return file.activities[0]!;
}

describe("resolveFileRef", () => {
    test("an exact path resolves to its entity", () => {
        const infos = resolveFileRef(index, heatmapKey.path)._unsafeUnwrap();
        expect(infos).toHaveLength(1);
        expect(infos[0]!.qn).toBe(fileQName(heatmapKey));
        expect(infos[0]!.hash).toBe(heatmapKey.hash);
    });

    test("a path written twice (two hashes) resolves to BOTH entities — surfaced, not hidden", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-002", stepId: "step-de", status: "completed", completedAtMs: 2 });
        const rerun = { path: deResultsKey.path, hash: "hashDe0002" };
        appendFileWritten(doc, "a1", system, fileRefOf(deResultsKey), stepRef, "step");
        appendFileWritten(doc, "a1", system, fileRefOf(rerun), { runId: "run-002", stepId: "step-de" }, "step");
        const idx = buildLineageIndex(doc.unified(PROV_UNIFY_OPTIONS));

        const infos = resolveFileRef(idx, deResultsKey.path)._unsafeUnwrap();
        expect(infos.map((i) => i.hash).sort()).toEqual(["hashDe0001", "hashDe0002"]);
    });

    test("an exact hash and a unique prefix both resolve; a short prefix does not", () => {
        expect(resolveFileRef(index, "hashHeat01")._unsafeUnwrap()[0]!.qn).toBe(fileQName(heatmapKey));
        expect(resolveFileRef(index, "hashHe")._unsafeUnwrap()[0]!.qn).toBe(fileQName(heatmapKey));
        // Below MIN_HASH_PREFIX: prefix matching is not attempted at all.
        expect(resolveFileRef(index, "hashH").isErr()).toBe(true);
    });

    test("an ambiguous prefix fails listing the candidates", () => {
        // Two entities whose hashes share a ≥6-char prefix — the resolver must refuse to guess.
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 });
        appendFileWritten(doc, "a1", system, fileRefOf({ path: "output/a.csv", hash: "hashXX0001" }), stepRef, "step");
        appendFileWritten(doc, "a1", system, fileRefOf({ path: "output/b.csv", hash: "hashXX0002" }), stepRef, "step");
        const idx = buildLineageIndex(doc.unified(PROV_UNIFY_OPTIONS));

        const err = resolveFileRef(idx, "hashXX")._unsafeUnwrapErr();
        expect(err.type).toBe("ambiguous_hash");
        if (err.type === "ambiguous_hash") {
            expect(err.candidates).toHaveLength(2);
            expect(err.candidates.map((c) => c.hash).sort()).toEqual(["hashXX0001", "hashXX0002"]);
        }
    });

    test("an unknown ref fails with a sample of known paths", () => {
        const err = resolveFileRef(index, "no/such/file.csv")._unsafeUnwrapErr();
        expect(err.type).toBe("not_found");
        if (err.type === "not_found") expect(err.knownPaths).toContain(heatmapKey.path);
    });
});

describe("backward lineage", () => {
    test("walks the intra-step chain heatmap → B → de_results → A → counts + script → write_file", () => {
        const root = walkLineage(index, fileQName(heatmapKey), { forward: false });

        const b = onlyActivity(root);
        expect(b.kind).toBe("command");
        expect(b.command).toBe("python plot.py");
        expect(b.exitCode).toBe(0);
        expect(b.runId).toBe("run-001");
        expect(b.stepId).toBe("step-de");

        expect(b.files.map((f) => f.path)).toEqual([deResultsKey.path]);
        const a = onlyActivity(b.files[0]!);
        expect(a.command).toBe("Rscript scripts/de.R");

        const inputPaths = a.files.map((f) => f.path).sort();
        expect(inputPaths).toEqual([countsKey.path, scriptKey.path].sort());

        // The staged input is a terminal: no recorded generation, carrying its source classification.
        const counts = a.files.find((f) => f.path === countsKey.path)!;
        expect(counts.activities).toEqual([]);
        expect(counts.marker).toBeUndefined();
        expect(counts.source).toBe("data");

        // The script chains on into its file-tool writer.
        const script = a.files.find((f) => f.path === scriptKey.path)!;
        const writer = onlyActivity(script);
        expect(writer.kind).toBe("file_tool");
        expect(writer.tool).toBe("write_file");
        expect(writer.files).toEqual([]); // agent-authored content: no inputs by construction
    });

    test("a leaf file's generator is its step, and its step-level reads surface as step-grain inputs", () => {
        const root = walkLineage(index, fileQName(leafFileRef), { forward: false });
        const step = onlyActivity(root);
        expect(step.kind).toBe("step");
        expect(step.runId).toBe("run-001");
        expect(step.stepId).toBe("step-de");
        // The step's step-level read (counts.csv) attaches through step membership — an honest
        // upper bound the tree labels (step-grain), never presented as a per-file fact.
        expect(step.files.map((f) => f.path)).toEqual([countsKey.path]);
        const tree = formatTree([root], false);
        expect(tree).toContain("generated by: step (step-grain) — step step-de, run run-001");
    });

    test("a cross-run prior read chains into the producing run", () => {
        // Run-002 reads run-001's de_results (same (path, hash) → same entity) and writes a model file.
        const doc = canonicalDoc();
        const readerStep: ProvStepRef = { runId: "run-002", stepId: "step-model" };
        const modelKey = { path: "runs/run-002/step-model/output/model.bin", hash: "hashModel1" };
        const fit: ProvCommandRef = {
            kind: "command",
            command: "python fit.py",
            exitCode: 0,
            outputs: [modelKey],
            inputs: [{ ...deResultsKey, source: "prior" }],
        };
        appendStepCompleted(doc, "a1", system, { runId: "run-002", stepId: "step-model", status: "completed", completedAtMs: 3 });
        appendCommandExecuted(doc, "a1", system, readerStep, fit);
        appendFileWritten(doc, "a1", system, fileRefOf(modelKey), readerStep, "command");
        const idx = buildLineageIndex(doc.unified(PROV_UNIFY_OPTIONS));

        const root = walkLineage(idx, fileQName(modelKey), { forward: false });
        const fitNode = onlyActivity(root);
        expect(fitNode.runId).toBe("run-002");
        // The prior read IS run-001's entity: recursing shows run-001's producing command.
        const prior = fitNode.files.find((f) => f.path === deResultsKey.path)!;
        const producer = onlyActivity(prior);
        expect(producer.command).toBe("Rscript scripts/de.R");
        expect(producer.runId).toBe("run-001");
    });

    test("a write-then-self-read command terminates as a marked revisit, not an infinite walk", () => {
        const doc = freshDocument(analysis);
        const selfKey = { path: "runs/run-001/step-de/output/self.csv", hash: "hashSelf01" };
        const selfRead: ProvCommandRef = { kind: "command", command: "bash gen.sh", exitCode: 0, outputs: [selfKey], inputs: [{ ...selfKey, source: "step" }] };
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 });
        appendCommandExecuted(doc, "a1", system, stepRef, selfRead);
        appendFileWritten(doc, "a1", system, fileRefOf(selfKey), stepRef, "command");
        const idx = buildLineageIndex(doc.unified(PROV_UNIFY_OPTIONS));

        const root = walkLineage(idx, fileQName(selfKey), { forward: false });
        const gen = onlyActivity(root);
        expect(gen.files).toHaveLength(1);
        expect(gen.files[0]!.qn).toBe(root.qn);
        expect(gen.files[0]!.marker).toBe("revisit");
        expect(gen.files[0]!.activities).toEqual([]);
    });

    test("--depth bounds the walk with an explicit marker, never a clean leaf", () => {
        const root = walkLineage(index, fileQName(heatmapKey), { forward: false, depth: 1 });
        const b = onlyActivity(root);
        expect(b.files[0]!.marker).toBe("depth");
        expect(b.files[0]!.activities).toEqual([]);
    });
});

describe("forward lineage", () => {
    test("walks from the staged input to the derived outputs", () => {
        const root = walkLineage(index, fileQName(countsKey), { forward: true });

        // counts.csv is read by command A AND by the step-level registry — both are honest readers.
        const readers = root.activities;
        const a = readers.find((r) => r.kind === "command")!;
        expect(a.command).toBe("Rscript scripts/de.R");
        expect(a.files.map((f) => f.path)).toEqual([deResultsKey.path]);

        const de = a.files[0]!;
        const b = de.activities.find((r) => r.command === "python plot.py")!;
        expect(b.files.map((f) => f.path)).toEqual([heatmapKey.path]);
    });

    test("a step-level reader carries only its step-grain outputs, labeled as such", () => {
        const root = walkLineage(index, fileQName(countsKey), { forward: true });
        const step = root.activities.find((r) => r.kind === "step")!;
        // The step's own (leaf) generations are its step-grain outputs; command-generated files
        // are attributed to their commands and appear under them, not here.
        expect(step.files.map((f) => f.path)).toEqual([leafFileRef.path]);
        const tree = formatTree([root], true);
        expect(tree).toContain("used by: step (step-grain) — step step-de, run run-001");
    });

    test("a step reader with no leaf outputs scopes its absence claim to step grain", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 });
        appendInputUsed(doc, "a1", system, stepRef, { ...countsKey, source: "data" });
        const idx = buildLineageIndex(doc.unified(PROV_UNIFY_OPTIONS));

        const root = walkLineage(idx, fileQName(countsKey), { forward: true });
        const tree = formatTree([root], true);
        expect(tree).toContain("no step-grain outputs (command outputs are attributed to their commands)");
    });
});

describe("formatTree", () => {
    test("renders the chain with activities and inputs indented beneath their files", () => {
        const root = walkLineage(index, fileQName(heatmapKey), { forward: false });
        const tree = formatTree([root], false);

        expect(tree).toContain("figures/heatmap.png");
        expect(tree).toContain("generated by: python plot.py (exit 0) — step step-de, run run-001");
        expect(tree).toContain("generated by: Rscript scripts/de.R (exit 0)");
        expect(tree).toContain("generated by: write_file (file tool)");
        expect(tree).toContain("no recorded generation — terminal input");
        expect(tree).toContain("source data");
        // Indentation: A's line is deeper than B's.
        const bLine = tree.split("\n").find((l) => l.includes("python plot.py"))!;
        const aLine = tree.split("\n").find((l) => l.includes("Rscript"))!;
        expect(aLine.indexOf("generated by")).toBeGreaterThan(bLine.indexOf("generated by"));
    });

    test("labels multiple same-path roots by hash, and marks depth cutoffs", () => {
        const bounded = walkLineage(index, fileQName(heatmapKey), { forward: false, depth: 1 });
        const tree = formatTree([bounded], false);
        expect(tree).toContain("[depth limit]");

        const two = [
            walkLineage(index, fileQName(deResultsKey), { forward: false, depth: 1 }),
            walkLineage(index, fileQName(heatmapKey), { forward: false, depth: 1 }),
        ];
        const both = formatTree(two, false);
        expect(both).toContain("hashDe0001".slice(0, 12));
        expect(both).toContain("hashHeat01".slice(0, 12));
    });
});

describe("formatJson", () => {
    test("emits a flat graph in PROV semantics, identical edge directions for both walks", () => {
        const backward = formatJson([walkLineage(index, fileQName(heatmapKey), { forward: false })], false);
        const forward = formatJson([walkLineage(index, fileQName(countsKey), { forward: true })], true);

        // Backward: heatmap wasGeneratedBy B, B used de_results — entity→activity and activity→entity.
        const bQn = commandQName(stepRef, cmdB.outputs);
        expect(backward.roots).toEqual([fileQName(heatmapKey)]);
        expect(backward.edges).toContainEqual({ from: fileQName(heatmapKey), to: bQn, kind: "wasGeneratedBy" });
        expect(backward.edges).toContainEqual({ from: bQn, to: fileQName(deResultsKey), kind: "used" });
        const bNode = backward.nodes[bQn]!;
        expect(bNode.kind).toBe("command");
        if (bNode.kind === "command") expect(bNode.command).toBe("python plot.py");

        // Forward emits the SAME semantics: A used counts, de_results wasGeneratedBy A.
        const aQn = commandQName(stepRef, cmdA.outputs);
        expect(forward.edges).toContainEqual({ from: aQn, to: fileQName(countsKey), kind: "used" });
        expect(forward.edges).toContainEqual({ from: fileQName(deResultsKey), to: aQn, kind: "wasGeneratedBy" });
    });

    test("marks depth-truncated nodes, and only those", () => {
        const bounded = formatJson([walkLineage(index, fileQName(heatmapKey), { forward: false, depth: 1 })], false);
        const de = bounded.nodes[fileQName(deResultsKey)]!;
        expect(de.kind).toBe("file");
        if (de.kind === "file") expect(de.truncated).toBe(true);
        const heat = bounded.nodes[fileQName(heatmapKey)]!;
        if (heat.kind === "file") expect(heat.truncated).toBeUndefined();
    });
});
