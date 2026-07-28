import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { okAsync, errAsync } from "neverthrow";

import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshSeams } from "./sidebar_live.ts";
import {
    __resetRunPanelForTest,
    activeRunCount,
    focusedRun,
    focusedRunActivity,
    focusedRunPosition,
    focusNextRun,
    restoreRunPanel,
    runPanelVisible,
    toggleRunPanel,
    watchRunPanel,
    type RunPanelSeams,
} from "./run_panel.ts";
import type { CortexRunRow, DataProfileStatus, StepExecutionRow } from "@inflexa-ai/harness";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// The panel store owns three things: which run is focused, whether the panel is dismissed, and the
// focused run's activity label. The load-bearing decision under test is that the focused run is
// DERIVED from the live active set rather than stored — which is what makes auto-advance fall out
// with no fix-up effect, and what makes navigation step from the run actually on screen.

// A fake pool: the store never touches it (the activity read is a seam), so an empty object typed
// through the runtime handle is sufficient.
const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

function runRow(over: Partial<CortexRunRow> & { runId: string }): CortexRunRow {
    return {
        analysisId: "analysis-1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "running",
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        error: null,
        synthesisStatus: null,
        synthesisReason: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        ...over,
    };
}

function stepRow(runId: string, over: Partial<StepExecutionRow> = {}): StepExecutionRow {
    return {
        runId,
        stepId: "T1S1",
        analysisId: "analysis-1",
        wave: 0,
        agentId: "bioinformatician",
        status: "running",
        startedAt: "2026-07-28T10:00:01.000Z",
        completedAt: null,
        attempts: 1,
        blockedReason: null,
        ...(over as object),
    } as StepExecutionRow;
}

/** Refresh seams over a fixed set of runs; every run reports one running step. */
function seamsFor(runs: CortexRunRow[], opts: { failStepsFor?: Set<string> } = {}): RefreshSeams {
    return {
        runtime: () => fakeRuntime,
        loadProfile: () => okAsync<DataProfileStatus | null, never>(null),
        loadRuns: () => okAsync(runs),
        loadSteps: (_pool, runId) => (opts.failStepsFor?.has(runId) ? errAsync({ type: "query_failed", cause: "boom" } as never) : okAsync([stepRow(runId)])),
        loadPlan: () => okAsync<unknown | null, never>(null),
    };
}

/** Panel seams whose activity read resolves a fixed label (or null). */
function panelSeams(label: string | null): RunPanelSeams {
    return {
        runtime: () => fakeRuntime,
        readActivity: async () => (label === null ? null : { step: 1, label }),
    };
}

afterEach(() => {
    __resetSidebarLiveForTest();
    __resetRunPanelForTest();
});

describe("run panel focus", () => {
    test("with no active run the panel is invisible and holds nothing", async () => {
        await refreshSidebarData("analysis-1", seamsFor([]));
        expect(focusedRun()).toBeNull();
        expect(runPanelVisible()).toBe(false);
        expect(activeRunCount()).toBe(0);
        expect(focusedRunPosition()).toBe(0);
    });

    test("with one active run it focuses that run without being asked", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
        expect(focusedRun()?.runId).toBe("run-a");
        expect(runPanelVisible()).toBe(true);
        expect(activeRunCount()).toBe(1);
        expect(focusedRunPosition()).toBe(1);
    });

    test("navigation cycles across concurrent runs and wraps past the last", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" }), runRow({ runId: "run-c" })]));
        expect(focusedRun()?.runId).toBe("run-a");
        expect(focusedRunPosition()).toBe(1);

        focusNextRun();
        expect(focusedRun()?.runId).toBe("run-b");
        expect(focusedRunPosition()).toBe(2);

        focusNextRun();
        expect(focusedRun()?.runId).toBe("run-c");
        expect(focusedRunPosition()).toBe(3);

        // Wrap.
        focusNextRun();
        expect(focusedRun()?.runId).toBe("run-a");
        expect(focusedRunPosition()).toBe(1);
    });

    test("runs of different plans are both reachable", async () => {
        const runs = [runRow({ runId: "run-a", planId: "plan-1" }), runRow({ runId: "run-b", planId: "plan-2" })];
        await refreshSidebarData("analysis-1", seamsFor(runs));
        expect(activeRunCount()).toBe(2);
        focusNextRun();
        expect(focusedRun()?.runId).toBe("run-b");
    });

    test("the focused run terminating auto-advances to the run still active", async () => {
        const both = [runRow({ runId: "run-a" }), runRow({ runId: "run-b" })];
        await refreshSidebarData("analysis-1", seamsFor(both));
        expect(focusedRun()?.runId).toBe("run-a");

        // run-a completes; the next refresh drops it from the active set. No user action, no effect —
        // the derived focus simply stops resolving and falls through to the survivor.
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a", status: "completed" }), runRow({ runId: "run-b" })]));
        expect(focusedRun()?.runId).toBe("run-b");
        expect(activeRunCount()).toBe(1);
        expect(runPanelVisible()).toBe(true);
    });

    test("the last run finishing empties the panel", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
        expect(runPanelVisible()).toBe(true);
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a", status: "completed" })]));
        expect(focusedRun()).toBeNull();
        expect(runPanelVisible()).toBe(false);
    });

    test("advancing steps from the run on screen, not from a stale preference", async () => {
        const three = [runRow({ runId: "run-a" }), runRow({ runId: "run-b" }), runRow({ runId: "run-c" })];
        await refreshSidebarData("analysis-1", seamsFor(three));
        focusNextRun(); // → run-b, the stored preference
        expect(focusedRun()?.runId).toBe("run-b");

        // run-b terminates. The panel shows run-a (first survivor); the STORED preference is still
        // run-b. Advancing must go to run-c — the run after the one being looked at — rather than to
        // whatever follows the dead preference.
        await refreshSidebarData(
            "analysis-1",
            seamsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b", status: "failed" }), runRow({ runId: "run-c" })]),
        );
        expect(focusedRun()?.runId).toBe("run-a");
        focusNextRun();
        expect(focusedRun()?.runId).toBe("run-c");
    });

    test("a step-read blip keeps the run focused and marks it stale rather than advancing", async () => {
        const both = [runRow({ runId: "run-a" }), runRow({ runId: "run-b" })];
        await refreshSidebarData("analysis-1", seamsFor(both));
        expect(focusedRun()?.stale).toBe(false);

        await refreshSidebarData("analysis-1", seamsFor(both, { failStepsFor: new Set(["run-a"]) }));
        // Still run-a, still visible — a blip must never read as completion.
        expect(focusedRun()?.runId).toBe("run-a");
        expect(focusedRun()?.stale).toBe(true);
        expect(runPanelVisible()).toBe(true);

        // And it recovers on the next good read.
        await refreshSidebarData("analysis-1", seamsFor(both));
        expect(focusedRun()?.stale).toBe(false);
    });
});

describe("run panel dismissal", () => {
    test("dismissing hides the panel while leaving the run untouched", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
        toggleRunPanel();
        expect(runPanelVisible()).toBe(false);
        // The run itself is untouched: it is still active, still focused, still in the rail's snapshot.
        expect(focusedRun()?.runId).toBe("run-a");
        expect(activeRunCount()).toBe(1);
    });

    test("restore is not a toggle — twice in a row leaves the panel visible", async () => {
        // This is what makes the palette entry safe to expose beside the chord. A user reaches the
        // palette precisely because they lost the panel; if the command toggled, a second invocation
        // (or one issued while the panel was already back) would hide it again and read as the
        // command having done nothing.
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
        toggleRunPanel();
        expect(runPanelVisible()).toBe(false);
        restoreRunPanel();
        restoreRunPanel();
        restoreRunPanel();
        expect(runPanelVisible()).toBe(true);
    });

    test("restore brings it back, and is idempotent when already visible", async () => {
        await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
        toggleRunPanel();
        expect(runPanelVisible()).toBe(false);
        restoreRunPanel();
        expect(runPanelVisible()).toBe(true);
        restoreRunPanel();
        expect(runPanelVisible()).toBe(true);
    });

    test("a dismissal expires once no run is active, so a later run is not silently invisible", async () => {
        await createRoot(async (dispose) => {
            watchRunPanel(panelSeams(null));
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            toggleRunPanel();
            expect(runPanelVisible()).toBe(false);

            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a", status: "completed" })]));
            // Nothing active → the dismissal has no referent left, so it clears.
            expect(runPanelVisible()).toBe(false); // still nothing to show
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-b" })]));
            expect(runPanelVisible()).toBe(true);
            dispose();
        });
    });
});

describe("run panel activity label", () => {
    test("the focused run's activity is read and published", async () => {
        await createRoot(async (dispose) => {
            watchRunPanel(panelSeams("tool bash"));
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            // The read is async; let its microtask settle.
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedRunActivity()).toBe("tool bash");
            dispose();
        });
    });

    test("an unresolvable label is null, never a fabricated placeholder", async () => {
        await createRoot(async (dispose) => {
            watchRunPanel(panelSeams(null));
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedRunActivity()).toBeNull();
            dispose();
        });
    });

    test("no active run clears the label rather than leaving the last run's showing", async () => {
        await createRoot(async (dispose) => {
            watchRunPanel(panelSeams("tool bash"));
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedRunActivity()).toBe("tool bash");

            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a", status: "completed" })]));
            expect(focusedRunActivity()).toBeNull();
            dispose();
        });
    });
});
