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
import type { CortexRunRow, DataProfileStatus, StepActivityPart, StepExecutionRow } from "@inflexa-ai/harness";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// The panel store owns three things: which run is focused, whether the panel is dismissed, and the
// focused run's activity label. The load-bearing decision under test is that the focused run is
// DERIVED from the live active set rather than stored — which is what makes auto-advance fall out
// with no fix-up effect, and what makes navigation step from the run actually on screen.

// A fake pool: the store never touches it (the activity subscription is a seam), so an empty object
// typed through the runtime handle is sufficient.
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
        loadActiveRuns: () => okAsync(runs),
        loadSteps: (_pool, runId) => (opts.failStepsFor?.has(runId) ? errAsync({ type: "query_failed", cause: "boom" } as never) : okAsync([stepRow(runId)])),
        loadPlan: () => okAsync<unknown | null, never>(null),
    };
}

/**
 * A `data-step-activity` part, the only part the panel reads off the stream. `id` mirrors the
 * harness's per-`(runId, stepId)` reconciling id — the key its fold collapses a step's phase
 * transitions onto, so a subscriber receives one current frame per step rather than a replay.
 */
function activityPart(runId: string, activity: string, over: Partial<StepActivityPart> = {}): StepActivityPart {
    const stepId = over.stepId ?? "T1S1";
    return {
        type: "data-step-activity",
        id: `step-activity-${runId}-${stepId}`,
        runId,
        stepId,
        phase: "executing",
        activity,
        ...over,
    };
}

/** One subscription the fake seam opened. Kept after teardown, so a test can fire a LATE part at it. */
type OpenedSubscription = {
    readonly runId: string;
    /** Hand a part to THIS subscription's handler, whether or not it has been torn down. */
    readonly deliver: (part: StepActivityPart) => void;
    aborted: boolean;
};

/** Panel seams whose subscription is a push channel the test drives. */
type FakePanelSeams = RunPanelSeams & {
    /** Deliver a part to whichever subscription is currently live (a no-op when none is). */
    push: (part: StepActivityPart) => void;
    /** Every subscription opened, in order, torn-down ones included. */
    opened: () => readonly OpenedSubscription[];
    /** The run currently subscribed, or `null` when none is. */
    subscribed: () => string | null;
};

/**
 * Panel seams over a fake run-event subscription.
 *
 * `initial` stands in for the replay the real seam performs on attach — the current activity a
 * subscriber joining mid-run receives immediately — and `null` means the run has reported none yet.
 * `push` then drives further updates, which is what lets a test assert the label CHANGING rather
 * than only the value it opened on.
 */
function panelSeams(initial: string | null): FakePanelSeams {
    const opened: OpenedSubscription[] = [];
    return {
        runtime: () => fakeRuntime,
        subscribeActivity: async (_runtime, options) => {
            const entry: OpenedSubscription = { runId: options.runId, deliver: options.onActivity, aborted: false };
            opened.push(entry);
            const closed = new Promise<void>((resolve) => {
                options.signal.addEventListener(
                    "abort",
                    () => {
                        entry.aborted = true;
                        resolve();
                    },
                    { once: true },
                );
            });
            // The real seam delivers asynchronously, so the handler never runs synchronously inside
            // the effect that opened the subscription — mirror that, or the test would prove the
            // store correct under a schedule it never sees.
            await Promise.resolve();
            if (initial !== null) options.onActivity(activityPart(options.runId, initial));
            await closed;
        },
        push: (part) => {
            for (const entry of opened) if (!entry.aborted) entry.deliver(part);
        },
        opened: () => opened,
        subscribed: () => opened.find((s) => !s.aborted)?.runId ?? null,
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
    test("the focused run's activity is published verbatim", async () => {
        await createRoot(async (dispose) => {
            watchRunPanel(panelSeams("Running script deseq2.R"));
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            // Delivery is async; let its microtask settle.
            await Promise.resolve();
            await Promise.resolve();
            // Passed through untouched: the harness already emits a human phrase, so any re-mapping
            // here could only degrade it.
            expect(focusedRunActivity()).toBe("Running script deseq2.R");
            dispose();
        });
    });

    test("the label follows the agent's work across successive tool calls", async () => {
        // The defect this pins: every other test in this suite drives ONE label for the life of the
        // subscription, so a store that latched its first value — or that only ever read once per
        // focused run — passed the whole suite while the live panel showed a phrase from minutes ago.
        await createRoot(async (dispose) => {
            const seams = panelSeams("Running script deseq2.R");
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedRunActivity()).toBe("Running script deseq2.R");

            // No new run data, no re-focus — only the stream moving on, which is the whole point of
            // taking the label from it.
            seams.push(activityPart("run-a", "Reading counts.csv"));
            expect(focusedRunActivity()).toBe("Reading counts.csv");

            seams.push(activityPart("run-a", "Writing volcano.png"));
            expect(focusedRunActivity()).toBe("Writing volcano.png");
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

    test("a step that has settled stops describing work, rather than freezing on its last phrase", async () => {
        await createRoot(async (dispose) => {
            const seams = panelSeams("Running script deseq2.R");
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedRunActivity()).toBe("Running script deseq2.R");

            // The step's own terminal report. The run is still active (the next step has not spoken
            // yet), so the panel stays — but with no activity line, which is the honest reading.
            seams.push(activityPart("run-a", "Step complete", { phase: "complete" }));
            expect(focusedRunActivity()).toBeNull();
            expect(runPanelVisible()).toBe(true);
            dispose();
        });
    });

    test("with two steps in flight the newest report wins", async () => {
        await createRoot(async (dispose) => {
            const seams = panelSeams(null);
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();

            seams.push(activityPart("run-a", "Running script qc.R", { stepId: "T1S1" }));
            seams.push(activityPart("run-a", "Running script enrich.R", { stepId: "T2S1" }));
            expect(focusedRunActivity()).toBe("Running script enrich.R");

            // The older step speaking again makes it the newest report — a `Map` keeps a key's
            // original slot on overwrite, so this is what proves the store re-orders on re-report
            // instead of latching whichever step happened to be heard from last.
            seams.push(activityPart("run-a", "Plotting qc metrics", { stepId: "T1S1" }));
            expect(focusedRunActivity()).toBe("Plotting qc metrics");

            // And a settled step drops out of the running, leaving the other one's phrase.
            seams.push(activityPart("run-a", "Step complete", { stepId: "T1S1", phase: "complete" }));
            expect(focusedRunActivity()).toBe("Running script enrich.R");
            dispose();
        });
    });

    test("no active run clears the label rather than leaving the last run's showing", async () => {
        await createRoot(async (dispose) => {
            const seams = panelSeams("Running script deseq2.R");
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedRunActivity()).toBe("Running script deseq2.R");

            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a", status: "completed" })]));
            expect(focusedRunActivity()).toBeNull();
            // The run terminating is a teardown edge, not just a focus one.
            expect(seams.subscribed()).toBeNull();
            dispose();
        });
    });
});

describe("run panel activity subscription", () => {
    test("one subscription per focused run, held across the sidebar's poll", async () => {
        await createRoot(async (dispose) => {
            const seams = panelSeams("Running script deseq2.R");
            watchRunPanel(seams);
            const runs = [runRow({ runId: "run-a" })];
            await refreshSidebarData("analysis-1", seamsFor(runs));
            await Promise.resolve();
            expect(seams.opened()).toHaveLength(1);

            // Each refresh mints a FRESH progress object for the same run. Re-subscribing on that
            // would replay the run's whole history every poll tick, for a run that has not changed.
            await refreshSidebarData("analysis-1", seamsFor(runs));
            await refreshSidebarData("analysis-1", seamsFor(runs));
            await Promise.resolve();
            expect(seams.opened()).toHaveLength(1);
            expect(seams.subscribed()).toBe("run-a");
            dispose();
        });
    });

    test("moving focus tears the old subscription down and opens one on the new run", async () => {
        await createRoot(async (dispose) => {
            const seams = panelSeams("Running script deseq2.R");
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
            await Promise.resolve();
            expect(seams.subscribed()).toBe("run-a");

            focusNextRun();
            expect(seams.opened()).toHaveLength(2);
            expect(seams.opened()[0]?.aborted).toBe(true);
            expect(seams.subscribed()).toBe("run-b");
            // The previous run's phrase must not survive the switch — the panel would be captioning
            // run-b with run-a's work.
            expect(focusedRunActivity()).toBeNull();
            dispose();
        });
    });

    test("a part arriving after teardown cannot overwrite the newer run's label", async () => {
        // Teardown is best-effort by construction: the durability engine's reader can be suspended
        // inside an await when it is asked to wind down, so a part CAN arrive after the abort. The
        // generation token is what makes that harmless, and this drives exactly that race.
        await createRoot(async (dispose) => {
            const seams = panelSeams(null);
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
            await Promise.resolve();
            const stale = seams.opened()[0];

            focusNextRun();
            seams.push(activityPart("run-b", "Running script enrich.R"));
            expect(focusedRunActivity()).toBe("Running script enrich.R");

            stale?.deliver(activityPart("run-a", "Running script qc.R"));
            expect(focusedRunActivity()).toBe("Running script enrich.R");
            dispose();
        });
    });

    test("unmounting the screen tears the subscription down", async () => {
        const seams = panelSeams("Running script deseq2.R");
        await createRoot(async (dispose) => {
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            expect(seams.subscribed()).toBe("run-a");
            dispose();
        });
        expect(seams.opened()[0]?.aborted).toBe(true);
    });

    test("no subscription is opened while the runtime is not booted", async () => {
        await createRoot(async (dispose) => {
            const seams: FakePanelSeams = { ...panelSeams("Running script deseq2.R"), runtime: () => null };
            watchRunPanel(seams);
            await refreshSidebarData("analysis-1", seamsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            expect(seams.opened()).toHaveLength(0);
            expect(focusedRunActivity()).toBeNull();
            dispose();
        });
    });
});
