import { describe, expect, test } from "bun:test";
import { ProvDocument } from "@inflexa-ai/tsprov";
import type { ProvGraph } from "@inflexa-ai/tsprov/graph";

import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ProvActor, ProvCommandRef, ProvFileRef, ProvModelId, ProvStepRef } from "../../types/prov.ts";
import {
    appendCommandExecuted,
    appendFileWritten,
    appendInputAdded,
    appendInputUsed,
    appendRunStarted,
    appendStepCompleted,
    commandQName,
    fileQName,
    freshDocument,
    PROV_UNIFY_OPTIONS,
} from "./document.ts";
import {
    computeLineage,
    formatDot,
    formatJson,
    formatMermaid,
    formatTree,
    lineageGraph,
    resolveLineageRef,
    type LineageFileInfo,
    type LineageJson,
    type LineageRoots,
} from "./lineage.ts";

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
const model: ProvModelId = "anthropic/claude-sonnet-4-5";
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
    appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1_700_000_001_500 }, model);
    appendCommandExecuted(doc, "a1", system, stepRef, writeScript, model);
    appendFileWritten(doc, "a1", system, fileRefOf(scriptKey, "file_tool"), stepRef, "command");
    appendCommandExecuted(doc, "a1", system, stepRef, cmdA, model);
    appendFileWritten(doc, "a1", system, fileRefOf(deResultsKey), stepRef, "command");
    appendCommandExecuted(doc, "a1", system, stepRef, cmdB, model);
    appendFileWritten(doc, "a1", system, fileRefOf(heatmapKey), stepRef, "command");
    appendFileWritten(doc, "a1", system, leafFileRef, stepRef, "step");
    appendInputUsed(doc, "a1", system, stepRef, { ...countsKey, source: "data", fileId: "file-1" });
    return ProvDocument.deserialize(doc.unified(PROV_UNIFY_OPTIONS).serialize("json"), "json");
}

const graph = lineageGraph(canonicalDoc());

/** Resolve a ref, walk it, and render both projections — the construction every scenario shares. */
function lineageOf(g: ProvGraph, ref: string, opts: { forward: boolean; depth?: number }): { json: LineageJson; tree: string } {
    const roots = resolveLineageRef(g, ref)._unsafeUnwrap();
    const result = computeLineage(g, roots, opts);
    return { json: formatJson(g, result), tree: formatTree(g, result, opts) };
}

/** The file infos of a resolution asserted to root at file entities. */
function fileInfos(roots: LineageRoots): LineageFileInfo[] {
    expect(roots.kind).toBe("files");
    return roots.kind === "files" ? roots.infos : [];
}

/** The file QNames an activity `used`, read off the flat JSON edges (PROV semantics: activity → entity). */
function usedFiles(json: LineageJson, activityQn: string): string[] {
    return json.edges.filter((e) => e.from === activityQn && e.kind === "used").map((e) => e.to);
}

/** The activity QNames a file `wasGeneratedBy`, read off the flat JSON edges (PROV semantics: entity → activity). */
function generators(json: LineageJson, fileQn: string): string[] {
    return json.edges.filter((e) => e.from === fileQn && e.kind === "wasGeneratedBy").map((e) => e.to);
}

describe("resolveLineageRef", () => {
    test("an exact path resolves to its entity", () => {
        const infos = fileInfos(resolveLineageRef(graph, heatmapKey.path)._unsafeUnwrap());
        expect(infos).toHaveLength(1);
        expect(infos[0]!.qn).toBe(fileQName(heatmapKey));
        expect(infos[0]!.hash).toBe(heatmapKey.hash);
    });

    test("a path written twice (two hashes) resolves to BOTH entities — surfaced, not hidden", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-002", stepId: "step-de", status: "completed", completedAtMs: 2 }, model);
        const rerun = { path: deResultsKey.path, hash: "hashDe0002" };
        appendFileWritten(doc, "a1", system, fileRefOf(deResultsKey), stepRef, "step");
        appendFileWritten(doc, "a1", system, fileRefOf(rerun), { runId: "run-002", stepId: "step-de" }, "step");
        const g = lineageGraph(doc);

        const infos = fileInfos(resolveLineageRef(g, deResultsKey.path)._unsafeUnwrap());
        expect(infos.map((i) => i.hash).sort()).toEqual(["hashDe0001", "hashDe0002"]);
    });

    test("an exact hash and a unique prefix both resolve; a short prefix does not", () => {
        expect(fileInfos(resolveLineageRef(graph, "hashHeat01")._unsafeUnwrap())[0]!.qn).toBe(fileQName(heatmapKey));
        expect(fileInfos(resolveLineageRef(graph, "hashHe")._unsafeUnwrap())[0]!.qn).toBe(fileQName(heatmapKey));
        // Below MIN_HASH_PREFIX: prefix matching is not attempted at all, and hashes are never
        // substring-searched, so a short hash fragment falls through to not-found.
        expect(resolveLineageRef(graph, "hashH").isErr()).toBe(true);
    });

    test("an ambiguous prefix fails listing the candidates", () => {
        // Two entities whose hashes share a ≥6-char prefix — the resolver must refuse to guess.
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendFileWritten(doc, "a1", system, fileRefOf({ path: "output/a.csv", hash: "hashXX0001" }), stepRef, "step");
        appendFileWritten(doc, "a1", system, fileRefOf({ path: "output/b.csv", hash: "hashXX0002" }), stepRef, "step");
        const g = lineageGraph(doc);

        const err = resolveLineageRef(g, "hashXX")._unsafeUnwrapErr();
        expect(err.type).toBe("ambiguous_hash");
        if (err.type === "ambiguous_hash") {
            expect(err.candidates).toHaveLength(2);
            expect(err.candidates.map((c) => c.hash).sort()).toEqual(["hashXX0001", "hashXX0002"]);
        }
    });

    test("an unknown ref fails with a sample of known paths", () => {
        const err = resolveLineageRef(graph, "no/such/file.csv")._unsafeUnwrapErr();
        expect(err.type).toBe("not_found");
        if (err.type === "not_found") expect(err.knownPaths).toContain(heatmapKey.path);
    });
});

describe("resolveLineageRef search tier", () => {
    test("a unique filename fragment resolves and walks exactly like the full path", () => {
        const byFragment = lineageOf(graph, "heatmap", { forward: false });
        const byPath = lineageOf(graph, heatmapKey.path, { forward: false });
        expect(byFragment.tree).toBe(byPath.tree);
        expect(byFragment.json).toEqual(byPath.json);
    });

    test("a command fragment roots the walk at the command activity", () => {
        const roots = resolveLineageRef(graph, "plot.py")._unsafeUnwrap();
        expect(roots.kind).toBe("activity");
        if (roots.kind === "activity") expect(roots.qn).toBe(commandQName(stepRef, cmdB.outputs));
    });

    test("a fragment matching one path recorded under two hashes walks both entities", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-002", stepId: "step-de", status: "completed", completedAtMs: 2 }, model);
        const rerun = { path: deResultsKey.path, hash: "hashDe0002" };
        appendFileWritten(doc, "a1", system, fileRefOf(deResultsKey), stepRef, "step");
        appendFileWritten(doc, "a1", system, fileRefOf(rerun), { runId: "run-002", stepId: "step-de" }, "step");
        const g = lineageGraph(doc);

        const infos = fileInfos(resolveLineageRef(g, "de_results")._unsafeUnwrap());
        expect(infos.map((i) => i.hash).sort()).toEqual(["hashDe0001", "hashDe0002"]);
        // One lineage per entity, each labeled by its own content hash.
        const { tree } = lineageOf(g, "de_results", { forward: false });
        expect(tree).toContain("hashDe0001".slice(0, 12));
        expect(tree).toContain("hashDe0002".slice(0, 12));
    });

    test("a fragment hitting a path AND a command fails with kind-tagged candidates", () => {
        // "de.R" is a substring of the script's path and of A's command line — a cross-kind mix.
        const err = resolveLineageRef(graph, "de.R")._unsafeUnwrapErr();
        expect(err.type).toBe("ambiguous_search");
        if (err.type === "ambiguous_search") {
            expect(err.total).toBe(2);
            expect(err.candidates.map((c) => c.kind).sort()).toEqual(["activity", "file"]);
            const file = err.candidates.find((c) => c.kind === "file")!;
            if (file.kind === "file") expect(file.path).toBe(scriptKey.path);
            const activity = err.candidates.find((c) => c.kind === "activity")!;
            if (activity.kind === "activity") expect(activity.line).toBe("Rscript scripts/de.R (exit 0) — step step-de, run run-001");
        }
    });

    test("a many-match fragment caps the candidates and counts the remainder", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        for (let i = 1; i <= 12; i++) {
            const n = String(i).padStart(2, "0");
            appendFileWritten(doc, "a1", system, fileRefOf({ path: `output/f${n}.csv`, hash: `hashFile${n}` }), stepRef, "step");
        }
        const g = lineageGraph(doc);

        const err = resolveLineageRef(g, "output/f")._unsafeUnwrapErr();
        expect(err.type).toBe("ambiguous_search");
        if (err.type === "ambiguous_search") {
            expect(err.candidates).toHaveLength(10);
            expect(err.total).toBe(12);
        }
    });

    test("a directory-style ref gets no special semantics — the normal failures apply", () => {
        // A directory prefix shared by several recorded files is just an ambiguous fragment...
        const shared = resolveLineageRef(graph, "runs/run-001/step-de/output/")._unsafeUnwrapErr();
        expect(shared.type).toBe("ambiguous_search");
        // ...and one matching nothing keeps the known-paths orientation.
        const missing = resolveLineageRef(graph, "nowhere/")._unsafeUnwrapErr();
        expect(missing.type).toBe("not_found");
    });

    test("a profile-only document still orients an unmatched reference", () => {
        // No file writes at all — the only pathed entity is the analysis-lifecycle input.
        const doc = freshDocument(analysis);
        appendInputAdded(doc, "a1", system, { path: "data/inputs/counts.csv", isDir: false, anchorId: "anchor1" }, null);
        const g = lineageGraph(doc);

        const err = resolveLineageRef(g, "no/such/ref.bin")._unsafeUnwrapErr();
        expect(err.type).toBe("not_found");
        if (err.type === "not_found") expect(err.knownPaths).toEqual(["data/inputs/counts.csv"]);
    });

    test("an exact path that also occurs as a substring elsewhere resolves via the exact tier only", () => {
        const doc = freshDocument(analysis);
        const key = { path: "data/x.csv", hash: "hashXfile1" };
        const outKey = { path: "output/y.csv", hash: "hashYfile1" };
        // The command line embeds the file's exact path, so the search tier WOULD see a cross-kind
        // mix — the exact-path tier must win before search is ever attempted.
        const reader: ProvCommandRef = { kind: "command", command: "cat data/x.csv", exitCode: 0, outputs: [outKey], inputs: [{ ...key, source: "step" }] };
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendFileWritten(doc, "a1", system, fileRefOf(key), stepRef, "step");
        appendCommandExecuted(doc, "a1", system, stepRef, reader, model);
        appendFileWritten(doc, "a1", system, fileRefOf(outKey), stepRef, "command");
        const g = lineageGraph(doc);

        const infos = fileInfos(resolveLineageRef(g, key.path)._unsafeUnwrap());
        expect(infos).toHaveLength(1);
        expect(infos[0]!.qn).toBe(fileQName(key));
    });
});

describe("activity-rooted walks", () => {
    test("backward from a command roots at its fact line with its inputs beneath", () => {
        const { tree, json } = lineageOf(graph, "plot.py", { forward: false });
        const lines = tree.split("\n");
        // The root is not reached via an edge, so its line carries no "generated by:" verb.
        expect(lines[0]).toBe("python plot.py (exit 0) — step step-de, run run-001");
        // B's input chain expands as normal file nodes: de_results, then its producer A beneath.
        expect(tree).toContain(deResultsKey.path);
        expect(tree).toContain("generated by: Rscript scripts/de.R (exit 0)");
        // JSON carries the activity among roots with its usual command facts.
        const bQn = commandQName(stepRef, cmdB.outputs);
        expect(json.roots).toEqual([bQn]);
        const node = json.nodes[bQn]!;
        expect(node.kind).toBe("command");
        if (node.kind === "command") expect(node.command).toBe("python plot.py");
    });

    test("forward from a command roots at its fact line with its outputs beneath", () => {
        const { tree } = lineageOf(graph, "plot.py", { forward: true });
        const lines = tree.split("\n");
        expect(lines[0]).toBe("python plot.py (exit 0) — step step-de, run run-001");
        expect(tree).toContain(heatmapKey.path);
        // heatmap has no recorded readers — the file terminal wording, not an activity claim.
        expect(tree).toContain("no recorded readers");
    });

    test("--depth counts file hops beneath an activity root", () => {
        const { tree } = lineageOf(graph, "plot.py", { forward: false, depth: 1 });
        // The direct input is shown but cut — its own producer lies beyond the bound.
        expect(tree).toContain(deResultsKey.path);
        expect(tree).toContain("[depth limit]");
        expect(tree).not.toContain("Rscript");
    });

    test("dot renders an activity-rooted walk with no shape change", () => {
        const roots = resolveLineageRef(graph, "plot.py")._unsafeUnwrap();
        const result = computeLineage(graph, roots, { forward: false });
        const dot = formatDot(graph, result);
        expect(dot.startsWith("digraph")).toBe(true);
        expect(dot).toContain(`"${commandQName(stepRef, cmdB.outputs)}" [shape=ellipse`);
        expect(dot).toContain('[label="used"]');
        expect(dot).toContain('[label="wasGeneratedBy"]');
    });
});

describe("backward lineage", () => {
    test("walks the intra-step chain heatmap → B → de_results → A → counts + script → write_file", () => {
        const { json } = lineageOf(graph, heatmapKey.path, { forward: false });
        const bQn = commandQName(stepRef, cmdB.outputs);
        const aQn = commandQName(stepRef, cmdA.outputs);
        const writeQn = commandQName(stepRef, writeScript.outputs);

        const b = json.nodes[bQn]!;
        expect(b.kind).toBe("command");
        if (b.kind === "command") {
            expect(b.command).toBe("python plot.py");
            expect(b.exitCode).toBe(0);
            expect(b.runId).toBe("run-001");
            expect(b.stepId).toBe("step-de");
        }
        // heatmap wasGeneratedBy B, and B used exactly de_results.
        expect(json.edges).toContainEqual({ from: fileQName(heatmapKey), to: bQn, kind: "wasGeneratedBy" });
        expect(usedFiles(json, bQn)).toEqual([fileQName(deResultsKey)]);

        // de_results wasGeneratedBy A, whose inputs are counts + the script.
        expect(json.edges).toContainEqual({ from: fileQName(deResultsKey), to: aQn, kind: "wasGeneratedBy" });
        const a = json.nodes[aQn]!;
        if (a.kind === "command") expect(a.command).toBe("Rscript scripts/de.R");
        expect(usedFiles(json, aQn).sort()).toEqual([fileQName(countsKey), fileQName(scriptKey)].sort());

        // The staged input is a terminal: no recorded generation, carrying its source classification.
        const counts = json.nodes[fileQName(countsKey)]!;
        expect(counts.kind).toBe("file");
        if (counts.kind === "file") expect(counts.source).toBe("data");
        expect(generators(json, fileQName(countsKey))).toEqual([]);

        // The script chains on into its file-tool writer, which reads nothing (agent-authored content).
        expect(json.edges).toContainEqual({ from: fileQName(scriptKey), to: writeQn, kind: "wasGeneratedBy" });
        const writer = json.nodes[writeQn]!;
        expect(writer.kind).toBe("file_tool");
        if (writer.kind === "file_tool") expect(writer.tool).toBe("write_file");
        expect(usedFiles(json, writeQn)).toEqual([]);
    });

    test("a leaf file's generator is its step, and its step-level reads surface as step-grain inputs", () => {
        const { json, tree } = lineageOf(graph, leafFileRef.path, { forward: false });
        // The leaf's only generator is its step activity.
        const stepQns = generators(json, fileQName(leafFileRef));
        expect(stepQns).toHaveLength(1);
        const step = json.nodes[stepQns[0]!]!;
        expect(step.kind).toBe("step");
        if (step.kind === "step") {
            expect(step.runId).toBe("run-001");
            expect(step.stepId).toBe("step-de");
        }
        // The step's step-level read (counts.csv) attaches through step membership — an honest
        // upper bound the tree labels (step-grain), never presented as a per-file fact.
        expect(usedFiles(json, stepQns[0]!)).toEqual([fileQName(countsKey)]);
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
        appendStepCompleted(doc, "a1", system, { runId: "run-002", stepId: "step-model", status: "completed", completedAtMs: 3 }, model);
        appendCommandExecuted(doc, "a1", system, readerStep, fit, model);
        appendFileWritten(doc, "a1", system, fileRefOf(modelKey), readerStep, "command");
        const g = lineageGraph(doc);

        const { json } = lineageOf(g, modelKey.path, { forward: false });
        const fitQn = commandQName(readerStep, fit.outputs);
        const fitNode = json.nodes[fitQn]!;
        if (fitNode.kind === "command") expect(fitNode.runId).toBe("run-002");
        // The prior read IS run-001's entity: recursing shows run-001's producing command.
        expect(usedFiles(json, fitQn)).toContain(fileQName(deResultsKey));
        const producerQns = generators(json, fileQName(deResultsKey));
        expect(producerQns).toEqual([commandQName(stepRef, cmdA.outputs)]);
        const producer = json.nodes[producerQns[0]!]!;
        if (producer.kind === "command") {
            expect(producer.command).toBe("Rscript scripts/de.R");
            expect(producer.runId).toBe("run-001");
        }
    });

    test("a write-then-self-read command terminates as a marked revisit, not an infinite walk", () => {
        const doc = freshDocument(analysis);
        const selfKey = { path: "runs/run-001/step-de/output/self.csv", hash: "hashSelf01" };
        const selfRead: ProvCommandRef = { kind: "command", command: "bash gen.sh", exitCode: 0, outputs: [selfKey], inputs: [{ ...selfKey, source: "step" }] };
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendCommandExecuted(doc, "a1", system, stepRef, selfRead, model);
        appendFileWritten(doc, "a1", system, fileRefOf(selfKey), stepRef, "command");
        const g = lineageGraph(doc);

        const { json, tree } = lineageOf(g, selfKey.path, { forward: false });
        const genQn = commandQName(stepRef, selfRead.outputs);
        // The command both generated AND used self.csv — a real 1-cycle. Both edges are recorded.
        expect(json.edges).toContainEqual({ from: fileQName(selfKey), to: genQn, kind: "wasGeneratedBy" });
        expect(json.edges).toContainEqual({ from: genQn, to: fileQName(selfKey), kind: "used" });
        // The entity renders once as the root and once as a marked re-encounter — never looping.
        const occurrences = tree.split("\n").filter((l) => l.includes("self.csv")).length;
        expect(occurrences).toBe(2);
        expect(tree).toContain("[already shown above]");
    });

    test("--depth bounds the walk with an explicit marker, never a clean leaf", () => {
        const { json, tree } = lineageOf(graph, heatmapKey.path, { forward: false, depth: 1 });
        // de_results is one full file-hop from heatmap: shown, then truncated (its producer is beyond).
        const de = json.nodes[fileQName(deResultsKey)]!;
        expect(de.kind).toBe("file");
        if (de.kind === "file") expect(de.truncated).toBe(true);
        expect(tree).toContain("[depth limit]");
        // The bounded branch never expands de_results' own producer (A).
        expect(tree).not.toContain("Rscript");
    });
});

describe("forward lineage", () => {
    test("walks from the staged input to the derived outputs", () => {
        const { json } = lineageOf(graph, countsKey.path, { forward: true });
        const aQn = commandQName(stepRef, cmdA.outputs);
        const bQn = commandQName(stepRef, cmdB.outputs);

        // counts is read by command A (used A → counts), which generates de_results.
        expect(json.edges).toContainEqual({ from: aQn, to: fileQName(countsKey), kind: "used" });
        expect(generators(json, fileQName(deResultsKey))).toEqual([aQn]);
        // de_results is read by B, which generates heatmap — the full forward chain.
        expect(json.edges).toContainEqual({ from: bQn, to: fileQName(deResultsKey), kind: "used" });
        expect(generators(json, fileQName(heatmapKey))).toEqual([bQn]);
    });

    test("a step-level reader carries only its step-grain outputs, labeled as such", () => {
        const { json, tree } = lineageOf(graph, countsKey.path, { forward: true });
        // counts is read by command A AND by the step-level registry — find that step among its readers.
        const stepQn = json.edges.find((e) => e.to === fileQName(countsKey) && e.kind === "used" && json.nodes[e.from]?.kind === "step")?.from;
        expect(stepQn).toBeDefined();
        // The step's own (leaf) generations are its step-grain outputs; command-generated files are
        // attributed to their commands and appear under them, not here.
        expect(generators(json, fileQName(leafFileRef))).toEqual([stepQn!]);
        expect(usedFiles(json, stepQn!)).toEqual([fileQName(countsKey)]);
        expect(tree).toContain("used by: step (step-grain) — step step-de, run run-001");
    });

    test("a step reader with no leaf outputs scopes its absence claim to step grain", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendInputUsed(doc, "a1", system, stepRef, { ...countsKey, source: "data" });
        const g = lineageGraph(doc);

        const { tree } = lineageOf(g, countsKey.path, { forward: true });
        expect(tree).toContain("no step-grain outputs (command outputs are attributed to their commands)");
    });
});

describe("formatTree", () => {
    test("renders the chain with activities and inputs indented beneath their files", () => {
        const { tree } = lineageOf(graph, heatmapKey.path, { forward: false });

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
        const bounded = lineageOf(graph, heatmapKey.path, { forward: false, depth: 1 });
        expect(bounded.tree).toContain("[depth limit]");

        // Two distinct roots in one bounded walk, each still labeled by its own content hash.
        const infos = [
            ...fileInfos(resolveLineageRef(graph, deResultsKey.path)._unsafeUnwrap()),
            ...fileInfos(resolveLineageRef(graph, heatmapKey.path)._unsafeUnwrap()),
        ];
        const both = formatTree(graph, computeLineage(graph, { kind: "files", infos }, { forward: false, depth: 1 }), { forward: false, depth: 1 });
        expect(both).toContain("hashDe0001".slice(0, 12));
        expect(both).toContain("hashHeat01".slice(0, 12));
    });
});

describe("formatJson", () => {
    test("emits a flat graph in PROV semantics, identical edge directions for both walks", () => {
        const backward = lineageOf(graph, heatmapKey.path, { forward: false }).json;
        const forward = lineageOf(graph, countsKey.path, { forward: true }).json;

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
        const bounded = lineageOf(graph, heatmapKey.path, { forward: false, depth: 1 }).json;
        const de = bounded.nodes[fileQName(deResultsKey)]!;
        expect(de.kind).toBe("file");
        if (de.kind === "file") expect(de.truncated).toBe(true);
        const heat = bounded.nodes[fileQName(heatmapKey)]!;
        if (heat.kind === "file") expect(heat.truncated).toBeUndefined();
    });
});

describe("formatDot", () => {
    test("emits a valid digraph whose edge set matches the JSON edges exactly", () => {
        const roots = resolveLineageRef(graph, heatmapKey.path)._unsafeUnwrap();
        const result = computeLineage(graph, roots, { forward: false });
        const json = formatJson(graph, result);
        const dot = formatDot(graph, result);

        expect(dot.startsWith("digraph")).toBe(true);
        expect(dot.trimEnd().endsWith("}")).toBe(true);

        // Parse every emitted edge line back into (from, kind, to) and compare the full set against
        // the JSON edges — same endpoints, same PROV orientation, nothing extra, nothing missing.
        const edgeLines = dot.split("\n").filter((l) => l.includes("->"));
        const edgeKey = (e: { from: string; to: string; kind: string }): string => `${e.kind}|${e.from}|${e.to}`;
        const parsed = edgeLines.map((l) => {
            const m = /^\s*"((?:[^"\\]|\\.)*)" -> "((?:[^"\\]|\\.)*)" \[label="(wasGeneratedBy|used)"\];$/.exec(l);
            expect(m).not.toBeNull();
            return { from: m![1]!, to: m![2]!, kind: m![3]! };
        });
        expect(parsed.map(edgeKey).sort()).toEqual(json.edges.map(edgeKey).sort());

        // Every JSON node appears as a quoted node statement, and the file label's quoting is intact.
        for (const qn of Object.keys(json.nodes)) {
            expect(dot).toContain(`"${qn}" [shape=`);
        }
        expect(dot).toContain(`label="${heatmapKey.path}  (hash ${heatmapKey.hash.slice(0, 12)})"`);
    });

    test("marks the depth-truncated node visibly; the unbounded walk does not", () => {
        const roots = resolveLineageRef(graph, heatmapKey.path)._unsafeUnwrap();

        const bounded = formatDot(graph, computeLineage(graph, roots, { forward: false, depth: 1 }));
        // The path appears only in the node statement's label — edge lines carry QNames.
        const deBounded = bounded.split("\n").find((l) => l.includes("de_results.csv"))!;
        expect(deBounded).toContain("style=dashed");
        expect(deBounded).toContain("[truncated]");

        const unbounded = formatDot(graph, computeLineage(graph, roots, { forward: false }));
        const deFull = unbounded.split("\n").find((l) => l.includes("de_results.csv"))!;
        expect(deFull).not.toContain("style=dashed");
        expect(deFull).not.toContain("[truncated]");
    });

    test("escapes double quotes and backslashes in labels", () => {
        const doc = freshDocument(analysis);
        const outKey = { path: "runs/run-001/step-de/output/quoted.txt", hash: "hashQuote1" };
        const quoting: ProvCommandRef = { kind: "command", command: 'bash -c "echo \\ hi"', exitCode: 0, outputs: [outKey], inputs: [] };
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendCommandExecuted(doc, "a1", system, stepRef, quoting, model);
        appendFileWritten(doc, "a1", system, fileRefOf(outKey), stepRef, "command");
        const g = lineageGraph(doc);

        const roots = resolveLineageRef(g, outKey.path)._unsafeUnwrap();
        const dot = formatDot(g, computeLineage(g, roots, { forward: false }));
        // The command's quote and backslash must round-trip escaped inside the emitted label.
        expect(dot).toContain('bash -c \\"echo \\\\ hi\\"');
    });
});

describe("identifier resolution tier", () => {
    test("a record's bare localpart and prefixed QName both resolve it", () => {
        const doc = freshDocument(analysis);
        appendInputAdded(doc, "a1", system, { path: "data/raw", isDir: true, anchorId: "anchor1" }, null);
        const g = lineageGraph(doc);
        // The identifier is discovered from the document itself — the token a user copies out of
        // the exported PROV, not a re-derivation of the QName hash.
        const inputQn = g.nodes.map((n) => n.element.identifier?.toString() ?? "").find((q) => q.startsWith("inflexa:input-"))!;

        const byLocalpart = resolveLineageRef(g, inputQn.slice("inflexa:".length))._unsafeUnwrap();
        expect(byLocalpart.kind).toBe("files");
        if (byLocalpart.kind === "files") expect(byLocalpart.infos.map((i) => i.qn)).toEqual([inputQn]);

        const byPrefixed = resolveLineageRef(g, inputQn)._unsafeUnwrap();
        expect(byPrefixed).toEqual(byLocalpart);
    });

    test("a command activity's QName roots an activity walk", () => {
        const bQn = commandQName(stepRef, cmdB.outputs);
        expect(resolveLineageRef(graph, bQn)._unsafeUnwrap()).toEqual({ kind: "activity", qn: bQn });
        const { tree } = lineageOf(graph, bQn, { forward: false });
        expect(tree.split("\n")[0]).toBe("python plot.py (exit 0) — step step-de, run run-001");
    });

    test("an exact path that equals another record's localpart resolves via the path tier", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        const firstKey = { path: "output/first.csv", hash: "hashFirst1" };
        appendFileWritten(doc, "a1", system, fileRefOf(firstKey), stepRef, "step");
        // A second file recorded AT the first entity's localpart as its path — the deliberate collision.
        const collidingPath = fileQName(firstKey).slice("inflexa:".length);
        const secondKey = { path: collidingPath, hash: "hashSecond" };
        appendFileWritten(doc, "a1", system, fileRefOf(secondKey), stepRef, "step");
        const g = lineageGraph(doc);

        const roots = resolveLineageRef(g, collidingPath)._unsafeUnwrap();
        expect(roots.kind).toBe("files");
        if (roots.kind === "files") {
            expect(roots.infos).toHaveLength(1);
            // The exact-path tier wins; the identifier tier (which names the FIRST file) is never reached.
            expect(roots.infos[0]!.qn).toBe(fileQName(secondKey));
        }
    });
});

describe("formatMermaid", () => {
    test("emits flowchart source with grammar-safe ids and the JSON edge set", () => {
        const roots = resolveLineageRef(graph, heatmapKey.path)._unsafeUnwrap();
        const result = computeLineage(graph, roots, { forward: false });
        const json = formatJson(graph, result);
        const mermaid = formatMermaid(graph, result);

        const lines = mermaid.split("\n");
        expect(lines[0]).toBe("flowchart LR");

        // Every remaining line is either a node definition or an edge — nothing unclassified.
        const nodeLines = lines.slice(1).filter((l) => /^\s+[A-Za-z0-9_]+(\(\[|\[)"/.test(l));
        const edgeLines = lines.slice(1).filter((l) => l.includes("-->") || l.includes("-.->"));
        expect(nodeLines.length + edgeLines.length).toBe(lines.length - 1);

        // Node ids are strictly grammar-safe and labels are quoted.
        for (const l of nodeLines) {
            expect(/^\s+([A-Za-z0-9_]+)(\(\[|\[)"(.*)"(\]\)|\])$/.test(l)).toBe(true);
        }

        // The edge set equals the JSON edges after the same qn → id transform, arrow style agreeing
        // with the labeled relation (solid generation, dotted usage).
        const idOf = (qn: string): string => qn.replace(/[^A-Za-z0-9_]/g, "_");
        const expected = json.edges.map((e) => `${idOf(e.from)}|${e.kind}|${idOf(e.to)}`).sort();
        const parsed = edgeLines.map((l) => {
            const m = /^\s+([A-Za-z0-9_]+) (-->|-\.->)\|(wasGeneratedBy|used)\| ([A-Za-z0-9_]+)$/.exec(l);
            expect(m).not.toBeNull();
            expect(m![2]).toBe(m![3] === "wasGeneratedBy" ? "-->" : "-.->");
            return `${m![1]}|${m![3]}|${m![4]}`;
        });
        expect(parsed.sort()).toEqual(expected);
    });

    test("a shared intermediate is one node with several edges — the true DAG shape", () => {
        const doc = freshDocument(analysis);
        const selfKey = { path: "runs/run-001/step-de/output/self.csv", hash: "hashSelf01" };
        const selfRead: ProvCommandRef = { kind: "command", command: "bash gen.sh", exitCode: 0, outputs: [selfKey], inputs: [{ ...selfKey, source: "step" }] };
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendCommandExecuted(doc, "a1", system, stepRef, selfRead, model);
        appendFileWritten(doc, "a1", system, fileRefOf(selfKey), stepRef, "command");
        const g = lineageGraph(doc);

        const roots = resolveLineageRef(g, selfKey.path)._unsafeUnwrap();
        const mermaid = formatMermaid(g, computeLineage(g, roots, { forward: false }));
        const lines = mermaid.split("\n");
        // The tree renders this entity twice (the root and a marked re-encounter); the graph draws
        // it ONCE, carrying both its generation and its self-read usage edge.
        const fileId = fileQName(selfKey).replace(/[^A-Za-z0-9_]/g, "_");
        expect(lines.filter((l) => l.trimStart().startsWith(`${fileId}([`))).toHaveLength(1);
        const incident = lines.filter((l) => (l.includes("-->") || l.includes("-.->")) && l.includes(fileId));
        expect(incident).toHaveLength(2);
    });

    test("labels with mermaid-significant characters are quoted and escaped", () => {
        const doc = freshDocument(analysis);
        const outKey = { path: "runs/run-001/step-de/output/esc.txt", hash: "hashEscape" };
        const tricky: ProvCommandRef = { kind: "command", command: 'grep "x" (a) #tag', exitCode: 0, outputs: [outKey], inputs: [] };
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1 }, model);
        appendCommandExecuted(doc, "a1", system, stepRef, tricky, model);
        appendFileWritten(doc, "a1", system, fileRefOf(outKey), stepRef, "command");
        const g = lineageGraph(doc);

        const roots = resolveLineageRef(g, outKey.path)._unsafeUnwrap();
        const mermaid = formatMermaid(g, computeLineage(g, roots, { forward: false }));
        // The embedded quotes arrive as Mermaid's entity escape; parentheses and hashes ride
        // inside the quoted label untouched.
        expect(mermaid).toContain("grep #quot;x#quot; (a) #tag (exit 0)");
        // No label body carries a raw double quote — only the wrapping quotes remain.
        const labels = [...mermaid.matchAll(/(\(\[|\[)"(.*)"(\]\)|\])/g)].map((m) => m[2]!);
        expect(labels.length).toBeGreaterThan(0);
        for (const label of labels) expect(label.includes('"')).toBe(false);
    });
});
