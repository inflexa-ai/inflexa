/**
 * `ProvenanceCollector` contract tests — the write feeds and their shared
 * last-write-wins keyspace, plus the completion gate on read classification.
 *
 * The two write feeds accept paths in different shapes (the mutate seam hands
 * `recordFileToolWrite` an analysis-root-relative path; exec frames hand
 * `recordCommandExecution` a step-relative one), so these tests pin that both
 * normalize to the same step-relative key and the bidirectional unlink fires.
 *
 * The classification tests pin the admissibility rule: an edge to a producing
 * step exists only when that step was observed `completed`, so a fabricated
 * edge to a concurrent sibling — the failure this gate exists to prevent — is
 * unrepresentable rather than merely unlikely.
 */

import { describe, expect, test } from "bun:test";

import { classifyReadPath, completedStepKey, ProvenanceCollector, type CompletedSteps } from "./collector.js";
import type { ArtifactRecord } from "../execution/artifact-record.js";

const RUN = "run-001";
const STEP = "step-de";
/** Analysis-root-relative prefix for this step's artifacts. */
const STEP_PREFIX = `runs/${RUN}/${STEP}/`;
const HASH = `sha256:${"a".repeat(64)}`;

function fileToolWrite(path: string, tool: ArtifactRecord["toolName"]): ArtifactRecord {
    return { path, hash: HASH, size: 42, toolName: tool, timestamp: "2026-07-13T00:00:00.000Z" };
}

describe("ProvenanceCollector.recordFileToolWrite", () => {
    test("an analysis-relative write path is keyed step-relative in getRecords()", () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });

        collector.recordFileToolWrite(fileToolWrite(`${STEP_PREFIX}output/x.csv`, "write_file"));

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        const rec = records[0]!;
        expect(rec.outputPath).toBe("output/x.csv");
        expect(rec.producer).toEqual({ type: "file_tool", tool: "write_file", timestamp: "2026-07-13T00:00:00.000Z" });
        expect(rec.inputs).toEqual([]);
        expect(rec.outputHash).toBe(HASH);
    });

    test("file-tool then command on the same path resolves to the command record", () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });

        collector.recordFileToolWrite(fileToolWrite(`${STEP_PREFIX}output/x.csv`, "write_file"));
        // Exec frames arrive with an already-step-relative write path.
        collector.recordCommandExecution("python3", ["scripts/x.py"], 0, 100, [{ path: "output/x.csv", hash: HASH, size: 20 }]);

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]!.producer.type).toBe("command");
    });

    test("command then file-tool resolves to the file-tool record — shared keyspace across path shapes", () => {
        const collector = new ProvenanceCollector({ stepId: STEP, runId: RUN });

        // Command write in the step-relative shape; file-tool write in the
        // analysis-relative shape. Both must normalize to `output/x.csv` or the
        // later file-tool feed cannot unlink the earlier command record.
        collector.recordCommandExecution("python3", ["scripts/x.py"], 0, 100, [{ path: "output/x.csv", hash: HASH, size: 20 }]);
        collector.recordFileToolWrite(fileToolWrite(`${STEP_PREFIX}output/x.csv`, "edit_file"));

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        const rec = records[0]!;
        expect(rec.producer).toEqual({ type: "file_tool", tool: "edit_file", timestamp: "2026-07-13T00:00:00.000Z" });
        expect(rec.inputs).toEqual([]);
        expect(rec.outputPath).toBe("output/x.csv");
    });
});

// ── Classification ──────────────────────────────────────────────────

/** The reading step's own coordinates for every classification test. */
const OWN_RUN = "run-002";
const OWN_STEP = "de";
/** A run of the same analysis that is not the reading step's run. */
const OTHER_RUN = "run-001";
const DEPENDS_ON = ["qc"];

/** Build a completed-step snapshot from `(runId, stepId)` pairs. */
function completed(...pairs: [string, string][]): CompletedSteps {
    return new Set(pairs.map(([runId, stepId]) => completedStepKey(runId, stepId)));
}

describe("classifyReadPath — branches that never consult completion", () => {
    test("a data read is admissible with no snapshot at all", () => {
        expect(classifyReadPath("data/inputs/f1/counts.csv", OWN_STEP, OWN_RUN, DEPENDS_ON)).toEqual({
            admissible: true,
            context: { source: "data" },
        });
        expect(classifyReadPath("dataprofile/summary.json", OWN_STEP, OWN_RUN, DEPENDS_ON)).toEqual({
            admissible: true,
            context: { source: "data" },
        });
    });

    test("a read of the step's own artifacts is admissible with no snapshot at all", () => {
        // The step is writing this directory itself; its own completion is not
        // a question it can be asked about.
        expect(classifyReadPath(`runs/${OWN_RUN}/${OWN_STEP}/output/results.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON)).toEqual({
            admissible: true,
            context: { source: "artifacts", stepId: OWN_STEP, runId: OWN_RUN },
        });
        expect(classifyReadPath(`runs/${OWN_RUN}/${OWN_STEP}/output/results.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed())).toEqual({
            admissible: true,
            context: { source: "artifacts", stepId: OWN_STEP, runId: OWN_RUN },
        });
    });

    test("a path under neither data/ nor runs/ falls through to data", () => {
        expect(classifyReadPath("reports/rep-1/index.html", OWN_STEP, OWN_RUN, DEPENDS_ON, completed())).toEqual({
            admissible: true,
            context: { source: "data" },
        });
    });
});

describe("classifyReadPath — same-run siblings gate on completion", () => {
    test("a completed dependsOn sibling is upstream", () => {
        const result = classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "qc"]));

        expect(result).toEqual({ admissible: true, context: { source: "upstream", stepId: "qc", runId: OWN_RUN } });
    });

    test("a dependsOn sibling that has not completed is inadmissible — declaration does not exempt it", () => {
        const result = classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed());

        expect(result).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "qc" });
    });

    test("a completed sibling outside dependsOn is upstream — completion, not declaration, admits the edge", () => {
        const result = classifyReadPath(`runs/${OWN_RUN}/norm/output/norm.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "qc"], [OWN_RUN, "norm"]));

        expect(result).toEqual({ admissible: true, context: { source: "upstream", stepId: "norm", runId: OWN_RUN } });
    });

    test("an undeclared sibling that has not completed is inadmissible and names its step", () => {
        const result = classifyReadPath(`runs/${OWN_RUN}/norm/output/norm.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "qc"]));

        expect(result).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "norm" });
    });

    test("a sibling observed running is inadmissible — two parallel steps have no lineage relationship", () => {
        // `running` is absent from the snapshot, which is the whole of what
        // classification sees about it.
        const result = classifyReadPath(`runs/${OWN_RUN}/T5S1/output/_ct_for_r_BRAF.csv`, "T4S1", OWN_RUN, [], completed([OWN_RUN, "T2S2"]));

        expect(result).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "T5S1" });
    });

    test("a sibling observed failed is inadmissible — its outputs were never finalized", () => {
        const result = classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "norm"]));

        expect(result).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "qc" });
    });

    test("a sibling that completes after the snapshot stays inadmissible for that snapshot", () => {
        // Submit-time is deliberately stricter than read-time: the later
        // snapshot admits the edge, the submit-time one it was classified
        // against does not.
        const atSubmit = classifyReadPath(`runs/${OWN_RUN}/norm/output/norm.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed());
        const laterSnapshot = classifyReadPath(`runs/${OWN_RUN}/norm/output/norm.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "norm"]));

        expect(atSubmit).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "norm" });
        expect(laterSnapshot.admissible).toBe(true);
    });
});

describe("classifyReadPath — other runs gate on the same predicate", () => {
    test("a completed step of another run is prior", () => {
        const result = classifyReadPath(`runs/${OTHER_RUN}/de/output/prior.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OTHER_RUN, "de"]));

        expect(result).toEqual({ admissible: true, context: { source: "prior", stepId: "de", runId: OTHER_RUN } });
    });

    test("a failed step of a finished run is inadmissible — the run's outcome is not the step's", () => {
        const result = classifyReadPath(`runs/${OTHER_RUN}/qc/output/partial.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OTHER_RUN, "de"]));

        expect(result).toEqual({ admissible: false, refRunId: OTHER_RUN, refStepId: "qc" });
    });

    test("a running step of a concurrent run over the same workspace is inadmissible", () => {
        const result = classifyReadPath("runs/run-003/norm/output/norm.csv", OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "qc"]));

        expect(result).toEqual({ admissible: false, refRunId: "run-003", refStepId: "norm" });
    });

    test("the pair scraped from the path is the key tested — a same-run namesake does not admit it", () => {
        const result = classifyReadPath(`runs/${OTHER_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON, completed([OWN_RUN, "qc"]));

        expect(result).toEqual({ admissible: false, refRunId: OTHER_RUN, refStepId: "qc" });
    });
});

describe("classifyReadPath — an unavailable snapshot fails closed", () => {
    test("every producing-step read is inadmissible when no snapshot is supplied", () => {
        const declared = classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON);
        const sibling = classifyReadPath(`runs/${OWN_RUN}/norm/output/norm.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON);
        const prior = classifyReadPath(`runs/${OTHER_RUN}/de/output/prior.csv`, OWN_STEP, OWN_RUN, DEPENDS_ON);

        expect(declared).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "qc" });
        expect(sibling).toEqual({ admissible: false, refRunId: OWN_RUN, refStepId: "norm" });
        expect(prior).toEqual({ admissible: false, refRunId: OTHER_RUN, refStepId: "de" });
    });

    test("data and own-artifact reads survive an unavailable snapshot", () => {
        expect(classifyReadPath("data/inputs/f1/counts.csv", OWN_STEP, OWN_RUN, DEPENDS_ON).admissible).toBe(true);
        expect(classifyReadPath(`runs/${OWN_RUN}/${OWN_STEP}/logs/run.log`, OWN_STEP, OWN_RUN, DEPENDS_ON).admissible).toBe(true);
    });
});

describe("ProvenanceCollector.trackInputAccess", () => {
    const MOUNT = "/an-1";

    test("a caller-supplied context is used verbatim, with no path parsing", () => {
        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: OWN_RUN, dependsOn: DEPENDS_ON });

        // The path names a sibling; the context says data. The context wins,
        // which is what "no path parsing occurs" means observationally.
        const ref = collector.trackInputAccess(MOUNT, `runs/${OWN_RUN}/qc/output/qc.csv`, null, { source: "upstream", stepId: "qc", runId: OWN_RUN });

        expect(ref).toMatchObject({ path: `${MOUNT}/runs/${OWN_RUN}/qc/output/qc.csv`, source: "upstream", stepId: "qc", runId: OWN_RUN });
        expect(collector.getTrackedInputs()).toHaveLength(1);
    });

    test("no context over a data path falls back to path classification", () => {
        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: OWN_RUN, dependsOn: DEPENDS_ON });

        const ref = collector.trackInputAccess(MOUNT, "data/inputs/f1/counts.csv", null);

        expect(ref).toMatchObject({ source: "data", path: `${MOUNT}/data/inputs/f1/counts.csv` });
        expect(collector.getDataInputs()).toHaveLength(1);
    });

    test("no context over a same-run sibling fails closed and tracks nothing", () => {
        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: OWN_RUN, dependsOn: DEPENDS_ON });

        const sibling = collector.trackInputAccess(MOUNT, `runs/${OWN_RUN}/norm/output/norm.csv`, null);
        const declared = collector.trackInputAccess(MOUNT, `runs/${OWN_RUN}/qc/output/qc.csv`, null);

        expect(sibling).toBeNull();
        expect(declared).toBeNull();
        expect(collector.getTrackedInputs()).toEqual([]);
    });

    test("no context over another run's step fails closed, however long ago that run finished", () => {
        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: OWN_RUN, dependsOn: DEPENDS_ON });

        const ref = collector.trackInputAccess(MOUNT, `runs/${OTHER_RUN}/de/output/prior.csv`, null);

        expect(ref).toBeNull();
        expect(collector.getTrackedInputs()).toEqual([]);
    });

    test("re-reading the same mount path returns the already-tracked ref", () => {
        const collector = new ProvenanceCollector({ stepId: OWN_STEP, runId: OWN_RUN, dependsOn: DEPENDS_ON });
        const context = { source: "upstream", stepId: "qc", runId: OWN_RUN } as const;

        const first = collector.trackInputAccess(MOUNT, `runs/${OWN_RUN}/qc/output/qc.csv`, null, context);
        const second = collector.trackInputAccess(MOUNT, `runs/${OWN_RUN}/qc/output/qc.csv`, null);

        expect(second).toBe(first);
        expect(collector.getTrackedInputs()).toHaveLength(1);
    });
});
