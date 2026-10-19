import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { okAsync, errAsync, ResultAsync } from "neverthrow";
import type { StepActivityPart } from "@inflexa-ai/harness/contracts/index.js";

import type { CancelRunResult, DataProfileState, DataProfileView, RunDetail, RunSummary } from "../../api/runs.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import { __pendingNoticeCountForTest, __resetNoticesForTest, currentNotice } from "./notice.ts";
import { __resetRunCompletionsForTest, watchRunCompletions } from "./run_completion.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type ActiveRunProgress, type RefreshOpts } from "./sidebar_live.ts";
import {
    __resetActivityPanelForTest,
    abortFocusedRun,
    activeSubjectCount,
    focusedSubject,
    focusedSubjectActivity,
    focusedSubjectPosition,
    focusNextSubject,
    restoreActivityPanel,
    activityPanelVisible,
    toggleActivityPanel,
    watchActivityPanel,
    type ActivityPanelOpts,
    type RunAbortOpts,
    type RunAbortTarget,
} from "./activity_panel.ts";

// The panel store owns three things: which SUBJECT is focused, whether the panel is dismissed, and the
// focused subject's activity label. The load-bearing decision under test is that the focused subject is
// DERIVED from the live active set rather than stored — which is what makes auto-advance fall out
// with no fix-up effect, and what makes navigation step from the subject actually on screen.
//
// A subject is a run OR the analysis's data profile, and every behaviour here is asserted over both:
// the two kinds differ in what they carry (a profile has no steps and no denominator) and in how their
// activity stream is addressed (a run's stream is its run id; a profile's is the workflow id its ledger
// row records), so a behaviour that holds for a run is not thereby proven for a profile.

function runRow(over: Partial<RunSummary> & { runId: string }): RunSummary {
    return {
        threadId: null,
        planId: null,
        workflowName: "executeAnalysis",
        workflowId: over.runId,
        status: "running",
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        error: null,
        ...over,
    };
}

/** The run as `GET {A}/run/:runId` gives it: one running step. */
function runDetail(run: RunSummary): RunDetail {
    return {
        ...run,
        steps: [
            {
                stepId: "T1S1",
                agentId: "bioinformatician",
                status: "running",
                startedAt: "2026-07-28T10:00:01.000Z",
                completedAt: null,
                durationMs: null,
                error: null,
                attempts: 1,
                blockedReason: null,
            },
        ],
        plan: null,
        unattributedUsage: null,
    };
}

/**
 * The workflow id a profile's ledger row records — the stream the panel subscribes to for a profile.
 *
 * Deliberately unlike {@link PROFILE_PART_RUN_ID}, the identifier the profile's own parts carry: the
 * two are different values in production, and a fixture that let them coincide could not tell a store
 * that keys activity on the part's field from one that does not.
 */
const PROFILE_WORKFLOW_ID = "wf-profile-1";

/**
 * A `running` data-profile row — the only shape the refresh publishes as a panel subject. A `pending`
 * row carries no `startedAt` and no workflow id, so it has nothing to show and is deliberately not
 * published (that half of the decision is pinned in `sidebar_live.test.ts`).
 */
function profileRow(over: Partial<DataProfileState> = {}): DataProfileState {
    return {
        status: "running",
        error: null,
        startedAt: "2026-07-28T10:00:00.000Z",
        completedAt: null,
        result: null,
        workflowId: PROFILE_WORKFLOW_ID,
        seedInputFileIds: ["input-1"],
        ...over,
    };
}

/** A client error, for a read that fails. */
const READ_FAILED: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:0", cause: "boom" };

/** Refresh options over a fixed set of runs (plus an optional profile row); every run reports one running step. */
function optsFor(runs: RunSummary[], opts: { failRunFor?: Set<string>; profile?: DataProfileState | null } = {}): RefreshOpts {
    const view: DataProfileView = opts.profile ?? { status: null };
    return {
        ready: () => true,
        loadProfile: () => okAsync(view),
        loadRuns: () => okAsync(runs),
        loadActiveRuns: () => okAsync(runs),
        loadRun: (_analysisId, runId) => {
            const run = runs.find((r) => r.runId === runId);
            return run === undefined || opts.failRunFor?.has(runId) ? errAsync(READ_FAILED) : okAsync(runDetail(run));
        },
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

/**
 * The identifier a data-profile workflow stamps on every part it emits, and the step id of the single
 * synthetic step it reports under.
 *
 * Copied literals rather than imports: the harness keeps both private to the workflow body precisely
 * because nothing downstream may key on them — its contract states that consumers must not — so there
 * is no export to reach for, and a test that invented its own value would stop describing production.
 * `data-profile` is the SAME string for every analysis, which is the whole reason the panel cannot use
 * it to attribute activity.
 */
const PROFILE_PART_RUN_ID = "data-profile";
const PROFILE_PART_STEP_ID = "profile";

/** A profile's `data-step-activity` part: the workflow's constant frame, carrying one reported phrase. */
function profileActivityPart(activity: string, over: Partial<StepActivityPart> = {}): StepActivityPart {
    return activityPart(PROFILE_PART_RUN_ID, activity, { stepId: PROFILE_PART_STEP_ID, ...over });
}

/**
 * The focused subject's run, or `null` when nothing is focused OR a profile is.
 *
 * Focus is a subject union, so every assertion that names a run id is also asserting the focus is on a
 * RUN. Folding the kind check in here keeps that half of the claim from being silently dropped at each
 * site: a focus that slid onto the profile reads as `null` rather than passing on the id alone.
 */
function focusedRunSubject(): ActiveRunProgress | null {
    const subject = focusedSubject();
    return subject?.kind === "run" ? subject.run : null;
}

/**
 * A workspace whose open analysis a test can swap. The panel reads only `analysis.id`, thus a store
 * with that one field stands in for the whole workspace.
 */
function workspaceOn(analysisId: string): { ws: Workspace; open: (id: string) => void } {
    const [store, setStore] = createStore({ analysis: { id: analysisId } });
    return { ws: store as unknown as Workspace, open: (id) => setStore("analysis", { id }) };
}

/** The workspace of each test that does not swap analyses. */
const WS = workspaceOn("analysis-1").ws;

/** One subscription the fake opened. Kept after teardown, so a test can fire a LATE part at it. */
type OpenedSubscription = {
    readonly analysisId: string;
    readonly runId: string;
    /** Hand a part to THIS subscription's handler, whether or not it has been torn down. */
    readonly deliver: (part: StepActivityPart) => void;
    aborted: boolean;
};

/** Panel options whose subscription is a push channel the test drives. */
type FakePanelOpts = ActivityPanelOpts & {
    /** Deliver a part to whichever subscription is currently live (a no-op when none is). */
    push: (part: StepActivityPart) => void;
    /** Every subscription opened, in order, torn-down ones included. */
    opened: () => readonly OpenedSubscription[];
    /** The run currently subscribed, or `null` when none is. */
    subscribed: () => string | null;
};

/**
 * Panel options over a fake run stream.
 *
 * `initial` stands in for the replay the real stream performs on attach — the current activity a
 * subscriber joining mid-run receives immediately — and `null` means the run has reported none yet.
 * `push` then drives further updates, which is what lets a test assert the label CHANGING rather
 * than only the value it opened on.
 */
function panelOpts(initial: string | null): FakePanelOpts {
    const opened: OpenedSubscription[] = [];
    return {
        ready: () => true,
        subscribeActivity: async (options) => {
            const entry: OpenedSubscription = { analysisId: options.analysisId, runId: options.runId, deliver: options.onActivity, aborted: false };
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
            // The real stream delivers asynchronously, so the handler never runs synchronously inside
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
    __resetRunCompletionsForTest();
    __resetNoticesForTest();
    __resetActivityPanelForTest();
});

describe("activity panel focus", () => {
    test("with no active subject the panel is invisible and holds nothing", async () => {
        await refreshSidebarData("analysis-1", optsFor([]));
        expect(focusedSubject()).toBeNull();
        expect(activityPanelVisible()).toBe(false);
        expect(activeSubjectCount()).toBe(0);
        expect(focusedSubjectPosition()).toBe(0);
    });

    test("with one active run it focuses that run without being asked", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        expect(focusedRunSubject()?.runId).toBe("run-a");
        expect(activityPanelVisible()).toBe(true);
        expect(activeSubjectCount()).toBe(1);
        expect(focusedSubjectPosition()).toBe(1);
    });

    test("navigation cycles across concurrent runs and wraps past the last", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" }), runRow({ runId: "run-c" })]));
        expect(focusedRunSubject()?.runId).toBe("run-a");
        expect(focusedSubjectPosition()).toBe(1);

        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-b");
        expect(focusedSubjectPosition()).toBe(2);

        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-c");
        expect(focusedSubjectPosition()).toBe(3);

        // Wrap.
        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-a");
        expect(focusedSubjectPosition()).toBe(1);
    });

    test("runs of different plans are both reachable", async () => {
        const runs = [runRow({ runId: "run-a", planTitle: "Plan one" }), runRow({ runId: "run-b", planTitle: "Plan two" })];
        await refreshSidebarData("analysis-1", optsFor(runs));
        expect(activeSubjectCount()).toBe(2);
        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-b");
    });

    test("the focused run terminating auto-advances to the run still active", async () => {
        const both = [runRow({ runId: "run-a" }), runRow({ runId: "run-b" })];
        await refreshSidebarData("analysis-1", optsFor(both));
        expect(focusedRunSubject()?.runId).toBe("run-a");

        // run-a completes; the next refresh drops it from the active set. No user action, no effect —
        // the derived focus simply stops resolving and falls through to the survivor.
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed" }), runRow({ runId: "run-b" })]));
        expect(focusedRunSubject()?.runId).toBe("run-b");
        expect(activeSubjectCount()).toBe(1);
        expect(activityPanelVisible()).toBe(true);
    });

    test("the last run finishing empties the panel", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        expect(activityPanelVisible()).toBe(true);
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed" })]));
        expect(focusedRunSubject()).toBeNull();
        expect(activityPanelVisible()).toBe(false);
    });

    test("advancing steps from the run on screen, not from a stale preference", async () => {
        const three = [runRow({ runId: "run-a" }), runRow({ runId: "run-b" }), runRow({ runId: "run-c" })];
        await refreshSidebarData("analysis-1", optsFor(three));
        focusNextSubject(); // → run-b, the stored preference
        expect(focusedRunSubject()?.runId).toBe("run-b");

        // run-b terminates. The panel shows run-a (first survivor); the STORED preference is still
        // run-b. Advancing must go to run-c — the run after the one being looked at — rather than to
        // whatever follows the dead preference.
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b", status: "failed" }), runRow({ runId: "run-c" })]));
        expect(focusedRunSubject()?.runId).toBe("run-a");
        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-c");
    });

    test("a run-read blip keeps the run focused and marks it stale rather than advancing", async () => {
        const both = [runRow({ runId: "run-a" }), runRow({ runId: "run-b" })];
        await refreshSidebarData("analysis-1", optsFor(both));
        expect(focusedRunSubject()?.stale).toBe(false);

        await refreshSidebarData("analysis-1", optsFor(both, { failRunFor: new Set(["run-a"]) }));
        // Still run-a, still visible — a blip must never read as completion.
        expect(focusedRunSubject()?.runId).toBe("run-a");
        expect(focusedRunSubject()?.stale).toBe(true);
        expect(activityPanelVisible()).toBe(true);

        // And it recovers on the next good read.
        await refreshSidebarData("analysis-1", optsFor(both));
        expect(focusedRunSubject()?.stale).toBe(false);
    });
});

describe("activity panel focus across subject kinds", () => {
    test("navigation moves between a run and the profile, wrapping past the last", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })], { profile: profileRow() }));
        expect(activeSubjectCount()).toBe(2);
        // The run leads the set by kind, not by recency — a profile can enter without the user having
        // asked for anything, so it is reachable without ever being the thing on screen.
        expect(focusedSubject()?.kind).toBe("run");
        expect(focusedSubjectPosition()).toBe(1);

        focusNextSubject();
        const subject = focusedSubject();
        expect(subject?.kind).toBe("profile");
        // The open analysis's own profile, not an empty shell of the right kind.
        expect(subject?.kind === "profile" ? subject.profile.analysisId : null).toBe("analysis-1");
        expect(focusedSubjectPosition()).toBe(2);
        expect(activeSubjectCount()).toBe(2);

        // Wrap: the set of two is a cycle, exactly as a set of runs is.
        focusNextSubject();
        expect(focusedSubject()?.kind).toBe("run");
        expect(focusedSubjectPosition()).toBe(1);
    });

    test("the focused profile terminating auto-advances to the run still active", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })], { profile: profileRow() }));
        focusNextSubject();
        expect(focusedSubject()?.kind).toBe("profile");

        // Driven by changing what the STORE PUBLISHES — a row that has left `running` publishes no
        // profile entry — with no writer and no fix-up effect anywhere. That is the whole point of
        // focus being derived: the preference simply stops resolving and the memo falls to the
        // survivor, so auto-advance has no code of its own to get wrong.
        await refreshSidebarData(
            "analysis-1",
            optsFor([runRow({ runId: "run-a" })], { profile: profileRow({ status: "completed", completedAt: "2026-07-28T10:01:00.000Z" }) }),
        );
        expect(focusedSubject()?.kind).toBe("run");
        expect(focusedRunSubject()?.runId).toBe("run-a");
        expect(activeSubjectCount()).toBe(1);
        expect(focusedSubjectPosition()).toBe(1);
        expect(activityPanelVisible()).toBe(true);
    });

    test("a profile finishing with nothing else active empties the panel", async () => {
        await refreshSidebarData("analysis-1", optsFor([], { profile: profileRow() }));
        expect(focusedSubject()?.kind).toBe("profile");
        expect(activityPanelVisible()).toBe(true);

        await refreshSidebarData(
            "analysis-1",
            optsFor([], { profile: profileRow({ status: "failed", completedAt: "2026-07-28T10:01:00.000Z", error: "boom" }) }),
        );
        // A failed profile is as terminal as a completed one: the panel takes no rows either way.
        expect(focusedSubject()).toBeNull();
        expect(activeSubjectCount()).toBe(0);
        expect(focusedSubjectPosition()).toBe(0);
        expect(activityPanelVisible()).toBe(false);
    });
});

describe("activity panel dismissal", () => {
    test("dismissing hides the panel while leaving the run untouched", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        toggleActivityPanel();
        expect(activityPanelVisible()).toBe(false);
        // The run itself is untouched: it is still active, still focused, still in the rail's snapshot.
        expect(focusedRunSubject()?.runId).toBe("run-a");
        expect(activeSubjectCount()).toBe(1);
    });

    test("restore is not a toggle — twice in a row leaves the panel visible", async () => {
        // This is what makes the palette entry safe to expose beside the chord. A user reaches the
        // palette precisely because they lost the panel; if the command toggled, a second invocation
        // (or one issued while the panel was already back) would hide it again and read as the
        // command having done nothing.
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        toggleActivityPanel();
        expect(activityPanelVisible()).toBe(false);
        restoreActivityPanel();
        restoreActivityPanel();
        restoreActivityPanel();
        expect(activityPanelVisible()).toBe(true);
    });

    test("restore brings it back, and is idempotent when already visible", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        toggleActivityPanel();
        expect(activityPanelVisible()).toBe(false);
        restoreActivityPanel();
        expect(activityPanelVisible()).toBe(true);
        restoreActivityPanel();
        expect(activityPanelVisible()).toBe(true);
    });

    test("a dismissal expires once no run is active, so a later run is not silently invisible", async () => {
        await createRoot(async (dispose) => {
            watchActivityPanel(WS, panelOpts(null));
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            toggleActivityPanel();
            expect(activityPanelVisible()).toBe(false);

            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed" })]));
            // Nothing active → the dismissal has no referent left, so it clears.
            expect(activityPanelVisible()).toBe(false); // still nothing to show
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-b" })]));
            expect(activityPanelVisible()).toBe(true);
            dispose();
        });
    });
});

describe("activity panel activity label", () => {
    test("the focused run's activity is published verbatim", async () => {
        await createRoot(async (dispose) => {
            watchActivityPanel(WS, panelOpts("Running script deseq2.R"));
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            // Delivery is async; let its microtask settle.
            await Promise.resolve();
            await Promise.resolve();
            // Passed through untouched: the harness already emits a human phrase, so any re-mapping
            // here could only degrade it.
            expect(focusedSubjectActivity()).toBe("Running script deseq2.R");
            dispose();
        });
    });

    test("the label follows the agent's work across successive tool calls", async () => {
        // The defect this pins: every other test in this suite drives ONE label for the life of the
        // subscription, so a store that latched its first value — or that only ever read once per
        // focused run — passed the whole suite while the live panel showed a phrase from minutes ago.
        await createRoot(async (dispose) => {
            const panel = panelOpts("Running script deseq2.R");
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedSubjectActivity()).toBe("Running script deseq2.R");

            // No new run data, no re-focus — only the stream moving on, which is the whole point of
            // taking the label from it.
            panel.push(activityPart("run-a", "Reading counts.csv"));
            expect(focusedSubjectActivity()).toBe("Reading counts.csv");

            panel.push(activityPart("run-a", "Writing volcano.png"));
            expect(focusedSubjectActivity()).toBe("Writing volcano.png");
            dispose();
        });
    });

    test("an unresolvable label is null, never a fabricated placeholder", async () => {
        await createRoot(async (dispose) => {
            watchActivityPanel(WS, panelOpts(null));
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedSubjectActivity()).toBeNull();
            dispose();
        });
    });

    test("a step that has settled stops describing work, rather than freezing on its last phrase", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts("Running script deseq2.R");
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedSubjectActivity()).toBe("Running script deseq2.R");

            // The step's own terminal report. The run is still active (the next step has not spoken
            // yet), so the panel stays — but with no activity line, which is the honest reading.
            panel.push(activityPart("run-a", "Step complete", { phase: "complete" }));
            expect(focusedSubjectActivity()).toBeNull();
            expect(activityPanelVisible()).toBe(true);
            dispose();
        });
    });

    test("with two steps in flight the newest report wins", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts(null);
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();

            panel.push(activityPart("run-a", "Running script qc.R", { stepId: "T1S1" }));
            panel.push(activityPart("run-a", "Running script enrich.R", { stepId: "T2S1" }));
            expect(focusedSubjectActivity()).toBe("Running script enrich.R");

            // The older step speaking again makes it the newest report — a `Map` keeps a key's
            // original slot on overwrite, so this is what proves the store re-orders on re-report
            // instead of latching whichever step happened to be heard from last.
            panel.push(activityPart("run-a", "Plotting qc metrics", { stepId: "T1S1" }));
            expect(focusedSubjectActivity()).toBe("Plotting qc metrics");

            // And a settled step drops out of the running, leaving the other one's phrase.
            panel.push(activityPart("run-a", "Step complete", { stepId: "T1S1", phase: "complete" }));
            expect(focusedSubjectActivity()).toBe("Running script enrich.R");
            dispose();
        });
    });

    test("no active run clears the label rather than leaving the last run's showing", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts("Running script deseq2.R");
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedSubjectActivity()).toBe("Running script deseq2.R");

            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed" })]));
            expect(focusedSubjectActivity()).toBeNull();
            // The run terminating is a teardown edge, not just a focus one.
            expect(panel.subscribed()).toBeNull();
            dispose();
        });
    });
});

describe("activity panel activity subscription", () => {
    test("one subscription per focused run, held across the sidebar's poll", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts("Running script deseq2.R");
            watchActivityPanel(WS, panel);
            const runs = [runRow({ runId: "run-a" })];
            await refreshSidebarData("analysis-1", optsFor(runs));
            await Promise.resolve();
            expect(panel.opened()).toHaveLength(1);

            // Each refresh mints a FRESH progress object for the same run. Re-subscribing on that
            // would replay the run's whole history every poll tick, for a run that has not changed.
            await refreshSidebarData("analysis-1", optsFor(runs));
            await refreshSidebarData("analysis-1", optsFor(runs));
            await Promise.resolve();
            expect(panel.opened()).toHaveLength(1);
            expect(panel.subscribed()).toBe("run-a");
            dispose();
        });
    });

    test("the subscription is opened under the open analysis, and again under the next one after a swap", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts(null);
            const { ws, open } = workspaceOn("analysis-1");
            watchActivityPanel(ws, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            expect(panel.opened().map((s) => [s.analysisId, s.runId])).toEqual([["analysis-1", "run-a"]]);

            // The stream route lives under the analysis, so a swap re-opens the stream under the new one
            // and tears the old one down — even before the sidebar republishes the new analysis's runs.
            open("analysis-2");
            expect(panel.opened().map((s) => [s.analysisId, s.runId, s.aborted])).toEqual([
                ["analysis-1", "run-a", true],
                ["analysis-2", "run-a", false],
            ]);
            dispose();
        });
    });

    test("moving focus tears the old subscription down and opens one on the new run", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts("Running script deseq2.R");
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
            await Promise.resolve();
            expect(panel.subscribed()).toBe("run-a");

            focusNextSubject();
            expect(panel.opened()).toHaveLength(2);
            expect(panel.opened()[0]?.aborted).toBe(true);
            expect(panel.subscribed()).toBe("run-b");
            // The previous run's phrase must not survive the switch — the panel would be captioning
            // run-b with run-a's work.
            expect(focusedSubjectActivity()).toBeNull();
            dispose();
        });
    });

    test("a part arriving after teardown cannot overwrite the newer run's label", async () => {
        // Teardown is best-effort by construction: the durability engine's reader can be suspended
        // inside an await when it is asked to wind down, so a part CAN arrive after the abort. The
        // generation token is what makes that harmless, and this drives exactly that race.
        await createRoot(async (dispose) => {
            const panel = panelOpts(null);
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
            await Promise.resolve();
            const stale = panel.opened()[0];

            focusNextSubject();
            panel.push(activityPart("run-b", "Running script enrich.R"));
            expect(focusedSubjectActivity()).toBe("Running script enrich.R");

            stale?.deliver(activityPart("run-a", "Running script qc.R"));
            expect(focusedSubjectActivity()).toBe("Running script enrich.R");
            dispose();
        });
    });

    test("unmounting the screen tears the subscription down", async () => {
        const panel = panelOpts("Running script deseq2.R");
        await createRoot(async (dispose) => {
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            expect(panel.subscribed()).toBe("run-a");
            dispose();
        });
        expect(panel.opened()[0]?.aborted).toBe(true);
    });

    test("no subscription is opened while the runtime is not booted", async () => {
        await createRoot(async (dispose) => {
            const panel: FakePanelOpts = { ...panelOpts("Running script deseq2.R"), ready: () => false };
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
            await Promise.resolve();
            expect(panel.opened()).toHaveLength(0);
            expect(focusedSubjectActivity()).toBeNull();
            dispose();
        });
    });
});

describe("activity panel activity for a focused profile", () => {
    test("the label follows the profiler's work across successive reports", async () => {
        // A profile's live path end to end, and the one place the two kinds genuinely differ: the
        // stream is addressed by the workflow id the ledger row records rather than by the subject's
        // own identity.
        await createRoot(async (dispose) => {
            // No initial part. A profile's first report lands after the panel has subscribed, and
            // starting from nothing is what makes the two pushes below two OBSERVED changes rather
            // than one change away from whatever the stream handed over at attach.
            const panel = panelOpts(null);
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([], { profile: profileRow() }));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedSubject()?.kind).toBe("profile");
            expect(panel.subscribed()).toBe(PROFILE_WORKFLOW_ID);
            expect(focusedSubjectActivity()).toBeNull();

            // The profiler's real opening sequence: the sandbox wait, which precedes its agent
            // entirely, then a tool call the agent makes. Two DIFFERENT phrases, asserted as two
            // different values — a store that latched its first report, or that read the stream once
            // per focused subject, would satisfy a constant-label test while the panel showed a line
            // frozen minutes ago.
            panel.push(profileActivityPart("Starting sandbox", { phase: "sandbox-init" }));
            expect(focusedSubjectActivity()).toBe("Starting sandbox");

            panel.push(profileActivityPart("Reading counts.csv"));
            expect(focusedSubjectActivity()).toBe("Reading counts.csv");
            dispose();
        });
    });

    test("a profile whose row records no workflow id yet opens no stream and shows no activity", async () => {
        await createRoot(async (dispose) => {
            const panel = panelOpts("Starting sandbox");
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([], { profile: profileRow({ workflowId: null }) }));
            await Promise.resolve();
            await Promise.resolve();
            expect(focusedSubject()?.kind).toBe("profile");
            expect(panel.opened()).toHaveLength(0);
            expect(focusedSubjectActivity()).toBeNull();
            dispose();
        });
    });

    test("a part whose runId is not the focused subject's is surfaced anyway", async () => {
        // The invariant the DROPPED `part.runId` filter rests on. A profile's parts carry the constant
        // literal `data-profile` — the same string for every analysis — so a filter comparing that
        // field against the focused subject would discard every profile activity there has ever been;
        // and the comparison is redundant besides, because the subscription is scoped to one workflow,
        // so a delivered part belongs to the focused subject by construction. This test exists so that
        // re-adding the check fails a test instead of silently breaking profiles.
        await createRoot(async (dispose) => {
            const panel = panelOpts(null);
            watchActivityPanel(WS, panel);
            await refreshSidebarData("analysis-1", optsFor([], { profile: profileRow() }));
            await Promise.resolve();
            await Promise.resolve();
            expect(panel.subscribed()).toBe(PROFILE_WORKFLOW_ID);

            // Delivered on the focused subject's OWN subscription, carrying an identifier that matches
            // neither the stream it arrived on nor the analysis the focus keys on.
            const part = profileActivityPart("Reading counts.csv");
            expect(part.runId).not.toBe(PROFILE_WORKFLOW_ID);
            expect(part.runId).not.toBe("analysis-1");
            panel.push(part);
            expect(focusedSubjectActivity()).toBe("Reading counts.csv");
            dispose();
        });
    });
});

// The abort of the focused run. Every edge is injected, so each outcome is driven offline: the tests
// read the state the recorder collected (who was asked, what was canceled, which notices showed, which
// analyses were read again), never how many times a function ran.

/** The result of a cancel, canceled by this request with every ledger settled unless the test says otherwise. */
function cancelResult(runId: string, over: Partial<CancelRunResult> = {}): CancelRunResult {
    return {
        runId,
        workflowId: runId,
        outcome: "canceled",
        finalStatus: "canceled",
        converged: { steps: true, charge: true, mandate: true },
        ...over,
    };
}

/** What an abort did at its injected edges, in the order each edge was reached. */
type AbortRecord = {
    /** The runs the confirmation was opened for. */
    asked: RunAbortTarget[];
    /** The `(analysisId, runId)` pairs the cancel request went to. */
    canceled: [string, string][];
    notices: Notice[];
    /** The notices raised with `queue: true`, which wait behind the showing one. */
    queued: Notice[];
    /** The analyses whose runs were read again. */
    refreshed: string[];
};

/**
 * Abort options that record into `record`. `answer` decides each confirmation at once; a test that must
 * answer later passes `onAsk` and calls the `onAnswer` it receives. `cancel` defaults to the canceled
 * result of the asked run. `refresh` defaults to a recorder that reads nothing, so the rows that the test
 * seeded stay.
 */
function abortOpts(
    record: AbortRecord,
    cfg: {
        answer?: boolean;
        onAsk?: (run: RunAbortTarget, onAnswer: (confirmed: boolean) => void) => void;
        cancel?: (runId: string) => ResultAsync<CancelRunResult, ClientError>;
        refresh?: (analysisId: string) => Promise<void>;
    } = {},
): RunAbortOpts {
    return {
        confirm: (run, onAnswer) => {
            record.asked.push(run);
            if (cfg.onAsk) cfg.onAsk(run, onAnswer);
            else onAnswer(cfg.answer ?? true);
        },
        cancel: (analysisId, runId) => {
            record.canceled.push([analysisId, runId]);
            return cfg.cancel ? cfg.cancel(runId) : okAsync(cancelResult(runId));
        },
        refresh: async (analysisId) => {
            record.refreshed.push(analysisId);
            await cfg.refresh?.(analysisId);
        },
        notify: (notice, _durationMs, notifyOpts) => {
            (notifyOpts?.queue ? record.queued : record.notices).push(notice);
        },
    };
}

function newRecord(): AbortRecord {
    return { asked: [], canceled: [], notices: [], queued: [], refreshed: [] };
}

describe("activity panel abort", () => {
    test("a confirmed abort cancels the run, reads the runs again, and shows no second notice", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
        const record = newRecord();
        await abortFocusedRun("analysis-1", abortOpts(record));

        // The confirmation names the run by the label the panel shows.
        expect(record.asked).toEqual([{ runId: "run-a", name: "Differential expression" }]);
        expect(record.canceled).toEqual([["analysis-1", "run-a"]]);
        expect(record.refreshed).toEqual(["analysis-1"]);
        // The completion watcher announces the cancel; a notice here would say it twice.
        expect(record.notices).toEqual([]);
    });

    test("a canceled run with a ledger that did not settle gets a warning that names the ledger", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
        const record = newRecord();
        await abortFocusedRun(
            "analysis-1",
            abortOpts(record, {
                cancel: (runId) => okAsync(cancelResult(runId, { converged: { steps: false, charge: true, mandate: false } })),
            }),
        );

        expect(record.canceled).toEqual([["analysis-1", "run-a"]]);
        expect(record.refreshed).toEqual(["analysis-1"]);
        expect(record.notices).toEqual([{ kind: "warn", text: "Differential expression was canceled, but the step rows and the mandate did not settle." }]);
    });

    test("the names of the unsettled ledgers read as prose for one, two, and three names", async () => {
        const text = async (converged: CancelRunResult["converged"]): Promise<string | undefined> => {
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
            const record = newRecord();
            await abortFocusedRun("analysis-1", abortOpts(record, { cancel: (runId) => okAsync(cancelResult(runId, { converged })) }));
            return record.notices[0]?.text;
        };

        expect(await text({ steps: true, charge: false, mandate: true })).toBe("Differential expression was canceled, but the charge did not settle.");
        expect(await text({ steps: false, charge: true, mandate: false })).toBe(
            "Differential expression was canceled, but the step rows and the mandate did not settle.",
        );
        expect(await text({ steps: false, charge: false, mandate: false })).toBe(
            "Differential expression was canceled, but the step rows, the charge, and the mandate did not settle.",
        );
    });

    test("a cancel that stopped the workflow but left the run row running reports an unsettled row, not a finished run", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
        const record = newRecord();
        await abortFocusedRun(
            "analysis-1",
            abortOpts(record, { cancel: (runId) => okAsync(cancelResult(runId, { outcome: "canceled", finalStatus: "running" })) }),
        );

        expect(record.notices).toEqual([
            { kind: "error", text: "Differential expression did not settle: the workflow stopped, but the run row still shows running." },
        ]);
        expect(record.notices.map((notice) => notice.text).join(" ")).not.toContain("already finished");
        expect(record.queued).toEqual([]);
        expect(record.refreshed).toEqual(["analysis-1"]);
    });

    test("a canceled run that the refreshed runs do not hold gets no notice from the abort", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));

        const record = newRecord();
        await abortFocusedRun(
            "analysis-1",
            abortOpts(record, { refresh: (analysisId) => refreshSidebarData(analysisId, optsFor([runRow({ runId: "run-newer" })])) }),
        );

        expect(record.refreshed).toEqual(["analysis-1"]);
        expect(record.notices).toEqual([]);
        expect(record.queued).toEqual([]);
    });

    test("a canceled run that the refreshed runs do not hold gets exactly one notice, from the watcher", async () => {
        await createRoot(async (dispose) => {
            const reads: [string, string][] = [];
            watchRunCompletions({
                loadRun: (analysisId, runId) => {
                    reads.push([analysisId, runId]);
                    return okAsync(
                        runDetail(runRow({ runId, status: "canceled", completedAt: "2026-07-28T10:01:00.000Z", planTitle: "Differential expression" })),
                    );
                },
            });
            // The watcher sees the run active, as the panel does.
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));

            const record = newRecord();
            await abortFocusedRun(
                "analysis-1",
                abortOpts(record, { refresh: (analysisId) => refreshSidebarData(analysisId, optsFor([runRow({ runId: "run-newer" })])) }),
            );
            // A later poll refreshes again and still misses the run.
            await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-newer" })]));
            for (let i = 0; i < 8; i++) await Promise.resolve();

            expect(record.notices).toEqual([]);
            expect(record.queued).toEqual([]);
            expect(reads).toEqual([["analysis-1", "run-a"]]);
            expect(currentNotice()).toEqual({ kind: "error", text: "Run Differential expression was canceled in 1m00s (0/1 steps)" });
            expect(__pendingNoticeCountForTest()).toBe(0);
            dispose();
        });
    });

    test("a declined confirmation sends nothing and changes nothing", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        const record = newRecord();
        await abortFocusedRun("analysis-1", abortOpts(record, { answer: false }));

        expect(record.asked.map((run) => run.runId)).toEqual(["run-a"]);
        expect(record.canceled).toEqual([]);
        expect(record.refreshed).toEqual([]);
        expect(record.notices).toEqual([]);
        expect(focusedRunSubject()?.runId).toBe("run-a");
    });

    test("a run that finished before the cancel is reported as finished with its status, not as aborted", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
        const record = newRecord();
        await abortFocusedRun(
            "analysis-1",
            abortOpts(record, {
                cancel: (runId) =>
                    okAsync(
                        cancelResult(runId, {
                            outcome: "already_terminal",
                            finalStatus: "completed",
                            converged: { steps: false, charge: false, mandate: false },
                        }),
                    ),
            }),
        );

        expect(record.notices).toEqual([{ kind: "info", text: "Differential expression already finished (completed), so nothing was aborted." }]);
        expect(record.refreshed).toEqual(["analysis-1"]);
    });

    test("a cancel that left the run in a status other than canceled is reported as finished with that status", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
        const record = newRecord();
        await abortFocusedRun(
            "analysis-1",
            abortOpts(record, { cancel: (runId) => okAsync(cancelResult(runId, { outcome: "canceled", finalStatus: "failed" })) }),
        );

        expect(record.notices).toEqual([{ kind: "info", text: "Differential expression already finished (failed), so nothing was aborted." }]);
        expect(record.refreshed).toEqual(["analysis-1"]);
    });

    test("the abort goes to the run the confirmation named, also after the panel moved to another run", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));
        expect(focusedRunSubject()?.runId).toBe("run-a");

        const record = newRecord();
        const answers: ((confirmed: boolean) => void)[] = [];
        const flow = abortFocusedRun(
            "analysis-1",
            abortOpts(record, {
                onAsk: (_run, onAnswer) => {
                    answers.push(onAnswer);
                },
            }),
        );

        // While the dialog is open run-a ends, and the panel advances to run-b.
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", status: "completed" }), runRow({ runId: "run-b" })]));
        expect(focusedRunSubject()?.runId).toBe("run-b");

        answers[0]?.(true);
        await flow;

        expect(record.asked.map((run) => run.runId)).toEqual(["run-a"]);
        expect(record.canceled).toEqual([["analysis-1", "run-a"]]);
    });

    test("a failed request shows an error notice with the cause, then reads the runs again", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a", planTitle: "Differential expression" })]));
        const record = newRecord();
        await abortFocusedRun("analysis-1", abortOpts(record, { cancel: () => errAsync(READ_FAILED) }));

        expect(record.notices).toEqual([{ kind: "error", text: `Could not abort Differential expression: ${describeClientError(READ_FAILED)}` }]);
        expect(record.refreshed).toEqual(["analysis-1"]);
    });

    test("a data profile has no abort: no confirmation opens and nothing is sent", async () => {
        await refreshSidebarData("analysis-1", optsFor([], { profile: profileRow() }));
        expect(focusedSubject()?.kind).toBe("profile");

        const record = newRecord();
        await abortFocusedRun("analysis-1", abortOpts(record));

        expect(record).toEqual(newRecord());
    });

    test("with no subject, or no open analysis, nothing happens", async () => {
        const record = newRecord();
        await abortFocusedRun("analysis-1", abortOpts(record));
        expect(record).toEqual(newRecord());

        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" })]));
        await abortFocusedRun(null, abortOpts(record));
        expect(record).toEqual(newRecord());
    });

    test("an open request for one run blocks a second confirmation for that run, not for a different run", async () => {
        await refreshSidebarData("analysis-1", optsFor([runRow({ runId: "run-a" }), runRow({ runId: "run-b" })]));

        // The cancel of run-a stays open until the test releases it.
        const held = Promise.withResolvers<void>();
        const requestOpen = Promise.withResolvers<void>();
        const record = newRecord();
        const opts = abortOpts(record, {
            cancel: (runId) => {
                if (runId !== "run-a") return okAsync(cancelResult(runId));
                requestOpen.resolve();
                return ResultAsync.fromSafePromise(held.promise.then(() => cancelResult(runId)));
            },
        });

        const first = abortFocusedRun("analysis-1", opts);
        await requestOpen.promise;

        // The same run again: no second confirmation.
        await abortFocusedRun("analysis-1", opts);
        expect(record.asked.map((run) => run.runId)).toEqual(["run-a"]);

        // A different run is not blocked.
        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-b");
        await abortFocusedRun("analysis-1", opts);
        expect(record.asked.map((run) => run.runId)).toEqual(["run-a", "run-b"]);
        expect(record.canceled).toEqual([
            ["analysis-1", "run-a"],
            ["analysis-1", "run-b"],
        ]);

        // The guard goes when the request settles: run-a can be aborted again.
        held.resolve();
        await first;
        focusNextSubject();
        expect(focusedRunSubject()?.runId).toBe("run-a");
        await abortFocusedRun("analysis-1", opts);
        expect(record.asked.map((run) => run.runId)).toEqual(["run-a", "run-b", "run-a"]);
    });
});
