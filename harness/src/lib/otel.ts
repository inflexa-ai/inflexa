/**
 * OpenTelemetry SDK initialization — traces + metrics.
 *
 * Exported as `initOtel()` and called explicitly from index.ts to prevent
 * the bundler from tree-shaking it (side-effect-only imports get dropped).
 *
 * Traces: NodeTracerProvider exports to OTLP when OTEL_EXPORTER_OTLP_ENDPOINT
 *         is set.
 *
 * Metrics: MeterProvider exports to OTLP when OTEL_EXPORTER_OTLP_ENDPOINT
 *          is set. Custom Cortex metrics are defined in metrics.ts.
 *
 * Note: OTEL's instrumentation-http patches node:http but does not cover
 *        Hono's request handling or Node 22's undici-based globalThis.fetch,
 *        so inbound/outbound trace-context propagation across those paths is
 *        not currently wired.
 */

import { propagation, metrics, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let initialized = false;
let registeredTracerProvider: NodeTracerProvider | undefined;
let registeredMeterProvider: MeterProvider | undefined;

/**
 * Initialize the OpenTelemetry SDK. Must be called before any code that
 * calls trace.getTracer() or metrics.getMeter().
 *
 * Safe to call multiple times — only the first call has effect.
 */
export function initOtel(): void {
    if (initialized) return;
    initialized = true;

    // ── W3C Trace Context propagation ──────────────────────────────────
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    // ── Traces ─────────────────────────────────────────────────────────
    // Always register a TracerProvider so trace.getTracer() returns real spans
    // with unique IDs. Without this, the OtelBridge gets no-op spans (all zeros)
    // that collide in its span map, causing "No OTEL span found" warnings.
    {
        const spanProcessors: SpanProcessor[] = [];

        if (endpoint) {
            const base = endpoint.replace(/\/+$/, "");
            spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces` })));
        }

        const serviceName = process.env.OTEL_SERVICE_NAME || "cortex";
        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
        });

        const tracerProvider = new NodeTracerProvider({
            resource,
            spanProcessors,
        });
        tracerProvider.register();
        registeredTracerProvider = tracerProvider;

        // Debug: verify registration actually worked
        const testTracer = trace.getTracer("otel-init-check");
        const testSpan = testTracer.startSpan("init-check");
        const ctx = testSpan.spanContext();
        const isNoop = ctx.spanId === "0000000000000000";
        console.log(
            `[otel] TracerProvider registered: spanId=${ctx.spanId}, noop=${isNoop}, ` +
                `endpoint=${endpoint ?? "(none)"}, processors=${spanProcessors.length}`,
        );
        testSpan.end();
    }

    // ── Metrics ────────────────────────────────────────────────────────
    if (endpoint) {
        const base = endpoint.replace(/\/+$/, "");
        const metricExporter = new OTLPMetricExporter({
            url: `${base}/v1/metrics`,
        });

        const meterProvider = new MeterProvider({
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: 30_000,
                }),
            ],
        });

        metrics.setGlobalMeterProvider(meterProvider);
        registeredMeterProvider = meterProvider;
    }
}

/**
 * Flush and shut down the OTel exporters. Called by the graceful-shutdown
 * sequence so in-flight batch spans/metrics make it to the collector
 * before the process exits. Never throws.
 */
export async function shutdownOtel(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (registeredTracerProvider) tasks.push(registeredTracerProvider.shutdown());
    if (registeredMeterProvider) tasks.push(registeredMeterProvider.shutdown());
    await Promise.allSettled(tasks);
}
