import { describe, expect, test } from "bun:test";
import type { CortexRunRow } from "@inflexa-ai/harness";

import { runDetailLines } from "./run_detail_dialog.tsx";
import { GLYPHS } from "../../../lib/design_system.ts";
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

    test("the run's figures ride as one more property line, in the shared notation", () => {
        const lines = runDetailLines(run(), { calls: 47, inputTokens: 809_200, outputTokens: 40_400 });

        // The LABELLED form: a `label value` property line among the timings, in a full-width dialog
        // being read deliberately — not the rail's compact decoration on a 37-cell row.
        expect(lines).toContain(`usage 809.2k in ${GLYPHS.middot} 40.4k out ${GLYPHS.middot} 47 calls`);
        // The five quantities are never combined: 849.6k is input+output.
        expect(lines.join("\n")).not.toContain("849.6k");
    });

    test("a run whose provider reported nothing keeps its call count beside the absent word", () => {
        const lines = runDetailLines(run(), { calls: 1 });

        expect(lines).toContain(`usage not reported ${GLYPHS.middot} 1 call`);
        // Never a zero: "the provider measured nothing" is not "nothing was spent".
        expect(lines.some((l) => l.includes("0 in") || l.includes("0 out"))).toBe(false);
    });

    test("a half figure keeps the arm it has rather than inventing the one it lacks", () => {
        const lines = runDetailLines(run(), { calls: 2, outputTokens: 40 });

        expect(lines).toContain(`usage 40 out ${GLYPHS.middot} 2 calls`);
    });

    test("no usage handed in omits the line entirely — the run's other properties are unchanged", () => {
        const without = runDetailLines(run());
        const with_ = runDetailLines(run(), { calls: 1, inputTokens: 10 });

        expect(without.some((l) => l.startsWith("usage "))).toBe(false);
        // The figure is ADDITIVE: every line the run already had survives, in order.
        expect(with_.filter((l) => !l.startsWith("usage "))).toEqual(without);
    });

    test("the run's step-less calls are named under the headline, so the total reconciles", () => {
        const lines = runDetailLines(
            run(),
            { calls: 47, inputTokens: 809_200, outputTokens: 40_400 },
            { calls: 15, inputTokens: 284_900, outputTokens: 15_500 },
        );

        expect(lines).toContain(`  outside any step 284.9k in ${GLYPHS.middot} 15.5k out ${GLYPHS.middot} 15 calls`);
        // Indented UNDER the headline it is a part of, and immediately after it: the remainder means
        // nothing on its own, and levelling it would read as a second, unrelated total.
        const headline = lines.findIndex((l) => l.startsWith("usage "));
        expect(lines[headline + 1]).toStartWith("  outside any step ");
    });

    test("a step-less call whose provider reported nothing is still named", () => {
        // The case the line most has to cover: the headline counted the call, no step shows it, and
        // there is no figure anywhere to hint at the gap. Gating the line on figures would hide it.
        const lines = runDetailLines(run(), { calls: 4, inputTokens: 100 }, { calls: 1 });

        expect(lines).toContain(`  outside any step not reported ${GLYPHS.middot} 1 call`);
    });

    test("a fully attributed run carries no remainder line", () => {
        const attributed = runDetailLines(run(), { calls: 4, inputTokens: 100 }, null);
        const zeroCalls = runDetailLines(run(), { calls: 4, inputTokens: 100 }, { calls: 0 });

        // `null` (every call has a step) and a zero-call remainder are the same statement, and neither
        // is a gap worth a line — an "outside any step" row on a run that has none reads as a defect.
        for (const lines of [attributed, zeroCalls]) expect(lines.some((l) => l.includes("outside any step"))).toBe(false);
        expect(zeroCalls).toEqual(attributed);
    });
});
