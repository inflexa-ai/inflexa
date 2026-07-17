/**
 * `feedExecFrame` contract tests — no live sandbox. A synthetic
 * `ExecResult.provenance` frame is fed into a real `ProvenanceCollector`
 * and the resulting records/data-inputs are asserted.
 */

import { describe, expect, test } from "bun:test";

import { ProvenanceCollector } from "./collector.js";
import { feedExecFrame } from "./exec-frame.js";
import type { ProvenanceFrame } from "../sandbox/types.js";

const MOUNT = "/a1";

describe("feedExecFrame", () => {
    test("data read + output write yields a command record with a data input + script", () => {
        const collector = new ProvenanceCollector({ stepId: "tmm", runId: "run-001" });
        collector.setInputFileIdMap(new Map([["data/inputs/Lab/counts.csv", "uuid-1"]]));

        const provenance: ProvenanceFrame = {
            disabled: false,
            reads: [{ path: "/a1/data/inputs/Lab/counts.csv", layers: ["python"] }],
            writes: [{ path: "/a1/runs/run-001/tmm/output/tmm.csv", layers: ["inotify"] }],
            deletes: [],
        };

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/tmm.py"],
            exitCode: 0,
            durationMs: 1200,
            provenance,
        });

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        const rec = records[0]!;
        expect(rec.outputPath).toBe("output/tmm.csv");
        expect(rec.producer.type).toBe("command");
        expect(rec.scriptPath).toBe("scripts/tmm.py");
        expect(rec.inputs).toHaveLength(1);
        expect(rec.inputs[0]!.source).toBe("data");
        expect(rec.inputs[0]!.path).toBe("/a1/data/inputs/Lab/counts.csv");

        const dataInputs = collector.getDataInputs();
        expect(dataInputs).toHaveLength(1);
        expect(dataInputs[0]!.fileId).toBe("uuid-1");
    });

    test("upstream read is classified by step metadata", () => {
        const collector = new ProvenanceCollector({
            stepId: "de",
            runId: "run-002",
            dependsOn: ["qc"],
        });

        feedExecFrame({
            collector,
            mountRoot: "/a1",
            command: ["Rscript", "scripts/de.R"],
            exitCode: 0,
            durationMs: 50,
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/runs/run-002/qc/output/qc.csv", layers: ["inotify"] }],
                writes: [{ path: "/a1/runs/run-002/de/output/de.csv", layers: ["inotify"] }],
                deletes: [],
            },
        });

        const rec = collector.getRecords()[0]!;
        expect(rec.inputs[0]!.source).toBe("upstream");
        expect(rec.inputs[0]!.stepId).toBe("qc");
        expect(rec.inputs[0]!.runId).toBe("run-002");
    });

    test("a read outside the mount keeps its own name on the ref", () => {
        // A path no hook should have let through. Prepending the mount root
        // would forge the in-tree name `/a1/etc/passwd` and reconcile would
        // fail the step over a missing file; verbatim, reconcile recognizes
        // it as out-of-tree and drops it.
        const collector = new ProvenanceCollector({ stepId: "s", runId: "r" });
        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/x.py"],
            exitCode: 0,
            durationMs: 5,
            provenance: {
                disabled: false,
                reads: [{ path: "/etc/passwd", layers: ["preload"] }],
                writes: [],
                deletes: [],
            },
        });
        const refs = collector.getTrackedInputs();
        expect(refs).toHaveLength(1);
        expect(refs[0]!.path).toBe("/etc/passwd");
    });

    test("separators doubled at the mount boundary collapse to the canonical name", () => {
        // POSIX-wise `/a1//data/x.csv` names `/a1/data/x.csv`; the ref must land
        // on the canonical form so it maps into the host tree and dedups.
        const collector = new ProvenanceCollector({ stepId: "s", runId: "r" });
        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/x.py"],
            exitCode: 0,
            durationMs: 5,
            provenance: {
                disabled: false,
                reads: [{ path: "/a1//data/inputs/Lab/counts.csv", layers: ["python"] }],
                writes: [],
                deletes: [],
            },
        });
        const refs = collector.getTrackedInputs();
        expect(refs).toHaveLength(1);
        expect(refs[0]!.path).toBe("/a1/data/inputs/Lab/counts.csv");
        expect(refs[0]!.source).toBe("data");
    });

    test("missing frame degrades to no inputs without throwing", () => {
        const collector = new ProvenanceCollector({ stepId: "s", runId: "r" });
        expect(() =>
            feedExecFrame({
                collector,
                mountRoot: "/a1",
                command: ["python3", "-c", "print(1)"],
                exitCode: 0,
                durationMs: 5,
            }),
        ).not.toThrow();
        // No writes in the frame → no output records, and no inputs tracked.
        expect(collector.getRecords()).toHaveLength(0);
        expect(collector.getDataInputs()).toHaveLength(0);
    });

    test("disabled frame degrades to no inputs", () => {
        const collector = new ProvenanceCollector({ stepId: "s", runId: "r" });
        feedExecFrame({
            collector,
            mountRoot: "/a1",
            command: ["python3", "scripts/x.py"],
            exitCode: 1,
            durationMs: 10,
            provenance: { disabled: true, reads: [{ path: "/a1/data/x.csv", layers: [] }], writes: [], deletes: [] },
        });
        expect(collector.getDataInputs()).toHaveLength(0);
    });
});
