/**
 * The metrics API has no late-binding proxy: a meter taken before
 * `setGlobalMeterProvider` is the no-op meter for good. The record sites of
 * this module are imported at process start, long before the host's boot
 * registers the provider, so the instruments must bind at record time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

// Imported before any provider exists — the order the production barrel has.
import { __resetReconcileMetricsForTest, recordArtifactReconcileDropped, recordLineageInputDropped } from "./metrics.js";

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

beforeEach(() => {
    __resetReconcileMetricsForTest();
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    provider = new MeterProvider({
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    });
});

afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetReconcileMetricsForTest();
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
