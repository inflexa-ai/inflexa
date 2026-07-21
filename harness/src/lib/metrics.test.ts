/**
 * The instruments must reach a `MeterProvider` registered AFTER this module was
 * imported. `metrics.getMeter` resolves the provider when an instrument is created
 * and the metrics API never upgrades a meter afterwards, so an instrument built at
 * module load — before any embedder can register a provider — would record into the
 * noop meter forever and export nothing. Every assertion below registers the
 * provider first and then records, which is the ordering production runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { __resetLineageMetricsForTest, recordArtifactReconcileDropped, recordLineageEdgeRejected, recordLineageInputDropped } from "./metrics.js";

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    // Long interval — every export in this suite is a manual forceFlush.
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    __resetLineageMetricsForTest();
});

afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetLineageMetricsForTest();
});

async function collect(name: string): Promise<MetricData | undefined> {
    await provider.forceFlush();
    return exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === name);
}

describe("lineage and artifact-reconcile counters", () => {
    it("exports a reconcile drop under its metric name and tags", async () => {
        recordArtifactReconcileDropped({ agentId: "qc-agent", stepId: "qc" });

        const metric = await collect("cortex.artifact.reconcile.dropped");
        expect(metric).toBeDefined();
        expect(metric!.dataPoints).toEqual([expect.objectContaining({ value: 1, attributes: { agent_id: "qc-agent", step_id: "qc" } })]);
    });

    it("exports an input drop tagged with its reconcile-time reason", async () => {
        recordLineageInputDropped({ agentId: "qc-agent", stepId: "qc", reason: "directory" });

        const metric = await collect("cortex.artifact.reconcile.input_dropped");
        expect(metric).toBeDefined();
        expect(metric!.dataPoints).toEqual([expect.objectContaining({ value: 1, attributes: { agent_id: "qc-agent", step_id: "qc", reason: "directory" } })]);
    });

    it("exports an edge rejection on a counter of its own, tagged with its classification-time reason", async () => {
        recordLineageEdgeRejected({ agentId: "gsea-agent", stepId: "T4S1", reason: "producing-step-not-completed" });

        const metric = await collect("cortex.lineage.edge_rejected");
        expect(metric).toBeDefined();
        expect(metric!.dataPoints).toEqual([
            expect.objectContaining({ value: 1, attributes: { agent_id: "gsea-agent", step_id: "T4S1", reason: "producing-step-not-completed" } }),
        ]);
        // A reconcile-time drop counter must not move for a classification-time refusal.
        expect(await collect("cortex.artifact.reconcile.input_dropped")).toBeUndefined();
    });

    it("omits agent_id rather than inventing one when the caller does not know it", async () => {
        recordLineageEdgeRejected({ stepId: "T4S1", reason: "snapshot-unavailable" });

        const metric = await collect("cortex.lineage.edge_rejected");
        expect(metric!.dataPoints[0]!.attributes).toEqual({ step_id: "T4S1", reason: "snapshot-unavailable" });
    });
});
