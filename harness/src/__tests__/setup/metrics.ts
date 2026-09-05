/**
 * In-memory OTel metrics capture for a test that asserts on what a record site
 * exported. The harness binds its instruments to the GLOBAL `MeterProvider` at
 * first use (`lib/metrics.ts`), so the capture registers one, resets the
 * memoised instruments so they rebind to it, and undoes both on `dispose`.
 */

import { type Attributes, metrics } from "@opentelemetry/api";
import {
    AggregationTemporality,
    type HistogramMetricData,
    InMemoryMetricExporter,
    MeterProvider,
    type MetricData,
    PeriodicExportingMetricReader,
    type SumMetricData,
} from "@opentelemetry/sdk-metrics";

import { __resetMetricsForTest } from "../../lib/metrics.js";

export interface MetricsCapture {
    /** `[attributes, value]` of each data point of a counter; `[]` when the instrument exported nothing. */
    sums(name: string): Promise<Array<[Attributes, number]>>;
    /** `[attributes, {count, sum}]` of each data point of a histogram; `[]` when the instrument exported nothing. */
    histograms(name: string): Promise<Array<[Attributes, { count: number; sum: number | undefined }]>>;
    /** Shut the provider down and unbind the global meter provider. */
    dispose(): Promise<void>;
}

export function captureMetrics(): MetricsCapture {
    __resetMetricsForTest();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })] });
    metrics.setGlobalMeterProvider(provider);

    const find = async (name: string): Promise<MetricData | undefined> => {
        await provider.forceFlush();
        return exporter
            .getMetrics()
            .flatMap((rm) => rm.scopeMetrics)
            .flatMap((sm) => sm.metrics)
            .find((m) => m.descriptor.name === name);
    };

    return {
        async sums(name) {
            const metric = (await find(name)) as SumMetricData | undefined;
            return metric?.dataPoints.map((dp) => [dp.attributes, dp.value]) ?? [];
        },
        async histograms(name) {
            const metric = (await find(name)) as HistogramMetricData | undefined;
            return metric?.dataPoints.map((dp) => [dp.attributes, { count: dp.value.count, sum: dp.value.sum }]) ?? [];
        },
        async dispose() {
            await provider.shutdown();
            metrics.disable();
            __resetMetricsForTest();
        },
    };
}
