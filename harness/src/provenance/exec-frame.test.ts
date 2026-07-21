/**
 * `feedExecFrame` contract tests — no live sandbox. A synthetic
 * `ExecResult.provenance` frame is fed into a real `ProvenanceCollector`
 * and the resulting records/data-inputs are asserted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Attributes, metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { __resetLineageMetricsForTest } from "../lib/metrics.js";
import { completedStepKey, ProvenanceCollector } from "./collector.js";
import { feedExecFrame } from "./exec-frame.js";
import type { ProvenanceFrame } from "../sandbox/types.js";

const MOUNT = "/a1";
const EDGE_REJECTED_METRIC = "cortex.lineage.edge_rejected";

/** Analysis-scoped completed-step snapshot from `(runId, stepId)` pairs. */
function completed(...pairs: readonly (readonly [string, string])[]): ReadonlySet<string> {
    return new Set(pairs.map(([runId, stepId]) => completedStepKey(runId, stepId)));
}

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    // Long interval — every export in this suite is a manual forceFlush.
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    // Instruments memoized against an earlier provider would keep reporting there.
    __resetLineageMetricsForTest();
});

afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetLineageMetricsForTest();
});

/**
 * The exported measurements of the rejection counter, one entry per distinct tag
 * set. Reading them from a provider registered after `lib/metrics.ts` was imported
 * is what asserts the dimensions *and* that the instrument binds late enough to
 * reach an exporter at all — the metrics API resolves the provider when an
 * instrument is created and never upgrades it afterwards.
 */
async function rejections(): Promise<{ value: number; attributes: Attributes }[]> {
    await provider.forceFlush();
    return exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics)
        .filter((m) => m.descriptor.name === EDGE_REJECTED_METRIC)
        .flatMap((m) => m.dataPoints.map((dp) => ({ value: dp.value as number, attributes: dp.attributes })));
}

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

    test("upstream read is classified by step metadata", async () => {
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
            completedSteps: completed(["run-002", "qc"]),
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
        expect(await rejections()).toEqual([]);
    });

    test("a prior run's completed step reaches the collector", async () => {
        const collector = new ProvenanceCollector({ stepId: "de", runId: "run-002" });

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["Rscript", "scripts/de.R"],
            exitCode: 0,
            durationMs: 50,
            completedSteps: completed(["run-001", "qc"]),
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/runs/run-001/qc/output/qc.csv", layers: ["inotify"] }],
                writes: [{ path: "/a1/runs/run-002/de/output/de.csv", layers: ["inotify"] }],
                deletes: [],
            },
        });

        const rec = collector.getRecords()[0]!;
        expect(rec.inputs[0]!.source).toBe("prior");
        expect(rec.inputs[0]!.stepId).toBe("qc");
        expect(rec.inputs[0]!.runId).toBe("run-001");
        expect(await rejections()).toEqual([]);
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

/**
 * The field failure this gate exists for: `T4S1` and `T2S2` ran concurrently
 * over one workspace, `T4S1`'s capture layers saw `T2S2`'s directory churn, and
 * three of `T2S2`'s working files were registered as `T4S1` inputs — then failed
 * attestation once `T2S2` deleted them.
 */
const SIBLING_FRAME: ProvenanceFrame = {
    disabled: false,
    reads: [
        { path: "/a1/runs/run-002/T2S2/logs/run_gsea.log", layers: ["inotify"] },
        { path: "/a1/runs/run-002/T2S2/output/wikipathways_symbols.gmt", layers: ["inotify"] },
    ],
    writes: [{ path: "/a1/runs/run-002/T4S1/output/gsea.csv", layers: ["inotify"] }],
    deletes: [],
};

function readingStep(): ProvenanceCollector {
    return new ProvenanceCollector({ stepId: "T4S1", runId: "run-002" });
}

describe("feedExecFrame — edges refused before the collector", () => {
    test("a sibling not observed completed leaves no ref in the collector", () => {
        const collector = readingStep();

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/run_gsea.py"],
            exitCode: 0,
            durationMs: 900,
            // `T2S2` was still running when this exec was submitted, so the
            // snapshot holds no pair for it.
            completedSteps: completed(),
            provenance: SIBLING_FRAME,
        });

        // Nothing reached the collector, so nothing can become an attestation
        // target — the refusal is structural, not a later filtering pass.
        expect(collector.getTrackedInputs()).toEqual([]);
        const rec = collector.getRecords()[0]!;
        expect(rec.outputPath).toBe("output/gsea.csv");
        expect(rec.inputs).toEqual([]);
    });

    test("each refusal names the ref path and the producing step it names", () => {
        const logger = createCapturingLogger();

        feedExecFrame({
            collector: readingStep(),
            mountRoot: MOUNT,
            command: ["python3", "scripts/run_gsea.py"],
            exitCode: 0,
            durationMs: 900,
            completedSteps: completed(),
            provenance: SIBLING_FRAME,
            logger,
        });

        const warns = logger.records.filter((r) => r.level === "warn");
        expect(warns).toHaveLength(2);
        expect(warns[0]!.msg).toBe("[exec-frame] refusing lineage edge to a step not observed completed");
        // Identifiers ride as fields, never interpolated into the message.
        expect(warns[0]!.fields).toEqual({
            path: "runs/run-002/T2S2/logs/run_gsea.log",
            refRunId: "run-002",
            refStepId: "T2S2",
            reason: "producing-step-not-completed",
        });
        expect(warns[1]!.fields).toMatchObject({
            path: "runs/run-002/T2S2/output/wikipathways_symbols.gmt",
            refStepId: "T2S2",
        });
    });

    test("a refusal against an obtained snapshot counts as producing-step-not-completed", async () => {
        feedExecFrame({
            collector: readingStep(),
            mountRoot: MOUNT,
            command: ["python3", "scripts/run_gsea.py"],
            exitCode: 0,
            durationMs: 900,
            completedSteps: completed(),
            provenance: SIBLING_FRAME,
            agentId: "gsea-agent",
        });

        // Both reads carry the same tags, so the counter aggregates them onto one
        // series — the two rejections are the value, not two points.
        expect(await rejections()).toEqual([{ value: 2, attributes: { agent_id: "gsea-agent", step_id: "T4S1", reason: "producing-step-not-completed" } }]);
    });

    test("a prior run's step that is absent from the snapshot counts under the same reason", async () => {
        feedExecFrame({
            collector: new ProvenanceCollector({ stepId: "de", runId: "run-002" }),
            mountRoot: MOUNT,
            command: ["Rscript", "scripts/de.R"],
            exitCode: 0,
            durationMs: 40,
            // `run-001`'s `qc` failed, so its outputs were never finalized —
            // one rule, so one reason, whichever run the producer belongs to.
            completedSteps: completed(["run-002", "qc"]),
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/runs/run-001/qc/output/partial.csv", layers: ["inotify"] }],
                writes: [],
                deletes: [],
            },
            agentId: "de-agent",
        });

        expect(await rejections()).toEqual([{ value: 1, attributes: { agent_id: "de-agent", step_id: "de", reason: "producing-step-not-completed" } }]);
    });

    test("a missing snapshot counts under its own reason and refuses a declared dependency too", async () => {
        const collector = new ProvenanceCollector({ stepId: "de", runId: "run-002", dependsOn: ["qc"] });
        const logger = createCapturingLogger();

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["Rscript", "scripts/de.R"],
            exitCode: 0,
            durationMs: 40,
            // `completedSteps` omitted: the observation failed, which is not an
            // empty observation and never reads as "everything completed".
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/runs/run-002/qc/output/qc.csv", layers: ["inotify"] }],
                writes: [],
                deletes: [],
            },
            logger,
            agentId: "de-agent",
        });

        expect(collector.getTrackedInputs()).toEqual([]);
        expect(await rejections()).toEqual([{ value: 1, attributes: { agent_id: "de-agent", step_id: "de", reason: "snapshot-unavailable" } }]);
        expect(logger.records.filter((r) => r.level === "warn")[0]!.fields).toMatchObject({ reason: "snapshot-unavailable" });
    });

    test("data reads are untouched by the gate", async () => {
        const collector = readingStep();

        feedExecFrame({
            collector,
            mountRoot: MOUNT,
            command: ["python3", "scripts/run_gsea.py"],
            exitCode: 0,
            durationMs: 10,
            provenance: {
                disabled: false,
                reads: [{ path: "/a1/data/inputs/Lab/counts.csv", layers: ["python"] }],
                writes: [],
                deletes: [],
            },
        });

        expect(collector.getDataInputs()).toHaveLength(1);
        expect(await rejections()).toEqual([]);
    });

    test("an all-refused frame still records its command and does not throw", () => {
        const collector = readingStep();

        expect(() =>
            feedExecFrame({
                collector,
                mountRoot: MOUNT,
                command: ["python3", "scripts/run_gsea.py"],
                exitCode: 0,
                durationMs: 900,
                completedSteps: completed(),
                provenance: SIBLING_FRAME,
            }),
        ).not.toThrow();

        const rec = collector.getRecords()[0]!;
        expect(rec.producer.type).toBe("command");
        expect(rec.scriptPath).toBe("scripts/run_gsea.py");
        expect(rec.inputs).toEqual([]);
    });
});
