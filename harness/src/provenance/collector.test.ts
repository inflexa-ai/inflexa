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

import { ProvenanceCollector } from "./collector.js";
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
