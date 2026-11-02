import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { __resetMetricsForTest } from "../metrics.js";

export type MetricReader = {
    /** Flush the provider and return the flat list of exported metrics. */
    collect(): Promise<MetricData[]>;
    /** Shut the provider down and unbind the global meter provider. */
    stop(): Promise<void>;
};

/** Bind a meter provider over an in-memory exporter for one test; `stop` undoes both bindings after it. */
export function metricReader(): MetricReader {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
        readers: [
            new PeriodicExportingMetricReader({
                exporter,
                // Long interval — every export in a suite is a manual flush.
                exportIntervalMillis: 3_600_000,
            }),
        ],
    });
    metrics.setGlobalMeterProvider(provider);
    // Drop memoized instruments so they rebind to this fresh provider.
    __resetMetricsForTest();

    return {
        async collect() {
            await provider.forceFlush();
            return exporter
                .getMetrics()
                .flatMap((rm) => rm.scopeMetrics)
                .flatMap((sm) => sm.metrics);
        },
        async stop() {
            await provider.shutdown();
            metrics.disable();
            __resetMetricsForTest();
        },
    };
}
