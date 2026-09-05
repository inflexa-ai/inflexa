/**
 * `initOtel` reads its export switches and its resource from the environment,
 * the way the OTel SDK convention has it. These tests drive the init under
 * different environments and assert on what got registered.
 *
 * The OTLP endpoint is a loopback HTTP server that answers 200 to every
 * request, so the flush at reset completes at once instead of retrying a
 * network error.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { metrics, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
    __otelMeterProviderRegisteredForTest,
    __resetOtelForTest,
    DEFAULT_METRIC_EXPORT_INTERVAL_MS,
    initOtel,
    metricExportIntervalMs,
    metricsExportDisabled,
} from "./otel.js";
import { untracedWorkflow } from "./otel-spans.js";

let collector: Server;
let endpoint: string;

beforeAll(async () => {
    collector = createServer((_req, res) => {
        res.writeHead(200);
        res.end();
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
});

const ENV_KEYS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_METRICS_EXPORTER",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_SERVICE_NAME",
    "OTEL_RESOURCE_ATTRIBUTES",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(async () => {
    await __resetOtelForTest();
    for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

/** The resource attributes a span started on the registered provider carries. */
function registeredResourceAttributes(): Record<string, unknown> {
    const span = trace.getTracer("otel-test").startSpan("probe");
    const resource = (span as unknown as ReadableSpan).resource;
    span.end();
    return resource.attributes;
}

describe("metricExportIntervalMs", () => {
    it("defaults to 60 s", () => {
        expect(metricExportIntervalMs({})).toBe(DEFAULT_METRIC_EXPORT_INTERVAL_MS);
        expect(DEFAULT_METRIC_EXPORT_INTERVAL_MS).toBe(60_000);
    });

    it("reads OTEL_METRIC_EXPORT_INTERVAL in milliseconds", () => {
        expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "15000" })).toBe(15_000);
    });

    it("falls back to the default on a value that is not a positive number", () => {
        expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "soon" })).toBe(DEFAULT_METRIC_EXPORT_INTERVAL_MS);
        expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "0" })).toBe(DEFAULT_METRIC_EXPORT_INTERVAL_MS);
        expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "-1" })).toBe(DEFAULT_METRIC_EXPORT_INTERVAL_MS);
        expect(metricExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "" })).toBe(DEFAULT_METRIC_EXPORT_INTERVAL_MS);
    });
});

describe("metricsExportDisabled", () => {
    it("is true only for OTEL_METRICS_EXPORTER=none", () => {
        expect(metricsExportDisabled({ OTEL_METRICS_EXPORTER: "none" })).toBe(true);
        expect(metricsExportDisabled({ OTEL_METRICS_EXPORTER: "otlp" })).toBe(false);
        expect(metricsExportDisabled({})).toBe(false);
    });
});

describe("initOtel", () => {
    it("registers a metric exporter when an endpoint is set", () => {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
        initOtel();
        expect(__otelMeterProviderRegisteredForTest()).toBe(true);
    });

    it("registers no metric exporter under OTEL_METRICS_EXPORTER=none, and instruments stay usable", () => {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
        process.env.OTEL_METRICS_EXPORTER = "none";
        initOtel();
        expect(__otelMeterProviderRegisteredForTest()).toBe(false);
        // The API's no-op provider serves the instrument — a record site never sees the switch.
        expect(() => metrics.getMeter("otel-test").createCounter("otel.test.counter").add(1)).not.toThrow();
        // Traces are untouched by the metrics switch.
        const span = trace.getTracer("otel-test").startSpan("probe");
        expect(span.spanContext().spanId).not.toBe("0000000000000000");
        span.end();
    });

    it("registers no metric exporter without an endpoint", () => {
        initOtel();
        expect(__otelMeterProviderRegisteredForTest()).toBe(false);
    });

    it("puts the host's service name and version on the resource", () => {
        initOtel({ serviceName: "cortex-test", serviceVersion: "1.2.3" });
        expect(registeredResourceAttributes()).toMatchObject({
            "service.name": "cortex-test",
            "service.version": "1.2.3",
        });
    });

    it("lets the environment override the service name and add attributes", () => {
        process.env.OTEL_SERVICE_NAME = "cortex-from-env";
        process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment.name=staging";
        initOtel({ serviceName: "cortex-manual", serviceVersion: "1.2.3" });
        expect(registeredResourceAttributes()).toMatchObject({
            "service.name": "cortex-from-env",
            "service.version": "1.2.3",
            "deployment.environment.name": "staging",
        });
    });

    it("defaults the service name to cortex", () => {
        initOtel();
        expect(registeredResourceAttributes()).toMatchObject({ "service.name": "cortex" });
        expect(registeredResourceAttributes()).not.toHaveProperty("service.version");
    });

    it("installs the span policy: an untraced workflow root is not recorded, every other root is", () => {
        untracedWorkflow("otel-test-untraced");
        initOtel();
        const tracer = trace.getTracer("otel-test");
        const cleanup = tracer.startSpan("otel-test-untraced");
        const run = tracer.startSpan("executeAnalysis");
        expect(cleanup.isRecording()).toBe(false);
        expect(run.isRecording()).toBe(true);
        cleanup.end();
        run.end();
    });
});
