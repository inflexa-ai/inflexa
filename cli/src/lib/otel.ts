/**
 * OpenTelemetry Logs SDK initialization — logs only (no traces/metrics yet).
 *
 * Exported as `initOtel()` and called explicitly from the entry point to
 * prevent the bundler from tree-shaking it (side-effect-only imports get
 * dropped). Mirrors cortex harness/lib/otel.ts.
 *
 * Export is gated on BOTH user consent (config.json) and
 * OTEL_EXPORTER_OTLP_ENDPOINT. Pino records reach OTel through the bridge
 * stream from `createOtelLogStream()`, attached via `addLogStream()` only
 * when `initOtel()` reports active — the disabled path costs nothing.
 */

import { diag, DiagLogLevel, type AttributeValue } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { DestinationStream } from "pino";

import pkg from "../../package.json";
import { env } from "./env.ts";
import { getLogger } from "./log.ts";

let initialized = false;
let active = false;
let registeredLoggerProvider: LoggerProvider | undefined;

const severities: Record<number, { severityNumber: SeverityNumber; severityText: string }> = {
    10: { severityNumber: SeverityNumber.TRACE, severityText: "TRACE" },
    20: { severityNumber: SeverityNumber.DEBUG, severityText: "DEBUG" },
    30: { severityNumber: SeverityNumber.INFO, severityText: "INFO" },
    40: { severityNumber: SeverityNumber.WARN, severityText: "WARN" },
    50: { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" },
    60: { severityNumber: SeverityNumber.FATAL, severityText: "FATAL" },
};

/**
 * Initialize the OTel Logs SDK when consent is granted and an endpoint is
 * configured. Safe to call multiple times — only the first call has effect.
 * Returns whether export is active. Never throws.
 */
export function initOtel(consented: boolean): boolean {
    if (initialized) return active;
    initialized = true;

    const endpoint = env.otelEndpoint;
    if (!consented || !endpoint) return false;

    try {
        const base = endpoint.replace(/\/+$/, "");
        const provider = new LoggerProvider({
            resource: resourceFromAttributes({
                [ATTR_SERVICE_NAME]: pkg.name,
                [ATTR_SERVICE_VERSION]: pkg.version,
            }),
            processors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${base}/v1/logs` }))],
        });
        logs.setGlobalLoggerProvider(provider);
        registeredLoggerProvider = provider;

        // Exporter failures surface through OTel's diag channel; route them to
        // the local file at debug so a dead endpoint is silent but diagnosable.
        const log = getLogger("otel");
        const toFile = (message: string, ...args: unknown[]) => {
            log.debug({ args }, message);
        };
        diag.setLogger({ error: toFile, warn: toFile, info: toFile, debug: toFile, verbose: toFile }, DiagLogLevel.ERROR);

        active = true;
    } catch {
        active = false;
    }
    return active;
}

/**
 * Pino destination stream that forwards each record to the OTel Logs API.
 * Runs in-process (no worker threads, no module patching). Records are
 * already redacted by the root logger before they reach this stream.
 */
export function createOtelLogStream(): DestinationStream {
    const otelLogger = logs.getLogger("inflexa");
    return {
        write(line: string): void {
            try {
                const record = JSON.parse(line) as Record<string, unknown>;
                // Records from the otel module are diag output — re-exporting
                // them would loop a failing exporter back into itself.
                if (record["module"] === "otel") return;

                const level = typeof record["level"] === "number" ? record["level"] : 30;
                const attributes: Record<string, AttributeValue> = {};
                for (const [key, value] of Object.entries(record)) {
                    if (key === "level" || key === "time" || key === "msg" || value == null) continue;
                    attributes[key] = typeof value === "object" ? JSON.stringify(value) : (value as AttributeValue);
                }

                otelLogger.emit({
                    ...(severities[level] ?? severities[30]),
                    body: typeof record["msg"] === "string" ? record["msg"] : "",
                    timestamp: typeof record["time"] === "number" ? record["time"] : Date.now(),
                    attributes,
                });
            } catch {
                // Telemetry must never break logging.
            }
        },
    };
}

/**
 * Flush and shut down the OTel exporter with a bounded timeout so a dead
 * endpoint cannot hold the process open. Never throws.
 */
export async function shutdownOtel(): Promise<void> {
    if (!registeredLoggerProvider) return;
    await Promise.race([
        Promise.allSettled([registeredLoggerProvider.shutdown()]),
        new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000).unref();
        }),
    ]);
}
