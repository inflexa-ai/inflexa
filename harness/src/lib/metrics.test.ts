/**
 * The metrics API has no late-binding proxy: a meter taken before
 * `setGlobalMeterProvider` is the no-op meter for good. The record sites of
 * this module are imported at process start, long before the host's boot
 * registers the provider, so the instruments must bind at record time.
 */

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { captureMetrics } from "../__tests__/setup/metrics.js";
// Imported before any provider exists — the order the production barrel has.
import {
    __resetMetricsForTest,
    elapsedSinceIso,
    recordArtifactReconcileDropped,
    recordLineageInputDropped,
    recordRunCompleted,
    recordSandboxExec,
    recordStepCompleted,
    stepOutcomeOf,
} from "./metrics.js";

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

beforeEach(() => {
    __resetMetricsForTest();
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    provider = new MeterProvider({
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    });
});

afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetMetricsForTest();
});

async function collect(): Promise<MetricData[]> {
    await provider.forceFlush();
    return exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics);
}

describe("reconcile metrics", () => {
    it("bind to a MeterProvider registered after the module was imported", async () => {
        metrics.setGlobalMeterProvider(provider);

        recordArtifactReconcileDropped({ agentId: "agent-x" });
        recordLineageInputDropped({ agentId: "agent-x", reason: "directory" });

        const exported = await collect();
        expect(exported.map((m) => m.descriptor.name).sort()).toEqual(["cortex.artifact.reconcile.dropped", "cortex.artifact.reconcile.input_dropped"]);
    });

    it("carry agent_id and reason only", async () => {
        metrics.setGlobalMeterProvider(provider);

        recordArtifactReconcileDropped({ agentId: "agent-x" });
        recordArtifactReconcileDropped({ agentId: "agent-x" });
        recordLineageInputDropped({ agentId: "agent-x", reason: "missing" });
        recordLineageInputDropped({ agentId: "agent-y", reason: "missing" });

        const exported = await collect();
        const dropped = exported.find((m) => m.descriptor.name === "cortex.artifact.reconcile.dropped")!;
        const inputDropped = exported.find((m) => m.descriptor.name === "cortex.artifact.reconcile.input_dropped")!;
        expect(dropped.dataPoints.map((p) => [p.attributes, p.value])).toEqual([[{ agent_id: "agent-x" }, 2]]);
        expect(inputDropped.dataPoints.map((p) => p.attributes)).toEqual([
            { agent_id: "agent-x", reason: "missing" },
            { agent_id: "agent-y", reason: "missing" },
        ]);
    });
});

describe("run and step outcome metrics", () => {
    it("a run and a step outcome each give one count and one duration sample under the bounded labels only", async () => {
        await provider.shutdown();
        const capture = captureMetrics();
        try {
            recordRunCompleted({ workflow: "analysis", status: "partial", durationMs: 900_000 });
            // A blocked step is a failure to deliver; a step without a durable duration is counted, not timed.
            recordStepCompleted({ agentId: "enrichment", status: stepOutcomeOf("blocked")!, durationMs: 3_000 });
            recordStepCompleted({ agentId: "enrichment", status: "canceled" });

            expect(await capture.sums("cortex.run.completed")).toEqual([[{ status: "partial", workflow: "analysis" }, 1]]);
            expect(await capture.histograms("cortex.run.duration")).toEqual([
                [
                    { status: "partial", workflow: "analysis" },
                    { count: 1, sum: 900_000 },
                ],
            ]);
            expect(await capture.sums("cortex.step.completed")).toEqual([
                [{ status: "failed", agent_id: "enrichment" }, 1],
                [{ status: "canceled", agent_id: "enrichment" }, 1],
            ]);
            expect(await capture.histograms("cortex.step.duration")).toEqual([
                [
                    { status: "failed", agent_id: "enrichment" },
                    { count: 1, sum: 3_000 },
                ],
            ]);
            // A ledger with no start gives no duration; a skipped step gives no outcome.
            expect(elapsedSinceIso(null)).toBeUndefined();
            expect(stepOutcomeOf("skipped")).toBeUndefined();
        } finally {
            await capture.dispose();
        }
    });
});

describe("sandbox exec metrics", () => {
    test("a replayed exec adds one count and one duration sample, under the outcome label alone", async () => {
        await provider.shutdown();
        const capture = captureMetrics();
        try {
            recordSandboxExec({ execId: "wf-1:step-a:3", outcome: "nonzero", durationMs: 4_000 });
            // The workflow body re-runs the await loop on recovery and reaches
            // the record site again with the same exec id.
            recordSandboxExec({ execId: "wf-1:step-a:3", outcome: "nonzero", durationMs: 4_000 });
            // A synthetic failure carries no runtime, thus it counts without timing.
            recordSandboxExec({ execId: "wf-1:step-a:4", outcome: "synthetic-oom", durationMs: null });

            expect(await capture.sums("cortex.sandbox.execs")).toEqual([
                [{ outcome: "nonzero" }, 1],
                [{ outcome: "synthetic-oom" }, 1],
            ]);
            expect(await capture.histograms("cortex.sandbox.exec.duration")).toEqual([[{ outcome: "nonzero" }, { count: 1, sum: 4_000 }]]);
        } finally {
            await capture.dispose();
        }
    });
});
