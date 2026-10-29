/**
 * In-memory OTel metrics capture for a test that asserts on what a record site
 * exported. The harness binds its instruments to the GLOBAL `MeterProvider` at
 * first use (`lib/metrics.ts`), so the capture registers one, resets the
 * memoised instruments so they rebind to it, and undoes both on `dispose`.
 */

import { type Attributes, metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { __resetMetricsForTest } from "../../lib/metrics.js";
import { __resetScriptMetricsForTest } from "../../tools/script/metrics.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";

export type MetricsCapture = {
    /** `[attributes, value]` of each data point of a counter; `[]` when the instrument exported nothing. */
    sums(name: string): Promise<Array<[Attributes, number]>>;
    /** `[attributes, {count, sum}]` of each data point of a histogram; `[]` when the instrument exported nothing. */
    histograms(name: string): Promise<Array<[Attributes, { count: number; sum: number | undefined }]>>;
    /** The bucket bounds and the count of each bucket of each data point of a histogram. */
    buckets(name: string): Promise<Array<{ boundaries: number[]; counts: number[] }>>;
    /** Shut the provider down and unbind the global meter provider. */
    dispose(): Promise<void>;
};

export function captureMetrics(): MetricsCapture {
    __resetMetricsForTest();
    __resetScriptMetricsForTest();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })] });
    metrics.setGlobalMeterProvider(provider);

    const find = async (name: string): Promise<MetricData | undefined> => {
        await provider.forceFlush();
        // The exporter keeps each export, and each export is cumulative, thus the last one holds the current value.
        const matches = exporter
            .getMetrics()
            .flatMap((rm) => rm.scopeMetrics)
            .flatMap((sm) => sm.metrics)
            .filter((m) => m.descriptor.name === name);
        return matches.at(-1);
    };

    return {
        async sums(name) {
            const metric = await find(name);
            return (metric?.dataPoints ?? []).flatMap((dp) => {
                const pointValue: unknown = dp.value;
                return typeof pointValue === "number" ? [[dp.attributes, pointValue] as const] : [];
            });
        },
        async histograms(name) {
            const metric = await find(name);
            return (metric?.dataPoints ?? []).flatMap((dp) => {
                const point = parseUnknownRecord(dp.value);
                if (point === undefined) return [];
                const { count, sum } = point;
                if (typeof count !== "number") return [];
                return [[dp.attributes, { count, sum: typeof sum === "number" ? sum : undefined }] as const];
            });
        },
        async buckets(name) {
            const metric = await find(name);
            return (metric?.dataPoints ?? []).flatMap((dp) => {
                const buckets = parseUnknownRecord(parseUnknownRecord(dp.value)?.buckets);
                const { boundaries, counts } = buckets ?? {};
                if (!Array.isArray(boundaries) || !Array.isArray(counts)) return [];
                return [{ boundaries: boundaries.filter((b) => typeof b === "number"), counts: counts.filter((c) => typeof c === "number") }];
            });
        },
        async dispose() {
            await provider.shutdown();
            metrics.disable();
            __resetMetricsForTest();
            __resetScriptMetricsForTest();
        },
    };
}
