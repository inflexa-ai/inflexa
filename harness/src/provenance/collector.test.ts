/**
 * `ProvenanceCollector.recordFileToolWrite` contract tests — the file-tool
 * feed and its shared last-write-wins keyspace with the command feed.
 *
 * The two feeds accept paths in different shapes (the mutate seam hands
 * `recordFileToolWrite` an analysis-root-relative path; exec frames hand
 * `recordCommandExecution` a step-relative one), so these tests pin that both
 * normalize to the same step-relative key and the bidirectional unlink fires.
 */

import { describe, expect, test } from "bun:test";

import { classifyReadPath, ProvenanceCollector } from "./collector.js";
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

describe("classifyReadPath", () => {
    const OWN_STEP = "de";
    const OWN_RUN = "run-002";
    const DEPS = ["qc"];

    /** Narrow to the admissible arm so a branch regression fails loudly here
     *  rather than as an undefined-property read further down the assertion. */
    function contextOf(result: ReturnType<typeof classifyReadPath>) {
        if (!result.admissible) throw new Error("expected an admissible classification");
        return result.context;
    }

    test("data and dataprofile reads classify as data with no step or run", () => {
        expect(contextOf(classifyReadPath("data/inputs/Lab/counts.csv", OWN_STEP, OWN_RUN, DEPS))).toEqual({ source: "data" });
        expect(contextOf(classifyReadPath("dataprofile/summary.json", OWN_STEP, OWN_RUN, DEPS))).toEqual({ source: "data" });
    });

    test("the step's own tree classifies as artifacts", () => {
        expect(contextOf(classifyReadPath(`runs/${OWN_RUN}/${OWN_STEP}/output/results.csv`, OWN_STEP, OWN_RUN, DEPS))).toEqual({
            source: "artifacts",
            stepId: OWN_STEP,
            runId: OWN_RUN,
        });
    });

    test("a declared dependency classifies as upstream", () => {
        expect(contextOf(classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, DEPS))).toEqual({
            source: "upstream",
            stepId: "qc",
            runId: OWN_RUN,
        });
    });

    test("a declared dependency wins over the sibling branch that also matches its prefix", () => {
        // Both the declared-dependency branch and the same-run sibling branch
        // match `runs/{ownRunId}/qc/...`. Ordering is what makes the declared one
        // admissible; if the sibling branch ever ran first every legitimate
        // same-run edge would silently become a refusal.
        const result = classifyReadPath(`runs/${OWN_RUN}/qc/logs/run.log`, OWN_STEP, OWN_RUN, DEPS);
        expect(result.admissible).toBe(true);
        expect(contextOf(result).source).toBe("upstream");
    });

    test("an undeclared same-run sibling is refused and names the producing step", () => {
        const result = classifyReadPath(`runs/${OWN_RUN}/norm/output/norm.csv`, OWN_STEP, OWN_RUN, DEPS);
        expect(result.admissible).toBe(false);
        if (result.admissible) throw new Error("unreachable");
        expect(result.refStepId).toBe("norm");
        expect(result.refRunId).toBe(OWN_RUN);
    });

    test("absent or empty dependsOn refuses every same-run sibling", () => {
        expect(classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN).admissible).toBe(false);
        expect(classifyReadPath(`runs/${OWN_RUN}/qc/output/qc.csv`, OWN_STEP, OWN_RUN, []).admissible).toBe(false);
    });

    test("a bare step directory reaches the same verdict as a file beneath it", () => {
        // `opendir` reports the directory without a trailing separator, so these
        // are ordinary reads. Deciding them off the segment rather than a
        // `runs/{runId}/{id}/` prefix is what keeps a step from refusing an edge
        // to itself, or to a dependency it did declare, on every `ls`.
        expect(contextOf(classifyReadPath(`runs/${OWN_RUN}/${OWN_STEP}`, OWN_STEP, OWN_RUN, DEPS)).source).toBe("artifacts");
        expect(contextOf(classifyReadPath(`runs/${OWN_RUN}/qc`, OWN_STEP, OWN_RUN, DEPS)).source).toBe("upstream");
        expect(classifyReadPath(`runs/${OWN_RUN}/norm`, OWN_STEP, OWN_RUN, DEPS).admissible).toBe(false);
    });

    test("a step id that only prefixes another's does not borrow its verdict", () => {
        // Segment equality, not `startsWith`: `qc2` shares a prefix with the
        // declared `qc`, and a prefix match would admit an undeclared sibling.
        const result = classifyReadPath(`runs/${OWN_RUN}/qc2/output/x.csv`, OWN_STEP, OWN_RUN, DEPS);
        expect(result.admissible).toBe(false);
        if (result.admissible) throw new Error("unreachable");
        expect(result.refStepId).toBe("qc2");
    });

    test("another run's step classifies as prior via path extraction", () => {
        expect(contextOf(classifyReadPath("runs/run-001/de/output/prior.csv", OWN_STEP, OWN_RUN, DEPS))).toEqual({
            source: "prior",
            stepId: "de",
            runId: "run-001",
        });
    });

    test("an unrecognized path falls back to data", () => {
        expect(contextOf(classifyReadPath("reports/r1/index.html", OWN_STEP, OWN_RUN, DEPS))).toEqual({ source: "data" });
    });
});

describe("ProvenanceCollector.trackInputAccess without an explicit context", () => {
    test("tracks an admissible path", () => {
        const collector = new ProvenanceCollector({ stepId: "de", runId: "run-002", dependsOn: ["qc"] });

        const ref = collector.trackInputAccess("/a1", "runs/run-002/qc/output/qc.csv", null);

        if (ref === null) throw new Error("expected a declared dependency to be tracked");
        expect(collector.getTrackedInputs()).toHaveLength(1);
        expect(ref.source).toBe("upstream");
    });

    test("tracks nothing when the path classifies as inadmissible", () => {
        const collector = new ProvenanceCollector({ stepId: "de", runId: "run-002", dependsOn: ["qc"] });

        const ref = collector.trackInputAccess("/a1", "runs/run-002/norm/output/norm.csv", null);

        expect(ref).toBeNull();
        expect(collector.getTrackedInputs()).toEqual([]);
    });
});

describe("ProvenanceCollector.claimRefusalNarration", () => {
    test("a path is claimable once, and each path is claimed independently", () => {
        const collector = new ProvenanceCollector({ stepId: "de", runId: "run-002" });

        expect(collector.claimRefusalNarration("runs/run-002/norm/output/a.csv")).toBe(true);
        expect(collector.claimRefusalNarration("runs/run-002/norm/output/a.csv")).toBe(false);
        expect(collector.claimRefusalNarration("runs/run-002/norm/output/b.csv")).toBe(true);
    });
});
