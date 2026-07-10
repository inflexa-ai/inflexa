import { beforeEach, describe, expect, test } from "bun:test";
import { ProvDocument } from "@inflexa-ai/tsprov";

import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis } from "../../db/primary_mutation.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type {
    ProvActor,
    ProvInputRef,
    ProvModelId,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvUsedInputRef,
    ProvFileRef,
    ProvFileKey,
    ProvCommandRef,
} from "../../types/prov.ts";
import {
    appendCreation,
    appendInputAdded,
    appendInputRemoved,
    appendRunStarted,
    appendRunCompleted,
    appendStepCompleted,
    appendCommandExecuted,
    appendFileWritten,
    appendInputUsed,
    fileQName,
    commandQName,
    modelAgentQName,
    freshDocument,
    serializeProvenance,
} from "./document.ts";
import { updateAnalysisProvenance } from "../../db/primary_mutation.ts";
import { initProvenanceRecording, flushProvenanceAsync, resetProvenanceRecorderForTests } from "./prov.ts";
import { getAnalysisIntegrity } from "../../db/primary_query.ts";
import { computeChainHash, computePayloadDigest, verifyHexDigest, resetSigningForTests, loadOrGenerateKeypair } from "./signing.ts";
import { verifyProvenance, verifyPayload } from "./verify.ts";

const analysis: Analysis = {
    id: "a1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("My Analysis"),
    slug: "my-analysis",
    anchorId: "anchor1",
    projectId: null,
};

const user: ProvActor = { kind: "user", email: "alice@example.org" };
const system: ProvActor = { kind: "system", version: "0.0.1", commit: "abc1234" };
const anon: ProvActor = { kind: "anonymous" };
// The model that drove every model-driven fixture below — the boot-resolved id, captured verbatim.
const model: ProvModelId = "claude-sonnet-4-5";

function inputRef(path: string): ProvInputRef {
    return { path, isDir: false, anchorId: "anchor1" };
}

// Execution-level fixtures: one run, one step within it, one file written by that step. The step
// QName is `inflexa:step-run-001-step-de`; the file QName is a `(path, hash)` content hash. The ms
// timestamps are chosen so `new Date(ms).toISOString()` is asserted verbatim below — proving the
// builders convert the PAYLOAD ms, never a wall clock.
const runRef: ProvRunRef = { runId: "run-001", planSummary: "Profile the dataset", startedAtMs: 1_700_000_000_000 };
const runOutcome: ProvRunOutcome = { runId: "run-001", status: "partial", completedAtMs: 1_700_000_004_200, durationMs: 4200 };
const stepRef: ProvStepRef = { runId: "run-001", stepId: "step-de" };
const stepOutcome: ProvStepOutcome = { runId: "run-001", stepId: "step-de", status: "completed", completedAtMs: 1_700_000_001_500, durationMs: 1500 };
// A prior-run read of run-001/step-de's output — SAME (path, hash) as fileRef, so it keys onto the
// exact file QName that file's `appendFileWritten` generates (the cross-run chain the design keys on).
const priorInput: ProvUsedInputRef = { path: "runs/run-001/step-de/output/results.csv", hash: "abcdef1234567890", source: "prior", fileId: "file-42" };
const fileRef: ProvFileRef = { path: "runs/run-001/step-de/output/results.csv", hash: "abcdef1234567890", size: 1024, producer: "command" };

// Command-execution fixtures, all within step-de of run-001. Command A (`Rscript scripts/de.R`) writes
// `de_results.csv`; command B (`python plot.py`) reads that SAME (path, hash) at command scope with
// `source: "step"` and writes `heatmap.png` — the intra-step chain the design keys on. The file-tool
// group writes `scripts/de.R`. A's `scriptPath` deliberately resolves to NEITHER its outputs nor its
// inputs (so its script edge is skipped — the unkeyable-entity guard).
const deResultsKey: ProvFileKey = { path: "runs/run-001/step-de/output/de_results.csv", hash: "hashDe0001" };
const heatmapKey: ProvFileKey = { path: "runs/run-001/step-de/figures/heatmap.png", hash: "hashHeat01" };
const cmdRunDe: ProvCommandRef = {
    kind: "command",
    command: "Rscript scripts/de.R",
    args: ["--fdr", "0.05"],
    exitCode: 0,
    durationMs: 1200,
    scriptPath: "scripts/de.R",
    outputs: [deResultsKey],
    inputs: [{ path: "data/inputs/counts.csv", hash: "hashCount1", source: "data", fileId: "file-1" }],
};
const cmdPlotHeatmap: ProvCommandRef = {
    kind: "command",
    command: "python plot.py",
    exitCode: 0,
    outputs: [heatmapKey],
    inputs: [{ path: deResultsKey.path, hash: deResultsKey.hash, source: "step" }],
};
const fileToolWriteScript: ProvCommandRef = {
    kind: "file_tool",
    tool: "write_file",
    outputs: [{ path: "runs/run-001/step-de/scripts/de.R", hash: "hashScr001" }],
};
// The ProvFileRef forms the produced-file `prov.file_written` events carry (generation "command").
const deResultsFileRef: ProvFileRef = { ...deResultsKey, size: 2048, producer: "command" };
const heatmapFileRef: ProvFileRef = { ...heatmapKey, size: 4096, producer: "command" };
const scriptFileRef: ProvFileRef = { ...fileToolWriteScript.outputs[0]!, size: 512, producer: "file_tool" };
// A leaf file: no producer record upstream, so its `prov.file_written` carries generation "step".
const leafFileRef: ProvFileRef = { path: "runs/run-001/step-de/output/leaf.txt", hash: "hashLeaf01", size: 24, producer: "command" };

describe("PROV document building (appendCreation / appendInputAdded / appendInputRemoved)", () => {
    test("appends each action's PROV records", () => {
        const doc = freshDocument(analysis);
        appendCreation(doc, "a1", system);
        appendInputAdded(doc, "a1", user, inputRef("data.csv"), null);
        appendInputRemoved(doc, "a1", anon, inputRef("data.csv"));
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("entity(inflexa:analysis-a1");
        expect(provn).toContain("agent(inflexa:agent-system");
        // qnameSafe replaces every non-[A-Za-z0-9_-] char — so both `@` and `.` become `_`.
        expect(provn).toContain("agent(inflexa:agent-user-alice_example_org");
        expect(provn).toContain("agent(inflexa:agent-anonymous");
        expect(provn).toContain("0.0.1"); // system agent's version
        expect(provn).toContain("abc1234"); // system agent's source commit (inflexa:commit)
        expect(provn).toContain("used(inflexa:action-"); // add → used
        expect(provn).toContain("wasInvalidatedBy(inflexa:input-"); // remove → wasInvalidatedBy
    });

    test("the same input is one entity across add and remove", () => {
        const doc = freshDocument(analysis);
        appendInputAdded(doc, "a1", user, inputRef("data.csv"), null);
        appendInputRemoved(doc, "a1", user, inputRef("data.csv"));
        const ids = doc
            .unified()
            .getRecords()
            .map((r) => r.identifier?.toString() ?? "")
            .filter((id) => id.startsWith("inflexa:input-"));
        expect(new Set(ids).size).toBe(1);
    });

    test("unified() collapses an agent re-declared across actions (the B decision)", () => {
        const doc = freshDocument(analysis);
        appendInputAdded(doc, "a1", user, inputRef("a.csv"), null);
        appendInputAdded(doc, "a1", user, inputRef("b.csv"), null);
        const agents = doc
            .unified()
            .getRecords()
            .map((r) => r.identifier?.toString() ?? "")
            .filter((id) => id === "inflexa:agent-user-alice_example_org");
        expect(agents.length).toBe(1);
    });

    test("round-trips losslessly through PROV-JSON (deserialize is the reload path)", () => {
        const doc = freshDocument(analysis);
        appendCreation(doc, "a1", system);
        const unified = doc.unified();
        const parsed = ProvDocument.deserialize(unified.serialize("json"), "json");
        expect(unified.equals(parsed)).toBe(true);
    });
});

describe("PROV execution builders (appendRunStarted / appendRunCompleted / appendStepCompleted / appendFileWritten)", () => {
    test("appendRunStarted records a run activity associated with the agent and using the analysis", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("activity(inflexa:run-run-001");
        expect(provn).toContain("inflexa:Run");
        expect(provn).toContain("Profile the dataset");
        // Relations now carry deterministic ids: PROV-N renders `keyword(id; endpoints…)`.
        expect(provn).toContain("wasAssociatedWith(inflexa:assoc-run-run-001-");
        expect(provn).toContain("used(inflexa:used-run-run-001; inflexa:run-run-001, inflexa:analysis-a1");
        // The run must NOT re-generate the analysis — appendCreation owns the single generation.
        expect(provn).not.toContain("wasGeneratedBy(inflexa:analysis-a1");
    });

    test("appendStepCompleted records a step activity informed by its run, carrying its settlement status", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("activity(inflexa:step-run-001-step-de");
        expect(provn).toContain("inflexa:Step");
        // The step activity carries its terminal settlement status.
        expect(provn).toContain("inflexa:status");
        expect(provn).toContain("completed");
        expect(provn).toContain("wasInformedBy(inflexa:informed-run-001-step-de; inflexa:step-run-001-step-de, inflexa:run-run-001");
        expect(provn).toContain("wasAssociatedWith(inflexa:assoc-step-run-001-step-de-");
    });

    test("appendFileWritten records a file entity generated by its step and derived from the analysis", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendFileWritten(doc, "a1", system, fileRef, stepRef, "step");
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("inflexa:File");
        expect(provn).toContain("results.csv");
        expect(provn).toContain("abcdef1234567890");
        // The file is generated by the STEP ACTIVITY — valid only because the step is an activity, not
        // an entity. Each file relation is identified (`keyword(id; endpoints…)`), the id reusing the
        // file QName's `(path, hash)` digest so it stays tied to the entity it edges.
        expect(provn).toMatch(/wasGeneratedBy\(inflexa:gen-\w+; inflexa:file-\w+, inflexa:step-run-001-step-de/);
        // The attribution id carries the agent digest as a second hyphen-separated segment.
        expect(provn).toMatch(/wasAttributedTo\(inflexa:attr-[\w-]+; inflexa:file-/);
        expect(provn).toMatch(/wasDerivedFrom\(inflexa:deriv-\w+; inflexa:file-\w+, inflexa:analysis-a1/);
    });

    // THE GATE (design risk #1): tsprov's unified() must merge the two split activity(runQn, …)
    // records — start-time and end-time — into ONE activity, never leaving a same-QName entity. If
    // this ever fails, appendRunCompleted's re-declaration strategy is invalid and the design's
    // fallback (record completion without re-declaring the run) is needed.
    test("run start + completion merge into exactly one run activity with both times and status", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        appendRunCompleted(doc, "a1", system, runOutcome);
        const unified = doc.unified();

        // PROV-N: the run QName is declared exactly once as an activity, and never as an entity.
        const provn = unified.serialize("provn");
        const runActivityCount = (provn.match(/activity\(inflexa:run-run-001[,)]/g) ?? []).length;
        expect(runActivityCount).toBe(1);
        expect(provn).not.toContain("entity(inflexa:run-run-001");

        // PROV-JSON structure: one entry under `activity` for the run QName, none under `entity`,
        // and the merged record carries the start time, end time, and outcome status together.
        const json = JSON.parse(unified.serialize("json")) as {
            activity?: Record<string, { "prov:startTime"?: string; "prov:endTime"?: string; "inflexa:status"?: string }>;
            entity?: Record<string, unknown>;
        };
        const runQn = "inflexa:run-run-001";
        expect(Object.keys(json.activity ?? {})).toContain(runQn);
        expect(Object.keys(json.entity ?? {})).not.toContain(runQn);
        const runActivity = json.activity?.[runQn];
        expect(runActivity?.["prov:startTime"]).toBeDefined();
        expect(runActivity?.["prov:endTime"]).toBeDefined();
        expect(runActivity?.["inflexa:status"]).toBe("partial");
    });

    // D1: formal times come ONLY from the payload ms, never the append-time wall clock. Asserting the
    // EXACT ISO strings is the proof — a wall-clock read would produce today's date, not these.
    test("run and step formal times equal the ISO of the payload ms — no wall-clock read", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        appendRunCompleted(doc, "a1", system, runOutcome);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        const json = JSON.parse(doc.unified().serialize("json")) as {
            activity?: Record<string, { "prov:startTime"?: string; "prov:endTime"?: string; "inflexa:status"?: string }>;
        };
        const run = json.activity?.["inflexa:run-run-001"];
        // tsprov normalizes the ISO offset (`+00:00` vs `Z`), so compare on the second-precision prefix
        // Date.parse round-trips identically — the point is the VALUE is the payload's, not `Date.now()`.
        expect(Date.parse(run!["prov:startTime"]!)).toBe(runRef.startedAtMs);
        expect(Date.parse(run!["prov:endTime"]!)).toBe(runOutcome.completedAtMs);
        const step = json.activity?.["inflexa:step-run-001-step-de"];
        expect(Date.parse(step!["prov:endTime"]!)).toBe(stepOutcome.completedAtMs);
        expect(step!["inflexa:status"]).toBe("completed");
    });

    // D3: a prior-run read keyed by `(path, hash)` resolves to the SAME entity the producing file
    // generated — so the cross-run derivation chain (producing step → file → reading step) falls out
    // of `unified()` with no extra modeling. This is the load-bearing merge the design rests on.
    test("a prior-run read chains to its producing step: one entity generated by run-001 and used by the reader", () => {
        const doc = freshDocument(analysis);
        // Run 1 produces the file.
        appendRunStarted(doc, "a1", system, runRef);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendFileWritten(doc, "a1", system, fileRef, stepRef, "step");
        // A later run's step reads it back with source "prior" — same (path, hash) as fileRef.
        const readerStep: ProvStepRef = { runId: "run-002", stepId: "step-model" };
        appendStepCompleted(doc, "a1", system, { runId: "run-002", stepId: "step-model", status: "completed", completedAtMs: 1_700_000_050_000 }, model);
        appendInputUsed(doc, "a1", system, readerStep, priorInput);

        const unified = doc.unified();
        const fQn = fileQName(fileRef);
        // The input read's QName equals the produced file's QName — the merge key.
        expect(fileQName(priorInput)).toBe(fQn);
        // Exactly ONE entity under that shared QName after unify.
        const ids = unified.getRecords().map((r) => r.identifier?.toString() ?? "");
        expect(ids.filter((id) => id === fQn).length).toBe(1);

        // The one entity is generated by run-001's step AND used by run-002's step.
        const provn = unified.serialize("provn");
        expect(provn).toMatch(/wasGeneratedBy\(inflexa:gen-\w+; inflexa:file-\w+, inflexa:step-run-001-step-de/);
        expect(provn).toMatch(/used\(inflexa:used-input-run-002-step-model-\w+; inflexa:step-run-002-step-model, inflexa:file-/);
    });

    test("execution records round-trip losslessly through PROV-JSON", () => {
        const doc = freshDocument(analysis);
        appendCreation(doc, "a1", system);
        appendRunStarted(doc, "a1", system, runRef);
        appendRunCompleted(doc, "a1", system, runOutcome);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendFileWritten(doc, "a1", system, fileRef, stepRef, "step");
        appendInputUsed(doc, "a1", system, stepRef, priorInput);
        const unified = doc.unified();
        const parsed = ProvDocument.deserialize(unified.serialize("json"), "json");
        expect(unified.equals(parsed)).toBe(true);
    });

    // Replay idempotency: DBOS re-executes the workflow body on recovery, re-emitting identical
    // events. Deterministic QNames collapse ELEMENTS to one record per QName under unified(); the
    // relations' deterministic ids must likewise collapse to one record per id (an anonymous relation
    // would instead duplicate, since unified() dedups by identifier only).
    test("duplicate emission dedups activities and relations by deterministic identifier under unified()", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendFileWritten(doc, "a1", system, fileRef, stepRef, "step");
        // Re-apply the same events, as body re-execution on recovery would.
        appendRunStarted(doc, "a1", system, runRef);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendFileWritten(doc, "a1", system, fileRef, stepRef, "step");

        const unified = doc.unified();
        const ids = unified.getRecords().map((r) => r.identifier?.toString() ?? "");
        expect(ids.filter((id) => id === "inflexa:run-run-001").length).toBe(1);
        expect(ids.filter((id) => id === "inflexa:step-run-001-step-de").length).toBe(1);

        // Relations do not duplicate: each relation keyword appears exactly its single-emission count
        // (one apiece, except the three `wasAssociatedWith` edges — the run's and the step's agent,
        // plus the step's model agent).
        const provn = unified.serialize("provn");
        const occurrences = (needle: string): number => provn.split(needle).length - 1;
        expect(occurrences("used(")).toBe(1);
        expect(occurrences("wasInformedBy(")).toBe(1);
        expect(occurrences("wasGeneratedBy(")).toBe(1);
        expect(occurrences("wasAssociatedWith(")).toBe(3);
        expect(occurrences("actedOnBehalfOf(")).toBe(1);
        expect(occurrences("wasAttributedTo(")).toBe(1);
        expect(occurrences("wasDerivedFrom(")).toBe(1);
    });

    // The input `used` edge and its entity must dedup on re-emission exactly like the file relations —
    // the used-input relation id is deterministic over its endpoint tuple, so a replay merges it.
    test("duplicate emission of an input read dedups the input entity and its used edge", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendInputUsed(doc, "a1", system, stepRef, priorInput);
        // Re-apply, as body re-execution on recovery would.
        appendInputUsed(doc, "a1", system, stepRef, priorInput);

        const unified = doc.unified();
        const ids = unified.getRecords().map((r) => r.identifier?.toString() ?? "");
        // One entity under the input's file QName, and one used-input relation record.
        expect(ids.filter((id) => id === fileQName(priorInput)).length).toBe(1);
        expect(ids.filter((id) => id.startsWith("inflexa:used-input-")).length).toBe(1);
    });
});

describe("PROV command builders (appendCommandExecuted + generation move)", () => {
    test("the command variant records an inflexa:Command activity with its facts, informed by step, associated with agent", () => {
        const doc = freshDocument(analysis);
        appendRunStarted(doc, "a1", system, runRef);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model);
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("activity(inflexa:cmd-run-001-step-de-");
        expect(provn).toContain("inflexa:Command");
        expect(provn).toContain("Rscript scripts/de.R"); // inflexa:command
        expect(provn).toContain("--fdr 0.05"); // inflexa:args, joined into one string
        expect(provn).toContain("inflexa:exitCode");
        expect(provn).toContain("inflexa:durationMs");
        // The command activity is informed by ITS STEP (not the run) and associated with the agent.
        expect(provn).toMatch(/wasInformedBy\(inflexa:informed-cmd-run-001-step-de-\w+; inflexa:cmd-run-001-step-de-\w+, inflexa:step-run-001-step-de/);
        expect(provn).toMatch(/wasAssociatedWith\(inflexa:assoc-cmd-run-001-step-de-/);
        // Exactly one COMMAND-scoped used edge — the single data input. The unresolvable `scriptPath`
        // ("scripts/de.R" matches no output/input) draws NO edge, proving the unkeyable-entity guard
        // skips it. (Scoped to `used-cmd-` so the run→analysis `used` edge from appendRunStarted is excluded.)
        expect((provn.match(/used\(inflexa:used-cmd-/g) ?? []).length).toBe(1);
        expect(provn).toMatch(/used\(inflexa:used-cmd-run-001-step-de-[\w-]+; inflexa:cmd-run-001-step-de-\w+, inflexa:file-/);
    });

    test("the file_tool variant records an inflexa:FileToolWrite activity with the tool and no inputs", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendCommandExecuted(doc, "a1", system, stepRef, fileToolWriteScript, model);
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("inflexa:FileToolWrite");
        expect(provn).toContain("write_file"); // inflexa:tool
        expect(provn).not.toContain("inflexa:Command"); // not the command kind
        // It generates its output but reads nothing — a file-tool write is agent-authored content.
        expect(provn).toMatch(/wasGeneratedBy\(inflexa:gen-\w+; inflexa:file-\w+, inflexa:cmd-run-001-step-de-/);
        expect(provn).not.toContain("used(");
    });

    // The spec's intra-step chain scenario: A writes de_results, B reads it (source "step") and writes
    // heatmap. After unify: ONE de_results entity, generated by A's activity, used by B's activity.
    test("intra-step chain: de_results is generated by command A and used by command B; heatmap by B", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdPlotHeatmap, model);
        // The produced-file entities are declared by their file_written events (generation "command").
        appendFileWritten(doc, "a1", system, deResultsFileRef, stepRef, "command");
        appendFileWritten(doc, "a1", system, heatmapFileRef, stepRef, "command");

        const unified = doc.unified();
        const deQn = fileQName(deResultsKey);
        const aQn = commandQName(stepRef, cmdRunDe.outputs);
        const bQn = commandQName(stepRef, cmdPlotHeatmap.outputs);
        // The read's QName equals the produced file's QName — the shared entity the chain walks through.
        expect(fileQName({ path: cmdPlotHeatmap.inputs[0]!.path, hash: cmdPlotHeatmap.inputs[0]!.hash })).toBe(deQn);
        // Exactly ONE entity under that QName after unify.
        expect(unified.getRecords().filter((r) => (r.identifier?.toString() ?? "") === deQn).length).toBe(1);

        const provn = unified.serialize("provn");
        // de_results generated by A (wasGeneratedBy(id; entity, activity)) and used by B (used(id; activity, entity)).
        expect(provn).toContain(`${deQn}, ${aQn}`);
        expect(provn).toContain(`${bQn}, ${deQn}`);
        // heatmap is generated by B.
        expect(provn).toContain(`${fileQName(heatmapKey)}, ${bQn}`);
    });

    // design D3 / spec: exactly one generation edge per file — a produced file's sole generation is its
    // command activity; a leaf file's sole generation is the step activity; no entity carries two.
    test("exactly one generation edge per file: produced → command, leaf → step, never both", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        // Produced file: its command owns the generation; the file event (generation "command") skips its edge.
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model);
        appendFileWritten(doc, "a1", system, deResultsFileRef, stepRef, "command");
        // Leaf file: no command; the step-level generation is the fallback.
        appendFileWritten(doc, "a1", system, leafFileRef, stepRef, "step");

        const provn = doc.unified().serialize("provn");
        // Two generation edges total, one per file — no file accrued a second.
        expect((provn.match(/wasGeneratedBy\(/g) ?? []).length).toBe(2);
        // The produced file is generated by a command activity, NOT the step.
        const producedQn = fileQName(deResultsKey);
        expect(provn).toContain(`${producedQn}, inflexa:cmd-run-001-step-de-`);
        expect(provn).not.toContain(`${producedQn}, inflexa:step-run-001-step-de`);
        // The leaf file is generated by the step activity.
        expect(provn).toContain(`${fileQName(leafFileRef)}, inflexa:step-run-001-step-de`);
    });

    test("a scriptPath matching a command input resolves to that entity and its used edge dedups with the input", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        // The script IS one of the command's inputs (an intra-step read of a script a file-tool wrote).
        const scriptPath = "runs/run-001/step-de/scripts/de.R";
        const withScript: ProvCommandRef = {
            kind: "command",
            command: "Rscript scripts/de.R",
            exitCode: 0,
            scriptPath,
            outputs: [{ path: "runs/run-001/step-de/output/x.csv", hash: "hashX00001" }],
            inputs: [{ path: scriptPath, hash: "hashScr001", source: "step" }],
        };
        appendCommandExecuted(doc, "a1", system, stepRef, withScript, model);
        const provn = doc.unified().serialize("provn");
        // Both the input loop and the script resolution address the same entity with the same used id,
        // so after unify there is exactly ONE used edge — the command reads the script once.
        expect((provn.match(/used\(/g) ?? []).length).toBe(1);
        expect(provn).toContain(fileQName({ path: scriptPath, hash: "hashScr001" }));
    });

    // Replay idempotency: DBOS re-executes the body, re-emitting the same command group. Deterministic
    // output-set QNames + relation ids collapse the re-emission to one record set under unified().
    test("duplicate command emission dedups the activity and every relation by the output-set QName", () => {
        // No step activity here so every relation counted below belongs to the command group alone —
        // the command's `wasInformedBy(cmd, step)` is a forward reference the dedup count tolerates.
        const doc = freshDocument(analysis);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model); // body re-execution on recovery

        const unified = doc.unified();
        const cmdQn = commandQName(stepRef, cmdRunDe.outputs);
        const ids = unified.getRecords().map((r) => r.identifier?.toString() ?? "");
        expect(ids.filter((id) => id === cmdQn).length).toBe(1);

        const provn = unified.serialize("provn");
        const occurrences = (needle: string): number => provn.split(needle).length - 1;
        expect(occurrences("wasInformedBy(")).toBe(1);
        expect(occurrences("wasAssociatedWith(")).toBe(2); // the actor's agent + the model agent
        expect(occurrences("actedOnBehalfOf(")).toBe(1);
        expect(occurrences("wasGeneratedBy(")).toBe(1); // one output
        expect(occurrences("used(")).toBe(1); // one input (unresolvable script skipped)
    });

    test("command records round-trip losslessly through PROV-JSON", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model);
        appendCommandExecuted(doc, "a1", system, stepRef, fileToolWriteScript, model);
        const unified = doc.unified();
        const parsed = ProvDocument.deserialize(unified.serialize("json"), "json");
        expect(unified.equals(parsed)).toBe(true);
    });
});

describe("PROV model agent (the LLM behind model-driven activities)", () => {
    // Counts the model-agent ASSOCIATION edges: in PROV-N an association renders the agent as a
    // second argument (`wasAssociatedWith(id; activity, agent…)`), so `, {agentQn}` matches exactly
    // those — the delegation's delegate follows `; ` and the agent declaration follows `agent(`.
    const modelAssociations = (provn: string, agentQn: string): number => provn.split(`, ${agentQn}`).length - 1;

    test("a step is associated with both the cli agent and the model agent, which delegates for the cli", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        const provn = doc.unified().serialize("provn");

        // The model agent is declared with its identity: both types, the label, and the verbatim
        // model id — its ONLY identity attribute (no provider/endpoint vocabulary; model-agnostic).
        const modelQn = modelAgentQName(model);
        expect(provn).toContain(`agent(${modelQn}`);
        expect(provn).toContain("prov:SoftwareAgent");
        expect(provn).toContain("inflexa:Model");
        expect(provn).toContain("inflexa:model");
        expect(provn).toContain("claude-sonnet-4-5");
        expect(provn).not.toContain("inflexa:provider");
        expect(provn).not.toContain("inflexa:endpoint");

        // The step activity carries TWO associations — the cli agent's and the model agent's — and
        // the model delegates for the cli agent (the agent the user directed).
        expect((provn.match(/wasAssociatedWith\(inflexa:assoc-step-run-001-step-de-/g) ?? []).length).toBe(2);
        expect(modelAssociations(provn, modelQn)).toBe(1);
        expect(provn).toMatch(/actedOnBehalfOf\(inflexa:delegation-[\w-]+; inflexa:agent-model-\w+, inflexa:agent-system/);
    });

    test("one agent per distinct model across steps and commands: one declaration, one delegation, three associations", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-plot", status: "completed", completedAtMs: 1_700_000_002_000 }, model);
        appendCommandExecuted(doc, "a1", system, stepRef, cmdRunDe, model);

        const unified = doc.unified();
        const modelQn = modelAgentQName(model);
        const ids = unified.getRecords().map((r) => r.identifier?.toString() ?? "");
        expect(ids.filter((id) => id === modelQn).length).toBe(1);

        const provn = unified.serialize("provn");
        expect((provn.match(/actedOnBehalfOf\(/g) ?? []).length).toBe(1);
        expect(modelAssociations(provn, modelQn)).toBe(3); // two steps + one command
    });

    test("distinct model ids yield distinct agents, and each id is recorded verbatim", () => {
        const local: ProvModelId = "qwen3";
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-local", status: "completed", completedAtMs: 1_700_000_003_000 }, local);
        const provn = doc.unified().serialize("provn");

        // Two distinct agents — the verbatim id is the whole identity.
        expect(modelAgentQName(local)).not.toBe(modelAgentQName(model));
        expect(provn).toContain(`agent(${modelAgentQName(model)}`);
        expect(provn).toContain(`agent(${modelAgentQName(local)}`);
        expect(provn).toContain("claude-sonnet-4-5");
        expect(provn).toContain("qwen3");
    });

    test("a vendor-qualified {provider}/{model} id is captured verbatim, not parsed", () => {
        // The id is opaque: a host whose model naming is vendor-qualified records the full name
        // as-is — provenance keeps no provider vocabulary to interpret it against.
        const qualified: ProvModelId = "anthropic/claude-opus-4-8";
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, qualified);
        const provn = doc.unified().serialize("provn");
        expect(provn).toContain("anthropic/claude-opus-4-8");
        expect(provn).toContain(`agent(${modelAgentQName(qualified)}`);
    });

    test("duplicate step emission dedups the model agent, its delegation, and its association", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendStepCompleted(doc, "a1", system, stepOutcome, model); // body re-execution on recovery

        const unified = doc.unified();
        const modelQn = modelAgentQName(model);
        const ids = unified.getRecords().map((r) => r.identifier?.toString() ?? "");
        expect(ids.filter((id) => id === modelQn).length).toBe(1);

        const provn = unified.serialize("provn");
        expect((provn.match(/actedOnBehalfOf\(/g) ?? []).length).toBe(1);
        expect(modelAssociations(provn, modelQn)).toBe(1);
    });

    test("model-agent records round-trip losslessly through PROV-JSON", () => {
        const doc = freshDocument(analysis);
        appendStepCompleted(doc, "a1", system, stepOutcome, model);
        appendStepCompleted(doc, "a1", system, { runId: "run-001", stepId: "step-local", status: "completed", completedAtMs: 1_700_000_003_000 }, "qwen3");
        const unified = doc.unified();
        const parsed = ProvDocument.deserialize(unified.serialize("json"), "json");
        expect(unified.equals(parsed)).toBe(true);
    });
});

describe("provenance recorder (bus → in-memory doc → column)", () => {
    beforeEach(() => {
        freshDb();
        resetProvenanceRecorderForTests();
        resetSigningForTests(null);
        initProvenanceRecording(); // idempotent: subscribes once across the whole test run
    });

    test("emitted events accumulate in memory and flush to the analyses.provenance column", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-accum-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        expect(getAnalysisProvenance("a1")._unsafeUnwrap()).toBeNull();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        Bus.emit("inflexa", {
            type: "prov.input_added",
            analysisId: "a1",
            actor: user,
            input: { path: "data.csv", isDir: false, anchorId: "anchor1" },
            derivedFromAnalysisId: null,
        });
        await flushProvenanceAsync();

        const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
        expect(stored).not.toBeNull();
        const doc = ProvDocument.deserialize(stored!, "json");
        const provn = doc.serialize("provn");
        expect(provn).toContain("entity(inflexa:analysis-a1");
        expect(provn).toContain("agent(inflexa:agent-system");
        expect(provn).toContain("agent(inflexa:agent-user-alice_example_org");

        const exported = serializeProvenance(analysis, "provn")._unsafeUnwrap();
        expect(exported).toContain("used(inflexa:action-");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("reopening deserializes the stored doc and appends onto it", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-reopen-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        // Simulate a new process: drop in-memory state so the next event rebuilds from the column.
        resetProvenanceRecorderForTests();

        Bus.emit("inflexa", {
            type: "prov.input_added",
            analysisId: "a1",
            actor: user,
            input: { path: "later.csv", isDir: false, anchorId: "anchor1" },
            derivedFromAnalysisId: null,
        });
        await flushProvenanceAsync();

        const provn = serializeProvenance(analysis, "provn")._unsafeUnwrap();
        expect(provn).toContain("inflexa:CreateAnalysis");
        expect(provn).toContain("later.csv");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("async flush signs provenance and the signature verifies against the chain hash", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        // Use a temp dir for the signing keypair so this test doesn't touch the real config.
        const tmpDir = join(tmpdir(), `prov-int-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity).not.toBeNull();
        expect(integrity!.provenance).not.toBeNull();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();

        // First flush: prevChainHash is null, so recompute seeds from SHA-256("").
        expect(integrity!.prevChainHash).toBeNull();
        const recomputed = (await computeChainHash(null, integrity!.provenance!))._unsafeUnwrap();
        // Non-null assertions safe: the three `.not.toBeNull()` checks above guard them.
        expect(recomputed).toBe(integrity!.chainHash!);

        // Verify the Ed25519 signature.
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();
        const sigOk = (await verifyHexDigest(kp.publicKey, integrity!.signature!, integrity!.chainHash!))._unsafeUnwrap();
        expect(sigOk).toBe(true);

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("second signed flush chains from the first flush's chain hash", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-chain-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        // First flush: creation event.
        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();
        const first = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(first!.chainHash).not.toBeNull();

        // Second flush: an input-added event appends to the same document.
        Bus.emit("inflexa", {
            type: "prov.input_added",
            analysisId: "a1",
            actor: user,
            input: { path: "extra.csv", isDir: false, anchorId: "anchor1" },
            derivedFromAnalysisId: null,
        });
        await flushProvenanceAsync();
        const second = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(second!.chainHash).not.toBeNull();

        // The second chain hash must differ from the first (the PROV-JSON grew).
        expect(second!.chainHash).not.toBe(first!.chainHash);
        // The stored prevChainHash must be the first flush's chain hash.
        expect(second!.prevChainHash).toBe(first!.chainHash);

        // The second chain hash must chain from the first: H2 = SHA-256(H1 || json2).
        const recomputed = (await computeChainHash(first!.chainHash!, second!.provenance!))._unsafeUnwrap();
        expect(recomputed).toBe(second!.chainHash!);

        // The signature still verifies against the new chain hash.
        const kp = (await loadOrGenerateKeypair())._unsafeUnwrap();
        const sigOk = (await verifyHexDigest(kp.publicKey, second!.signature!, second!.chainHash!))._unsafeUnwrap();
        expect(sigOk).toBe(true);

        // verifyProvenance must report "valid" after multi-flush — this was the #CRT-1 bug:
        // the verifier needs prevChainHash to recompute the rolling hash correctly.
        const result = await verifyProvenance(second!.provenance, second!.prevChainHash, second!.chainHash, second!.signature, kp.publicKey);
        expect(result.status).toBe("valid");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe("export sidecar (writeSidecar via the full export path)", () => {
    test("signed provenance produces a .sig.json sidecar with the correct shape", async () => {
        const { mkdirSync, rmSync, existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        freshDb();
        resetProvenanceRecorderForTests();
        initProvenanceRecording();

        const tmpDir = join(tmpdir(), `prov-sidecar-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        // Write provenance file, then call the sidecar writer via the export module.
        const provDest = join(tmpDir, "provenance.json");
        const provJson = serializeProvenance(analysis, "json")._unsafeUnwrap();
        const { writeFileSync: wf } = await import("node:fs");
        wf(provDest, provJson);

        // The flush should have written integrity columns.
        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();

        // Build the sidecar via the shared builder (mirrors the export path).
        const { buildSidecar } = await import("./verify.ts");
        const sidecarResult = await buildSidecar(provJson);
        expect(sidecarResult.isOk()).toBe(true);
        const sidecar = sidecarResult._unsafeUnwrap();

        const sigDest = `${provDest}.sig.json`;
        wf(sigDest, JSON.stringify(sidecar, null, 2));

        expect(existsSync(sigDest)).toBe(true);
        const parsed = JSON.parse(readFileSync(sigDest, "utf-8"));
        // Self-describing envelope fields.
        expect(parsed.payloadType).toBe("application/json; profile=prov-json");
        expect(parsed.payloadDigestAlgorithm).toBe("SHA-256");
        expect(parsed.payloadDigestMethod).toBe("verbatim");
        expect(parsed.signatureAlgorithm).toBe("Ed25519");
        expect(parsed.publicKey).toHaveProperty("kty", "OKP");
        expect(parsed.publicKey).toHaveProperty("crv", "Ed25519");

        // The sidecar's payloadDigest is a simple SHA-256(provJson), not the chain hash.
        const contentDigest = (await computePayloadDigest(provJson))._unsafeUnwrap();
        expect(parsed.payloadDigest).toBe(contentDigest);
        expect(parsed.payloadDigest).not.toBe(integrity!.chainHash);

        // Third-party verification: recompute digest from the file, verify the signature.
        const importedPub = await crypto.subtle.importKey("jwk", parsed.publicKey, "Ed25519", true, ["verify"]);
        const result = await verifyPayload(provJson, parsed.payloadDigest, parsed.signature, importedPub);
        expect(result.status).toBe("valid");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe("verifyProvenance end-to-end (bus → flush → verify)", () => {
    test("signed provenance round-trips through verifyProvenance as valid", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        freshDb();
        resetProvenanceRecorderForTests();
        initProvenanceRecording();

        const tmpDir = join(tmpdir(), `prov-e2e-verify-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        const { loadPublicKey } = await import("./signing.ts");
        const pubKey = await loadPublicKey();
        const result = await verifyProvenance(integrity!.provenance, integrity!.prevChainHash, integrity!.chainHash, integrity!.signature, pubKey);
        expect(result.status).toBe("valid");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe("provenance recorder handles execution events (bus → flush → signed column)", () => {
    beforeEach(() => {
        freshDb();
        resetProvenanceRecorderForTests();
        resetSigningForTests(null);
        initProvenanceRecording();
    });

    test("run/step/file events flush to the analyses.provenance column with chain hash + signature", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-exec-e2e-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        Bus.emit("inflexa", { type: "prov.run_started", analysisId: "a1", actor: system, run: runRef });
        Bus.emit("inflexa", { type: "prov.step_completed", analysisId: "a1", actor: system, outcome: stepOutcome, model });
        Bus.emit("inflexa", { type: "prov.file_written", analysisId: "a1", actor: system, file: fileRef, step: stepRef, generation: "step" });
        Bus.emit("inflexa", {
            type: "prov.input_used",
            analysisId: "a1",
            actor: system,
            step: stepRef,
            input: { path: "data/inputs/raw.csv", hash: "deadbeef", source: "data", fileId: "file-7" },
        });
        Bus.emit("inflexa", { type: "prov.run_completed", analysisId: "a1", actor: system, outcome: runOutcome });
        await flushProvenanceAsync();

        const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
        expect(stored).not.toBeNull();
        const provn = ProvDocument.deserialize(stored!, "json").serialize("provn");
        expect(provn).toContain("inflexa:Run");
        expect(provn).toContain("inflexa:Step");
        expect(provn).toContain("inflexa:File");
        expect(provn).toContain("run-001");
        expect(provn).toContain("step-de");
        expect(provn).toContain("results.csv");
        // The used-input entity landed too — with its source and analysis-relative path.
        expect(provn).toContain("data/inputs/raw.csv");
        expect(provn).toMatch(/used\(inflexa:used-input-run-001-step-de-\w+;/);
        // The run activity carries both times and the terminal status (start + completion merged).
        expect(provn).toContain("inflexa:status");
        // The step's model agent landed in the signed document, delegating for the cli agent.
        expect(provn).toContain(`agent(${modelAgentQName(model)}`);
        expect(provn).toContain("claude-sonnet-4-5");
        expect(provn).toMatch(/actedOnBehalfOf\(inflexa:delegation-[\w-]+; inflexa:agent-model-\w+, inflexa:agent-system/);

        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // Capstone (task 4.1): a realistic MIXED registration through the bus — 2 command groups (one the
    // intra-step chain A→B), 1 file-tool group, their produced-file events, 1 leaf file, and the
    // step-level input_used — flushes to the signed column with the command activities and per-command
    // used/generation edges intact, and rotates the integrity columns. No live E2E: the bus→builder→
    // flush→sign pipeline was live-proven by `deepen-run-provenance`; this adds one event kind through
    // that same machinery, so recorder-level coverage is the deliberate ceiling.
    test("a mixed command registration flushes to the signed column with command activities and per-command edges", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-cmd-e2e-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        Bus.emit("inflexa", { type: "prov.run_started", analysisId: "a1", actor: system, run: runRef });
        Bus.emit("inflexa", { type: "prov.step_completed", analysisId: "a1", actor: system, outcome: stepOutcome, model });
        // Command group A + its produced file (the chain's head).
        Bus.emit("inflexa", { type: "prov.command_executed", analysisId: "a1", actor: system, step: stepRef, command: cmdRunDe, model });
        Bus.emit("inflexa", { type: "prov.file_written", analysisId: "a1", actor: system, file: deResultsFileRef, step: stepRef, generation: "command" });
        // Command group B reads A's output (source "step") and produces the heatmap (the chain's tail).
        Bus.emit("inflexa", { type: "prov.command_executed", analysisId: "a1", actor: system, step: stepRef, command: cmdPlotHeatmap, model });
        Bus.emit("inflexa", { type: "prov.file_written", analysisId: "a1", actor: system, file: heatmapFileRef, step: stepRef, generation: "command" });
        // File-tool group + its produced file.
        Bus.emit("inflexa", { type: "prov.command_executed", analysisId: "a1", actor: system, step: stepRef, command: fileToolWriteScript, model });
        Bus.emit("inflexa", { type: "prov.file_written", analysisId: "a1", actor: system, file: scriptFileRef, step: stepRef, generation: "command" });
        // A leaf file (no producer record) keeps the step-level generation.
        Bus.emit("inflexa", { type: "prov.file_written", analysisId: "a1", actor: system, file: leafFileRef, step: stepRef, generation: "step" });
        // Step-level input_used registry is untouched by the command edges (deliberate redundancy).
        Bus.emit("inflexa", {
            type: "prov.input_used",
            analysisId: "a1",
            actor: system,
            step: stepRef,
            input: { path: "data/inputs/counts.csv", hash: "hashCount1", source: "data", fileId: "file-1" },
        });
        Bus.emit("inflexa", { type: "prov.run_completed", analysisId: "a1", actor: system, outcome: runOutcome });
        await flushProvenanceAsync();

        const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
        expect(stored).not.toBeNull();
        const provn = ProvDocument.deserialize(stored!, "json").serialize("provn");

        // Both activity kinds are present, with their identifying facts.
        expect(provn).toContain("inflexa:Command");
        expect(provn).toContain("inflexa:FileToolWrite");
        expect(provn).toContain("Rscript scripts/de.R");
        expect(provn).toContain("python plot.py");
        expect(provn).toContain("write_file");

        // Per-command generation + used edges: de_results generated by A, used by B; heatmap by B; leaf by step.
        const deQn = fileQName(deResultsKey);
        const aQn = commandQName(stepRef, cmdRunDe.outputs);
        const bQn = commandQName(stepRef, cmdPlotHeatmap.outputs);
        expect(provn).toContain(`${deQn}, ${aQn}`); // wasGeneratedBy(de_results, A)
        expect(provn).toContain(`${bQn}, ${deQn}`); // used(B, de_results) — the intra-step chain
        expect(provn).toContain(`${fileQName(heatmapKey)}, ${bQn}`); // wasGeneratedBy(heatmap, B)
        expect(provn).toContain(`${fileQName(leafFileRef)}, inflexa:step-run-001-step-de`); // leaf → step
        // The produced files never take a step-level generation.
        expect(provn).not.toContain(`${deQn}, inflexa:step-run-001-step-de`);

        // The integrity columns rotated — the flush actually signed and persisted.
        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("an execution event for an unknown analysis is dropped — no document created", async () => {
        // No analysis row for "ghost": liveDocForAnalysis returns null, the event is skipped, and the
        // flush has nothing dirty. getAnalysisProvenance on a missing row is a normal null, not an error.
        Bus.emit("inflexa", { type: "prov.run_started", analysisId: "ghost", actor: system, run: { runId: "run-x", startedAtMs: 1 } });
        await flushProvenanceAsync();
        expect(getAnalysisProvenance("ghost")._unsafeUnwrap()).toBeNull();
    });

    // D4: the flush-poison retirement. A same-QName formal-time conflict (a defect upstream of the
    // builders' determinism) must NOT throw out of the flush and leave the analysis permanently
    // unpersistable — the last-write-wins policy (PROV_UNIFY_OPTIONS) degrades it to keep-last-plus-log,
    // the same merge that lets a resumed run's newer terminal outcome supersede the earlier one.
    test("a formal-time conflict at flush keeps the last value and still persists — not a throw", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-conflict-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        // Seed the stored column with a document a defect would produce: two same-QName run activities
        // whose start times DIFFER. Serialize RAW (no unify) so BOTH records survive into the bytes —
        // this is the poisoned state the keep-last policy must tolerate. Under the default "throw" the
        // next flush would throw on every retry, leaving the analysis forever dirty.
        const poisoned = freshDocument(analysis);
        poisoned.activity("inflexa:run-run-001", "2023-11-14T22:13:20.000Z", undefined, { "prov:type": "inflexa:Run" });
        poisoned.activity("inflexa:run-run-001", "2000-01-01T00:00:00.000Z", undefined, { "prov:type": "inflexa:Run" });
        updateAnalysisProvenance("a1", poisoned.serialize("json"), "seedhash", "seedsig")._unsafeUnwrap();

        // A later event loads that stored doc as the live doc and triggers a flush through the recorder.
        Bus.emit("inflexa", { type: "prov.run_completed", analysisId: "a1", actor: system, outcome: runOutcome });
        await flushProvenanceAsync();

        const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
        expect(stored).not.toBeNull();
        const json = JSON.parse(stored!) as { activity?: Record<string, { "prov:startTime"?: string }> };
        // The last-recorded start time survives the merge (parsed to epoch-ms to normalize the offset).
        expect(Date.parse(json.activity!["inflexa:run-run-001"]!["prov:startTime"]!)).toBe(Date.parse("2000-01-01T00:00:00.000Z"));
        // The flush actually persisted — the integrity chain rotated off the seed, so it did not skip.
        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.chainHash).not.toBe("seedhash");
        expect(integrity!.signature).not.toBe("seedsig");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // #5: a budget-pause that later RESUMES to completion re-emits `run_completed` with a genuinely
    // newer terminal outcome. The signed run activity must carry ONLY the latest status/duration/endTime
    // (last-write-wins via PROV_UNIFY_OPTIONS' `singleValued`), never a contradictory multi-value like
    // `["canceled","completed"]` — the failure mode before the merge policy was extended to custom attrs.
    test("a resumed run's newer terminal outcome supersedes the earlier one — single-valued, not multi", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-resume-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.run_started", analysisId: "a1", actor: system, run: runRef });
        // First terminal outcome: budget-canceled.
        Bus.emit("inflexa", {
            type: "prov.run_completed",
            analysisId: "a1",
            actor: system,
            outcome: { runId: "run-001", status: "canceled", completedAtMs: 1_700_000_002_000, durationMs: 2000 },
        });
        await flushProvenanceAsync();

        // Topup + resume re-runs the body → a newer terminal outcome for the SAME run activity.
        Bus.emit("inflexa", {
            type: "prov.run_completed",
            analysisId: "a1",
            actor: system,
            outcome: { runId: "run-001", status: "completed", completedAtMs: 1_700_000_009_000, durationMs: 9000 },
        });
        await flushProvenanceAsync();

        const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
        expect(stored).not.toBeNull();
        const provn = ProvDocument.deserialize(stored!, "json").serialize("provn");
        // The latest outcome wins and the earlier one is GONE — no multi-valued status/duration.
        expect(provn).toContain("completed");
        expect(provn).not.toContain("canceled");
        expect(provn).toContain("9000");
        expect(provn).not.toContain("2000");
        // The end time is superseded too (last-write-wins on the formal attribute).
        const json = JSON.parse(stored!) as { activity?: Record<string, { "prov:endTime"?: string }> };
        expect(Date.parse(json.activity!["inflexa:run-run-001"]!["prov:endTime"]!)).toBe(1_700_000_009_000);

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });
});
