import { describe, expect, test } from "bun:test";
import { logs } from "@opentelemetry/api-logs";

import { createOtelLogStream } from "./otel.ts";

const captured: Record<string, unknown>[] = [];

// The OTel API accepts a global logger provider ONCE and ignores every later
// registration, so the stub is installed at module scope and the sink is drained
// per call. Registering inside the helper silently kept the first stub and left
// every subsequent capture empty.
//
// The SDK's `LoggerProvider` type is far wider than the two members the stream
// touches (`getLogger` → `emit`); a structural stub is sound because the stream
// calls nothing else, and a real provider would need a live exporter.
logs.setGlobalLoggerProvider({
    getLogger: () => ({ emit: (r: { attributes?: Record<string, unknown> }) => captured.push(r.attributes ?? {}) }),
} as unknown as Parameters<typeof logs.setGlobalLoggerProvider>[0]);

/**
 * What the OTLP stream would export for one pino line.
 *
 * The test drives the real stream rather than rebuilding its projection: the
 * attribute set is the thing under test, and a reimplementation of it here would
 * assert nothing about production.
 */
function exportedAttributes(record: Record<string, unknown>): Record<string, unknown> {
    captured.length = 0;
    createOtelLogStream().write(JSON.stringify(record));
    return captured[0] ?? {};
}

describe("createOtelLogStream", () => {
    test("drops model-authored prose, so a planner's words about the user's data stay on the machine", () => {
        const attributes = exportedAttributes({
            level: 40,
            time: 1,
            msg: "[generate-plan] plan generation finished",
            analysisId: "an-1",
            outcome: "no_outcome",
            modelAuthored: { plannerFinalProse: "atopic dermatitis skin biopsies; sample S7 is a QC outlier" },
        });

        expect(attributes).not.toHaveProperty("modelAuthored");
        expect(JSON.stringify(attributes)).not.toContain("atopic dermatitis");
        // Everything structural still exports — the drop is scoped to the one key the
        // harness nests free-form model text under, not to the diagnostic itself.
        expect(attributes.outcome).toBe("no_outcome");
        expect(attributes.analysisId).toBe("an-1");
    });

    test("exports structural diagnostic fields, including nested objects, as attributes", () => {
        const attributes = exportedAttributes({
            level: 50,
            time: 1,
            msg: "[generate-plan] plan generation finished",
            submitAttempts: 16,
            loop: { finishReason: "max_iterations", cappedOut: true },
        });

        expect(attributes.submitAttempts).toBe(16);
        expect(attributes.loop).toBe(JSON.stringify({ finishReason: "max_iterations", cappedOut: true }));
    });
});
