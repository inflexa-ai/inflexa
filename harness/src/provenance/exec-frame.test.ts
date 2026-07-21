/**
 * `feedExecFrame` contract tests — no live sandbox. A synthetic
 * `ExecResult.provenance` frame is fed into a real `ProvenanceCollector`
 * and the resulting records/data-inputs are asserted.
 */

import { describe, expect, test } from "bun:test";

import { ProvenanceCollector } from "./collector.js";
import { feedExecFrame } from "./exec-frame.js";
import type { Logger, LogFields } from "../lib/logger.js";
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

/** Captures the refusal records so the drop can be asserted as observable. */
function recordingLogger(): { logger: Logger; warnings: Array<{ msg: string; fields?: LogFields }> } {
    const warnings: Array<{ msg: string; fields?: LogFields }> = [];
    const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg, fields) => {
            warnings.push({ msg, ...(fields ? { fields } : {}) });
        },
        error: () => {},
        with: () => logger,
        named: () => logger,
        errorFields: () => ({}),
    };
    return { logger, warnings };
}

describe("feedExecFrame — undeclared same-run siblings", () => {
    test("a sibling read is refused, tracked nowhere, and logged with the step it names", () => {
        const collector = new ProvenanceCollector({ stepId: "T2S2", runId: "run-9", dependsOn: [] });
        const { logger, warnings } = recordingLogger();

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/gsea.py"],
            exitCode: 0,
            durationMs: 10,
            logger,
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/runs/run-9/T5S1/output/_ct_for_r_BRAF.csv", layers: ["inotify"] }],
                writes: [{ path: "/a1/runs/run-9/T2S2/output/gsea.csv", layers: ["inotify"] }],
                deletes: [],
            },
        });

        expect(collector.getTrackedInputs()).toEqual([]);
        expect(collector.getRecords()[0]!.inputs).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.fields).toMatchObject({ refStepId: "T5S1", refRunId: "run-9" });
    });

    test("a path refused across several execs is narrated once for the step", () => {
        // Reads dedup within a frame but not across them, and a step issues many
        // execs. Without a step-level claim, a script re-reading one scratch file
        // in a loop drowns every other refusal in repeats of itself.
        const collector = new ProvenanceCollector({ stepId: "T2S2", runId: "run-9", dependsOn: [] });
        const { logger, warnings } = recordingLogger();
        const feedOnce = (path: string) =>
            feedExecFrame({
                collector,
                mountRoot: MOUNT,
                command: ["python3", "scripts/gsea.py"],
                exitCode: 0,
                durationMs: 10,
                logger,
                provenance: { disabled: false, reads: [{ path, layers: ["inotify"] }], writes: [], deletes: [] },
            });

        feedOnce("/a1/runs/run-9/T5S1/output/scratch.csv");
        feedOnce("/a1/runs/run-9/T5S1/output/scratch.csv");
        feedOnce("/a1/runs/run-9/T5S1/output/other.csv");

        expect(warnings.map((w) => w.fields?.["path"])).toEqual(["runs/run-9/T5S1/output/scratch.csv", "runs/run-9/T5S1/output/other.csv"]);
    });

    test("a frame whose every read is refused still records its command", () => {
        const collector = new ProvenanceCollector({ stepId: "T2S2", runId: "run-9", dependsOn: [] });

        expect(() =>
            feedExecFrame({
                collector,
                mountRoot: MOUNT,
                command: ["python3", "scripts/gsea.py"],
                exitCode: 0,
                durationMs: 10,
                provenance: {
                    disabled: false,
                    reads: [
                        { path: "/a1/runs/run-9/T5S1/output/a.csv", layers: ["inotify"] },
                        { path: "/a1/runs/run-9/T4S1/output/b.csv", layers: ["inotify"] },
                    ],
                    writes: [{ path: "/a1/runs/run-9/T2S2/output/gsea.csv", layers: ["inotify"] }],
                    deletes: [],
                },
            }),
        ).not.toThrow();

        const rec = collector.getRecords()[0]!;
        expect(rec.outputPath).toBe("output/gsea.csv");
        expect(rec.producer.type).toBe("command");
        expect(rec.inputs).toEqual([]);
    });

    test("a deleted sibling scratch file leaves nothing for reconcile to attest", () => {
        // The reported failure shape: the reading step never declared the writer,
        // so no ref exists to be hashed when that file later vanishes. Reconcile
        // fails a step only over a *tracked* input, so an empty tracked set is
        // exactly what keeps the step alive.
        const collector = new ProvenanceCollector({ stepId: "T2S2", runId: "run-9", dependsOn: ["T1S1"] });

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/gsea.py"],
            exitCode: 0,
            durationMs: 10,
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/runs/run-9/T5S1/output/_ct_for_r_BRAF.csv", layers: ["inotify"] }],
                writes: [],
                deletes: [],
            },
        });

        expect(collector.getTrackedInputs()).toEqual([]);
    });

    test("a sibling-directory write does not normalize onto this step's keyspace", () => {
        // Phantom writes are inert only because a sibling path fails the
        // step-prefix strip and so cannot collide with a real artifact key. If
        // normalization ever stripped any `runs/*/*/` prefix, a neighbour's write
        // would shadow this step's own output record.
        const collector = new ProvenanceCollector({ stepId: "T2S2", runId: "run-9", dependsOn: [] });

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/gsea.py"],
            exitCode: 0,
            durationMs: 10,
            provenance: {
                disabled: false,
                reads: [],
                writes: [{ path: "/a1/runs/run-9/T5S1/output/gsea.csv", layers: ["inotify"] }],
                deletes: [],
            },
        });

        const paths = collector.getRecords().map((r) => r.outputPath);
        expect(paths).toEqual(["runs/run-9/T5S1/output/gsea.csv"]);
        expect(paths).not.toContain("output/gsea.csv");
    });

    test("a declared dependency's edge is unaffected", () => {
        const collector = new ProvenanceCollector({ stepId: "de", runId: "run-9", dependsOn: ["qc"] });

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["Rscript", "scripts/de.R"],
            exitCode: 0,
            durationMs: 10,
            provenance: {
                disabled: false,
                reads: [
                    { path: "/a1/runs/run-9/qc/output/qc.csv", layers: ["r"] },
                    { path: "/a1/runs/run-9/norm/output/norm.csv", layers: ["inotify"] },
                ],
                writes: [{ path: "/a1/runs/run-9/de/output/de.csv", layers: ["inotify"] }],
                deletes: [],
            },
        });

        const inputs = collector.getRecords()[0]!.inputs;
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.source).toBe("upstream");
        expect(inputs[0]!.stepId).toBe("qc");
        expect(inputs[0]!.path).toBe("/a1/runs/run-9/qc/output/qc.csv");
    });
});
