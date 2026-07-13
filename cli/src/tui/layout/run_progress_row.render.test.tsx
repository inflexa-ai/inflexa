import { afterEach, describe, expect, test } from "bun:test";
import { For } from "solid-js";
import { okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";
import type { CortexRunRow, StepExecutionRow } from "@inflexa-ai/harness";

import { RunProgressRow } from "./run_progress_row.tsx";
import { ScrollPane } from "../components/scroll_pane.tsx";
import { theme } from "../theme.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { __resetSidebarLiveForTest, activeRunProgress, refreshSidebarData, type RefreshSeams } from "../hooks/sidebar_live.ts";

// The row's whole job is size-dependent: it sits directly below the chat stream's flexGrow scrollbox,
// so it inherits the two documented layout hazards (cli/CLAUDE.md "Layout") — the 1-cell scrollbox
// bleed painting scroll content onto the row below, and the short-terminal squeeze dropping chrome
// off-screen. A render at one size hides both; the squeeze suite sweeps heights. The row is fed by the
// module signal `activeRunProgress`, driven here through the real `refreshSidebarData` over fake seams
// (no Postgres), exactly as production populates it.

const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

afterEach(() => {
    __resetSidebarLiveForTest();
});

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
    let count = 0;
    let from = 0;
    for (;;) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        count++;
        from = idx + needle.length;
    }
    return count;
}

function runRow(over: Partial<CortexRunRow> = {}): CortexRunRow {
    return {
        runId: "11112222-3333-4444-5555-6666aabbccdd",
        analysisId: "a1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        error: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        attemptCount: 0,
        ...over,
    };
}

function stepRow(stepId: string, status: StepExecutionRow["status"]): StepExecutionRow {
    return {
        runId: "11112222-3333-4444-5555-6666aabbccdd",
        stepId,
        analysisId: "a1",
        wave: 0,
        agentId: "agent",
        status,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        execId: null,
        childWorkflowId: null,
        sandboxRef: null,
    };
}

/** Publish an active (non-terminal newest) run + its steps into the module signal, as a refresh would. */
async function publish(steps: StepExecutionRow[], run: Partial<CortexRunRow> = {}): Promise<void> {
    const seams: RefreshSeams = {
        runtime: () => fakeRuntime,
        loadProfile: () => okAsync(null),
        loadRuns: () => okAsync([runRow(run)]),
        loadSteps: () => okAsync(steps),
    };
    await refreshSidebarData("A", seams);
}

describe("RunProgressRow — presence and the bounded step window", () => {
    test("renders the bar (done/total) and a windowed step slice when a run is active", async () => {
        // 12 steps > the row's maxSteps=6: the first 7 are done, so the window centers on the frontier
        // (step 7) and clamps to a slice of the tail — the bar/done-total still reflect the full run.
        const steps: StepExecutionRow[] = Array.from({ length: 12 }, (_unused, i) =>
            stepRow(`step-${String(i).padStart(2, "0")}`, i < 7 ? "completed" : i === 7 ? "running" : "pending"),
        );
        await publish(steps);
        expect(activeRunProgress()).not.toBeNull(); // guard: the fixture produced a pinned run

        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <RunProgressRow />
                </box>
            ),
            { width: 50, height: 16 },
        );
        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("executeAnalysis"); // the run name (shortRunName)
            expect(frame).toContain("7/12"); // the bar's done/total, reflecting the FULL run
            // The window is centered on the frontier (index 7), clamped to indices 4..9.
            expect(frame).toContain("step-04");
            expect(frame).toContain("step-09");
            expect(frame).not.toContain("step-00"); // before the window
            expect(frame).not.toContain("step-11"); // after the window
        } finally {
            setup.renderer.destroy();
        }
    });

    test("renders nothing when no run is active (the signal is null)", async () => {
        __resetSidebarLiveForTest(); // the signal is null
        expect(activeRunProgress()).toBeNull();

        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <RunProgressRow />
                </box>
            ),
            { width: 50, height: 8 },
        );
        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).not.toContain("executeAnalysis");
            expect(frame.trim()).toBe(""); // an empty column — no row painted at all
        } finally {
            setup.renderer.destroy();
        }
    });
});

// The row alone at one size cannot catch the two failure modes its ACTUAL mount site risks (see
// app.tsx + cli/CLAUDE.md "Layout"): the flexGrow-scrollbox 1-cell bleed painting scroll content onto
// the row, and the short-terminal squeeze pushing the row (or the input below it) off-screen. So mirror
// the real chat column — a flexGrow ScrollPane with overflowing content, the RunProgressRow, and a
// flexShrink={0} input-like box below — and sweep heights. At every height the row must render exactly
// once (not doubled/corrupted by bleed, not squeezed out), its top row must carry no bled scroll
// content, and the input chrome directly below it must keep its rows.
describe("RunProgressRow at its real mount shape survives bleed + short-terminal squeeze", () => {
    const HEIGHTS = [8, 11, 16, 24];

    for (const height of HEIGHTS) {
        test(`height ${height}: the row renders once, stays opaque, and the input below stays intact`, async () => {
            // A compact run (3 steps ≤ the window) so the block fits even the shortest sweep height; the
            // bleed/squeeze property under test is independent of the step count.
            await publish([stepRow("step-a", "completed"), stepRow("step-b", "running"), stepRow("step-c", "pending")]);

            const setup = await testRender(
                () => (
                    <box flexDirection="column" width="100%" height="100%">
                        <box flexDirection="column" flexGrow={1} minHeight={0}>
                            {/* Content overflows the pane so the documented 1-cell bleed is in play. */}
                            <ScrollPane focusOnMount={false} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1}>
                                <For each={Array.from({ length: 60 }, (_unused, i) => i)}>{(i) => <text>scroll-line-{i}</text>}</For>
                            </ScrollPane>
                            <RunProgressRow />
                            {/* The input-like chrome directly below the row (flexShrink={0}, painted). */}
                            <box width="100%" flexShrink={0} backgroundColor={theme().bg} paddingLeft={1}>
                                <text>input-bar-row</text>
                            </box>
                        </box>
                    </box>
                ),
                { width: 50, height },
            );
            try {
                await setup.renderOnce();
                const frame = setup.captureCharFrame();
                // Exactly once: never doubled/overwritten by the scrollbox bleed (the painted wrapper
                // opaquely reclaims its row), never zero (the flexShrink={0} wrapper held its rows).
                expect(occurrences(frame, "executeAnalysis")).toBe(1);
                expect(frame).toContain("step-b"); // the row's step list stayed intact
                // The row's top row (the name line) must carry NO bled scroll content — the opaque
                // full-width box reclaimed it. A bare/transparent row would let a `scroll-line` fragment
                // show through here.
                const nameLine = frame.split("\n").find((l) => l.includes("executeAnalysis"));
                expect(nameLine).toBeDefined();
                expect(nameLine).not.toContain("scroll-line");
                // The input chrome directly below the row kept its rows too — not squeezed off-screen.
                expect(frame).toContain("input-bar-row");
            } finally {
                setup.renderer.destroy();
            }
        });
    }
});
