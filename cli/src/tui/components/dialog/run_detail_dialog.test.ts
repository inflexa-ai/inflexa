import { describe, expect, test } from "bun:test";
import type { CortexRunRow } from "@inflexa-ai/harness";

import { runDetailLines } from "./run_detail_dialog.tsx";
import { absTime } from "../../hooks/sidebar_live.ts";

// `runDetailLines` is the dialog's pure metadata composer (row → string[]), mirroring
// `profileDetailLines`: absolute local timestamps + a duration for finished runs (the
// durable-record rule), an elapsed age for a run still in flight, and the error verbatim.

function run(overrides: Partial<CortexRunRow> = {}): CortexRunRow {
    return {
        runId: "11111111-2222-3333-4444-5555aabbccdd",
        analysisId: "an-1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        ...overrides,
    };
}

describe("runDetailLines", () => {
    test("a completed run pins absolute started/completed plus a duration", () => {
        const lines = runDetailLines(run());
        expect(lines[0]).toBe("status: completed");
        expect(lines).toContain(`started ${absTime("2026-01-01T00:00:00.000Z")}`);
        expect(lines).toContain(`completed ${absTime("2026-01-01T00:05:00.000Z")}`);
        expect(lines.some((l) => l.startsWith("duration "))).toBe(true);
        expect(lines.some((l) => l.startsWith("elapsed "))).toBe(false);
    });

    test("a running run shows elapsed instead of completed/duration", () => {
        const lines = runDetailLines(run({ status: "running", completedAt: null }));
        expect(lines[0]).toBe("status: running");
        expect(lines.some((l) => l.startsWith("completed "))).toBe(false);
        expect(lines.some((l) => l.startsWith("duration "))).toBe(false);
        expect(lines.some((l) => l.startsWith("elapsed "))).toBe(true);
    });

    test("a failed run appends its error verbatim, one line per source line", () => {
        const lines = runDetailLines(run({ status: "failed", error: "step s2 blew up\ncaused by: OOM" }));
        expect(lines).toContain("step s2 blew up");
        expect(lines).toContain("caused by: OOM");
    });

    test("an unparseable started time yields no duration/elapsed line", () => {
        const lines = runDetailLines(run({ startedAt: "not-a-date", completedAt: null }));
        expect(lines.some((l) => l.startsWith("duration "))).toBe(false);
        expect(lines.some((l) => l.startsWith("elapsed "))).toBe(false);
    });
});
