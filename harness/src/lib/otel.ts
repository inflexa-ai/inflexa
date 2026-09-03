/**
 * OpenTelemetry SDK initialization — traces + metrics.
 *
 * Exported as `initOtel()` and called explicitly from the host's boot sequence
 * so the bundler cannot tree-shake it (side-effect-only imports get dropped).
 *
 * Traces: NodeTracerProvider exports to OTLP when OTEL_EXPORTER_OTLP_ENDPOINT
 *         is set.
 *
 * Metrics: MeterProvider exports to OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is
 *          set and OTEL_METRICS_EXPORTER is not `none`. The export interval is
 *          OTEL_METRIC_EXPORT_INTERVAL (ms), default 60 s. Custom Cortex
 *          metrics are defined in metrics.ts.
 *
 * Resource: the host's `serviceName` / `serviceVersion` merged with the SDK
 *           env detector (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`);
 *           the environment wins on a conflict, so a deployment can set
 *           `deployment.environment.name` or override the service name without
 *           a code change. Traces and metrics share the one resource.
 *
 * Note: OTEL's instrumentation-http patches node:http but does not cover
 *        Hono's request handling or Node 22's undici-based globalThis.fetch,
 *        so inbound/outbound trace-context propagation across those paths is
 *        not currently wired.
 */

import { context, propagation, metrics, trace } from "@opentelemetry/api";

import { createNoopLogger } from "./console-logger.js";
import type { Logger } from "./logger.js";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/** The SDK's own default when neither the host nor the environment says otherwise. */
export const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;

export interface InitOtelOptions {
    /** Diagnostics sink; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** `service.name` when `OTEL_SERVICE_NAME` is unset. Default `cortex`. */
    readonly serviceName?: string;
    /** `service.version` — the host's package version. Omitted leaves the attribute unset. */
    readonly serviceVersion?: string;
}

let initialized = false;
let registeredTracerProvider: NodeTracerProvider | undefined;
let registeredMeterProvider: MeterProvider | undefined;

/**
 * `OTEL_METRICS_EXPORTER=none` turns metric export off while the OTLP endpoint
 * stays set for traces. Any other value (including unset) keeps the OTLP
 * exporter, the only one the harness ships.
 */
export function metricsExportDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.OTEL_METRICS_EXPORTER === "none";
}

/**
 * Export interval from `OTEL_METRIC_EXPORT_INTERVAL` (milliseconds). An unset,
 * non-numeric, or non-positive value falls back to the 60 s default.
 */
export function metricExportIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.OTEL_METRIC_EXPORT_INTERVAL;
    if (raw === undefined || raw.trim() === "") return DEFAULT_METRIC_EXPORT_INTERVAL_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_METRIC_EXPORT_INTERVAL_MS;
    return Math.floor(parsed);
}

function buildResource(options: InitOtelOptions): Resource {
    const manual: Record<string, string> = {
        [ATTR_SERVICE_NAME]: options.serviceName ?? "cortex",
    };
    if (options.serviceVersion) manual[ATTR_SERVICE_VERSION] = options.serviceVersion;
    // `merge` gives precedence to the argument: the environment overrides the
    // host's values, which is the OTel SDK convention for env configuration.
    return resourceFromAttributes(manual).merge(detectResources({ detectors: [envDetector] }));
}

/**
 * Initialize the OpenTelemetry SDK. Must be called before any code that
 * calls trace.getTracer() or metrics.getMeter().
 *
 * Safe to call multiple times — only the first call has effect.
 */
export function initOtel(options: InitOtelOptions = {}): void {
    if (initialized) return;
    initialized = true;
    const logger = (options.logger ?? createNoopLogger()).named("otel");

    // ── W3C Trace Context propagation ──────────────────────────────────
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const resource = buildResource(options);

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
        // A `console.log` here is what forced the CLI embedder to pass
        // `initTelemetry: () => {}` — its TUI owns stdout, so the banner corrupted
        // the screen and the whole of the harness's traces + metrics were switched
        // off to avoid it. At debug through the injected seam it costs nothing.
        logger.debug("TracerProvider registered", {
            spanId: ctx.spanId,
            noop: isNoop,
            endpoint: endpoint ?? null,
            processors: spanProcessors.length,
            resource: resource.attributes,
        });
        testSpan.end();
    }

    // ── Metrics ────────────────────────────────────────────────────────
    // With no MeterProvider registered the API's global no-op provider serves
    // every instrument, so the record sites stay valid when export is off.
    if (endpoint && !metricsExportDisabled()) {
        const base = endpoint.replace(/\/+$/, "");
        const metricExporter = new OTLPMetricExporter({
            url: `${base}/v1/metrics`,
        });

        const meterProvider = new MeterProvider({
            resource,
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: metricExportIntervalMs(),
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

/**
 * Test hook: shut the providers down and unregister every global the init
 * touched, so a test can drive `initOtel` again under a different environment.
 * Test-only.
 */
export async function __resetOtelForTest(): Promise<void> {
    await shutdownOtel();
    registeredTracerProvider = undefined;
    registeredMeterProvider = undefined;
    trace.disable();
    metrics.disable();
    context.disable();
    propagation.disable();
    initialized = false;
}

/** Test hook: whether `initOtel` registered a metric-exporting MeterProvider. Test-only. */
export function __otelMeterProviderRegisteredForTest(): boolean {
    return registeredMeterProvider !== undefined;
}
