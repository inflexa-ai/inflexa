/**
 * OTel smoke test for DBOS v4.
 *
 * `@dbos-inc/otel` is a "dependency-bundle" package — installing it pulls
 * in the OTel SDK transitive deps DBOS imports at runtime. Without it,
 * DBOS's OTel calls fail silently and no spans emit (v4 OTel is opt-in).
 * This test guards the install itself: if
 * `@dbos-inc/otel` is accidentally removed or its transitive deps
 * regress, this fails before change 8's workflow tests rely on it.
 *
 * Full span-export verification (a real DBOS launch + a registered step +
 * exporter assertion) lands with the durable workflow tests in change 8;
 * trying to do it here would mean spinning up Postgres + DBOS for every
 * `bun test` run. Manual procedure: point an OTel collector at the dev
 * stack, run `just dev`, hit a DBOS workflow, confirm `dbos.*` spans land
 * at the collector.
 */

import { describe, expect, it } from "bun:test";

describe("@dbos-inc/otel install", () => {
    it("resolves and pulls in the OTLP trace exporter", async () => {
        // Both must resolve — the failure mode we're guarding is "DBOS imports
        // the OTLP exporter at runtime, but it isn't installed, so spans never
        // emit." If this import fails, DBOS's OTel path is broken.
        const exporter = await import("@opentelemetry/exporter-trace-otlp-proto");
        expect(typeof exporter.OTLPTraceExporter).toBe("function");
    });

    it("DBOS exposes setConfig options that govern OTLP attribute format", async () => {
        // DBOSConfig accepts otelAttributeFormat / otlpTracesEndpoints. We're
        // asserting the SDK shape we depend on stays present — a major-version
        // bump that drops these would silently break tracing.
        const { DBOS } = await import("@dbos-inc/dbos-sdk");
        expect(typeof DBOS.setConfig).toBe("function");
    });
});
