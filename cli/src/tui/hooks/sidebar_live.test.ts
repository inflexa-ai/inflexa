import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { err, ok, okAsync, errAsync, ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";

import { Bus } from "../../lib/bus.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import { createStore } from "solid-js/store";

// Side-effect import: installs `Date.relativeAge` (the loaded-profile timestamp lines call it) via the
// same central loader the app boots with.
import "../../extensions/index.ts";
import type { CortexRunRow, DataProfileStatus, DbError, StepExecutionRow } from "@inflexa-ai/harness";
import type { LlmUsageTotals } from "../../db/primary_query.ts";
import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, startHarnessBoot, type BootDriver } from "./boot.ts";
import { setChatStatus } from "./status.ts";
import {
    __resetSidebarLiveForTest,
    activeProfileProgress,
    activeRunProgress,
    activeSubjects,
    hasActiveWork,
    idTail,
    profileDetailLines,
    profileSnapshot,
    refreshSidebarData,
    RUN_STATUS_TERMINAL,
    runsSnapshot,
    watchSidebarData,
    type ProfileSnapshot,
    type RefreshSeams,
    type RunsSnapshot,
    type WatchSeams,
} from "./sidebar_live.ts";

afterEach(() => {
    __resetSidebarLiveForTest();
    __resetBootForTest();
    setChatStatus("idle");
});

// The refresh reads only `.pool` off the handle and the loads ignore it, so a partial stand-in cast
// keeps every test offline (no Postgres). Mirrors boot.test.ts's `fakeRuntime`.
const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;
const dbErr: DbError = { type: "query_failed", op: "test", cause: new Error("boom") };

function profileStatus(over: Partial<DataProfileStatus> = {}): DataProfileStatus {
    return {
        status: "completed",
        error: null,
        startedAt: "2026-07-08T00:00:00.000Z",
        completedAt: "2026-07-08T00:00:05.000Z",
        result: { summary: "s", files: [{ path: "a.csv", description: "d" }], profiledAt: "2026-07-08T00:00:05.000Z" },
        workflowId: null,
        seedInputFileIds: null,
        ...over,
    };
}

/**
 * A profile row in the one status that publishes a panel-subject entry. Honest ledger shape: a running
 * profile has no completion stamp and no result yet, and the base builder's defaults describe a
 * finished one — so the overrides are part of the fixture, not noise at each call site.
 */
function runningProfile(over: Partial<DataProfileStatus> = {}): DataProfileStatus {
    return profileStatus({ status: "running", startedAt: "2026-07-30T10:00:00.000Z", completedAt: null, result: null, workflowId: "wf-1", ...over });
}

function runRow(over: Partial<CortexRunRow> = {}): CortexRunRow {
    return {
        runId: "run-1",
        analysisId: "a1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "completed",
        startedAt: "2026-07-08T00:00:00.000Z",
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

/** Build refresh seams whose reads resolve immediately with the given data. Steps default to empty. */
function seams(
    profile: DataProfileStatus | null,
    runs: CortexRunRow[],
    runtime: () => HarnessRuntime | null = () => fakeRuntime,
    steps: StepExecutionRow[] = [],
): RefreshSeams {
    return {
        runtime,
        loadProfile: () => okAsync(profile),
        loadRuns: () => okAsync(runs),
        // Derived from the same rows, filtered to the non-terminal ones — what the real uncapped
        // active query returns. Echoing the whole list would let a fixture assert behaviour the
        // production seam cannot produce.
        loadActiveRuns: () => okAsync(runs.filter((r) => !RUN_STATUS_TERMINAL[r.status])),
        loadSteps: () => okAsync(steps),
        loadPlan: () => okAsync(null),
    };
}

/** A minimal step-execution row keyed by id + status — the refresh maps rows → step views via `stepStateOf`. */
function stepRow(stepId: string, status: StepExecutionRow["status"]): StepExecutionRow {
    return {
        runId: "run-1",
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

/** Mount `watchSidebarData` in a disposable reactive root; returns the dispose so the test tears it down. */
function mountWatch(ws: Workspace, watchSeams: WatchSeams): () => void {
    let dispose!: () => void;
    createRoot((d) => {
        dispose = d;
        watchSidebarData(ws, watchSeams);
    });
    return dispose;
}

// The watch reads only `workspace.analysis?.id`, so a partial stand-in cast is sound and keeps the
// trigger tests offline (no reactive store, no lock, no session).
function wsFor(id: string | null): Workspace {
    const analysis = id === null ? null : ({ id } as unknown as Workspace["analysis"]);
    return { analysis } as unknown as Workspace;
}

/** Build a `loaded` profile snapshot for the {@link profileDetailLines} composer tests. */
function loaded(over: Partial<DataProfileStatus> = {}, usage?: LlmUsageTotals): ProfileSnapshot {
    return {
        kind: "loaded",
        usage,
        profile: {
            status: "completed",
            error: null,
            startedAt: "2026-07-08T00:00:00.000Z",
            completedAt: "2026-07-08T00:00:05.000Z",
            result: {
                summary: "line one\nline two",
                files: [
                    { path: "data/counts.tsv", description: "raw counts" },
                    { path: "data/meta.csv", description: "sample metadata" },
                ],
                inputSignature: { count: 2, digest: "sig" },
                profiledAt: "2026-07-08T00:00:05.000Z",
            },
            workflowId: null,
            seedInputFileIds: ["i1", "i2", "i3"],
            ...over,
        },
    };
}

describe("refreshSidebarData — snapshot ladder", () => {
    test("no-ops to not_ready when the runtime is not booted, issuing no query", async () => {
        let profileReads = 0;
        let runReads = 0;
        let stepReads = 0;
        let planReads = 0;
        // Prime to a loaded state so the reset back to not_ready is observable.
        await refreshSidebarData("A", seams(profileStatus(), [runRow()]));
        expect(profileSnapshot().kind).toBe("loaded");

        const guarded: RefreshSeams = {
            runtime: () => null,
            loadProfile: () => {
                profileReads += 1;
                return okAsync(null);
            },
            loadRuns: () => {
                runReads += 1;
                return okAsync([]);
            },
            loadActiveRuns: () => {
                runReads += 1;
                return okAsync([]);
            },
            loadSteps: () => {
                stepReads += 1;
                return okAsync([]);
            },
            loadPlan: () => {
                planReads += 1;
                return okAsync(null);
            },
        };
        await refreshSidebarData("A", guarded);

        expect(profileSnapshot().kind).toBe("not_ready");
        expect(runsSnapshot().kind).toBe("not_ready");
        expect(profileReads).toBe(0);
        expect(planReads).toBe(0);
        expect(runReads).toBe(0);
        expect(stepReads).toBe(0);
    });

    test("a DbError degrades to unavailable, never a crash", async () => {
        const failing: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => errAsync(dbErr),
            loadRuns: () => errAsync(dbErr),
            loadActiveRuns: () => errAsync(dbErr),
            loadSteps: () => errAsync(dbErr),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", failing);
        expect(profileSnapshot().kind).toBe("unavailable");
        expect(runsSnapshot().kind).toBe("unavailable");
    });

    test("a null profile row is absent while runs still load", async () => {
        await refreshSidebarData("A", seams(null, [runRow()]));
        expect(profileSnapshot().kind).toBe("absent");
        const r = runsSnapshot();
        expect(r.kind).toBe("loaded");
        if (r.kind === "loaded") expect(r.runs).toHaveLength(1);
    });

    test("a present profile + runs load through", async () => {
        await refreshSidebarData("A", seams(profileStatus({ status: "completed" }), [runRow(), runRow({ runId: "run-2" })]));
        const p = profileSnapshot();
        expect(p.kind).toBe("loaded");
        if (p.kind === "loaded") expect(p.profile.status).toBe("completed");
        const r = runsSnapshot();
        expect(r.kind).toBe("loaded");
        if (r.kind === "loaded") expect(r.runs).toHaveLength(2);
    });
});

describe("refreshSidebarData — staleness guard", () => {
    test("a slow refresh for A does not clobber a later refresh for B", async () => {
        let releaseA!: (v: DataProfileStatus | null) => void;
        const gatedA: ResultAsync<DataProfileStatus | null, DbError> = ResultAsync.fromSafePromise(
            new Promise<DataProfileStatus | null>((res) => {
                releaseA = res;
            }),
        );
        const seamsA: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => gatedA,
            loadRuns: () => okAsync([runRow({ status: "running" })]),
            loadActiveRuns: () => okAsync([runRow({ status: "running" })]),
            loadSteps: () => okAsync([]),
            loadPlan: () => okAsync(null),
        };
        const seamsB = seams(profileStatus({ status: "completed" }), [runRow({ status: "completed" })]);

        const pA = refreshSidebarData("A", seamsA); // parks on the gated profile read
        await refreshSidebarData("B", seamsB); // starts + finishes; wins the store

        const afterB = profileSnapshot();
        expect(afterB.kind).toBe("loaded");
        if (afterB.kind === "loaded") expect(afterB.profile.status).toBe("completed");

        releaseA(profileStatus({ status: "running" })); // A now resolves — but it is stale
        await pA;

        const settled = profileSnapshot();
        expect(settled.kind).toBe("loaded");
        // B's completed profile survives; the superseded A drops rather than overwriting it.
        if (settled.kind === "loaded") expect(settled.profile.status).toBe("completed");
    });
});

// The runs LISTING is windowed to the newest N by `started_at DESC`, which drops the OLDEST running
// run first — precisely the long analysis these surfaces exist to keep visible. The uncapped active
// read is what makes that impossible; these pin the merge that consumes it.
describe("refreshSidebarData — an active run is never lost to the listing window", () => {
    test("a running run outside the newest-N window is still listed and still tracked", async () => {
        const longRunner = runRow({ runId: "run-old", status: "running", startedAt: "2026-07-28T09:00:00.000Z" });
        // The window holds only newer, finished runs — `run-old` has fallen off it entirely.
        const window = Array.from({ length: 10 }, (_, i) => runRow({ runId: `run-new-${i}`, status: "completed", startedAt: `2026-07-28T1${i}:00:00.000Z` }));
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync(window),
            loadActiveRuns: () => okAsync([longRunner]),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);

        const snap = runsSnapshot();
        expect(snap.kind).toBe("loaded");
        if (snap.kind !== "loaded") return;
        // Present in the listing despite being outside the window...
        expect(snap.runs.map((r) => r.runId)).toContain("run-old");
        // ...and, decisively, tracked — this is what the panel, the rail block, and the completion
        // announcement all read. Without the uncapped read this map is empty.
        expect(activeRunProgress().has("run-old")).toBe(true);
    });

    test("the merge does not duplicate a run present in both reads", async () => {
        const live = runRow({ runId: "run-a", status: "running" });
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([live, runRow({ runId: "run-b", status: "completed" })]),
            loadActiveRuns: () => okAsync([live]),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);

        const snap = runsSnapshot();
        if (snap.kind !== "loaded") throw new Error("expected loaded");
        expect(snap.runs.filter((r) => r.runId === "run-a")).toHaveLength(1);
        expect(snap.runs).toHaveLength(2);
    });

    test("a failed active read degrades to the window's own view rather than blanking the section", async () => {
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "run-a", status: "running" })]),
            loadActiveRuns: () => errAsync(dbErr),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);

        // Strictly the pre-existing behaviour: the window still lists and tracks what it can see. A
        // read that adds coverage must never be able to take coverage away.
        const snap = runsSnapshot();
        if (snap.kind !== "loaded") throw new Error("expected loaded");
        expect(snap.runs.map((r) => r.runId)).toEqual(["run-a"]);
        expect(activeRunProgress().has("run-a")).toBe(true);
    });

    test("a failed WINDOW read still lists and tracks what the active read found", async () => {
        // The mirror of the case above, and the one that matters more: the active read is the
        // AUTHORITY on what is live. Discarding it because the mere listing blipped would cost the
        // rail block, the panel entry, AND the completion announcement — which returns early unless
        // this snapshot is `loaded` — for a run positively known to be running.
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => errAsync(dbErr),
            loadActiveRuns: () => okAsync([runRow({ runId: "run-a", status: "running" })]),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);

        const snap = runsSnapshot();
        if (snap.kind !== "loaded") throw new Error("expected loaded, not unavailable");
        expect(snap.runs.map((r) => r.runId)).toEqual(["run-a"]);
        expect(activeRunProgress().has("run-a")).toBe(true);
    });

    test("only BOTH run reads failing degrades the section to unavailable", async () => {
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => errAsync(dbErr),
            loadActiveRuns: () => errAsync(dbErr),
            loadSteps: () => okAsync([]),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);
        expect(runsSnapshot().kind).toBe("unavailable");
    });
});

describe("refreshSidebarData — sticky run-progress row", () => {
    test("a non-terminal newest run publishes its progress (name, tag, done/total, mapped steps)", async () => {
        const steps = [stepRow("qc", "completed"), stepRow("align", "running"), stepRow("call", "pending")];
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "11112222-3333-4444-5555-6666aabbccdd", status: "running", workflowName: "executeAnalysis" })]),
            loadActiveRuns: () => okAsync([runRow({ runId: "11112222-3333-4444-5555-6666aabbccdd", status: "running", workflowName: "executeAnalysis" })]),
            loadSteps: () => okAsync(steps),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);
        const p = activeRunProgress().get("11112222-3333-4444-5555-6666aabbccdd");
        expect(p).toBeDefined();
        if (p) {
            expect(p.name).toBe("bbccdd"); // no plan title → the id tail, never the constant workflow name
            expect(p.tag).toBe("bbccdd"); // idTail of the runId (dashes stripped, last six)
            expect(p.total).toBe(3);
            expect(p.done).toBe(1); // only the completed step counts as done
            expect(p.steps.map((v) => v.state)).toEqual(["done", "running", "queued"]); // pending → queued
        }
    });

    test("EVERY active run gets its own entry and its own step read", async () => {
        const asked: string[] = [];
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "newest", status: "running" }), runRow({ runId: "older", status: "running" })]),
            loadActiveRuns: () => okAsync([runRow({ runId: "newest", status: "running" }), runRow({ runId: "older", status: "running" })]),
            loadSteps: (_pool, runId) => {
                asked.push(runId);
                return okAsync([stepRow("s", "running")]);
            },
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);
        // Both, because a second concurrent run having no live surface is the defect this replaces.
        expect(asked.sort()).toEqual(["newest", "older"]);
        expect([...activeRunProgress().keys()].sort()).toEqual(["newest", "older"]);
    });

    test("a terminal run's entry is removed while an active sibling's survives", async () => {
        const s = (olderStatus: "running" | "completed"): RefreshSeams => ({
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "live", status: "running" }), runRow({ runId: "older", status: olderStatus })]),
            loadActiveRuns: () => okAsync([runRow({ runId: "live", status: "running" }), runRow({ runId: "older", status: olderStatus })]),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadPlan: () => okAsync(null),
        });
        await refreshSidebarData("A", s("running"));
        expect([...activeRunProgress().keys()].sort()).toEqual(["live", "older"]);

        await refreshSidebarData("A", s("completed"));
        expect([...activeRunProgress().keys()]).toEqual(["live"]);
    });

    test("runs and steps are labelled from the plan when one resolves", async () => {
        const plan = { title: "GSEA cross-species comparison", steps: [{ id: "qc", name: "quality control" }] };
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "run-1", status: "running", planId: "plan-1" })]),
            loadActiveRuns: () => okAsync([runRow({ runId: "run-1", status: "running", planId: "plan-1" })]),
            loadSteps: () => okAsync([stepRow("qc", "running")]),
            loadPlan: () => okAsync(plan),
        };
        await refreshSidebarData("A", s);
        const p = activeRunProgress().get("run-1")!;
        // The plan title replaces "executeAnalysis", which is identical on every ledger row.
        expect(p.name).toBe("GSEA cross-species comparison");
        // And the step's human name replaces its T{track}S{step}-style slug.
        expect(p.steps[0]!.label).toBe("quality control");
    });

    test("several runs of one plan resolve that plan exactly once", async () => {
        let planReads = 0;
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () =>
                okAsync([runRow({ runId: "r1", status: "running", planId: "shared" }), runRow({ runId: "r2", status: "running", planId: "shared" })]),
            loadActiveRuns: () =>
                okAsync([runRow({ runId: "r1", status: "running", planId: "shared" }), runRow({ runId: "r2", status: "running", planId: "shared" })]),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadPlan: () => {
                planReads += 1;
                return okAsync({ title: "shared plan" });
            },
        };
        await refreshSidebarData("A", s);
        expect(planReads).toBe(1);
        expect(activeRunProgress().get("r1")!.name).toBe("shared plan");
        expect(activeRunProgress().get("r2")!.name).toBe("shared plan");
    });

    test("all-terminal runs clear the row and fire NO step read (idle costs no step query)", async () => {
        // Prime with an active run so the clear-to-null is observable.
        await refreshSidebarData(
            "A",
            seams(null, [runRow({ status: "running" })], () => fakeRuntime, [stepRow("s", "running")]),
        );
        expect(activeRunProgress().size).toBeGreaterThan(0);

        let stepReads = 0;

        let planReads = 0;
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ status: "completed" }), runRow({ status: "failed" })]),
            loadActiveRuns: () => okAsync([runRow({ status: "completed" }), runRow({ status: "failed" })]),
            loadSteps: () => {
                stepReads += 1;
                return okAsync([]);
            },
            loadPlan: () => {
                planReads += 1;
                return okAsync(null);
            },
        };
        await refreshSidebarData("A", s);
        expect(activeRunProgress().size).toBe(0);
        expect(stepReads).toBe(0);
        expect(planReads).toBe(0);
    });

    test("no runs at all → the row stays null, and no step read is issued", async () => {
        let stepReads = 0;
        let planReads = 0;
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([]),
            loadActiveRuns: () => okAsync([]),
            loadSteps: () => {
                stepReads += 1;
                return okAsync([]);
            },
            loadPlan: () => {
                planReads += 1;
                return okAsync(null);
            },
        };
        await refreshSidebarData("A", s);
        expect(activeRunProgress().size).toBe(0);
        expect(stepReads).toBe(0);
        expect(planReads).toBe(0);
    });

    test("a step-read DbError keeps the previous row rather than blinking it away", async () => {
        await refreshSidebarData(
            "A",
            seams(null, [runRow({ runId: "run-x", status: "running" })], () => fakeRuntime, [stepRow("s", "running")]),
        );
        const first = activeRunProgress();
        expect(first).not.toBeNull();

        // The run is still active but the step read blips → keep the previous snapshot, self-heal next poll.
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "run-x", status: "running" })]),
            loadActiveRuns: () => okAsync([runRow({ runId: "run-x", status: "running" })]),
            loadSteps: () => errAsync(dbErr),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);
        // The previous entry's CONTENT is carried forward — the blip did not blink a genuinely
        // running run away — but re-stamped `stale`, because freshness is a property of THIS refresh
        // and the panel mutes itself on it.
        const carried = activeRunProgress().get("run-x");
        expect(carried).toEqual({ ...first.get("run-x")!, stale: true });
        expect(carried!.stale).toBe(true);
        expect(first.get("run-x")!.stale).toBe(false);

        // A SECOND consecutive blip carries the same object by IDENTITY, not an equal copy. This is
        // load-bearing, not an optimization detail: `focusedRun` is a memo over this map and the run
        // panel's activity effect re-fires on its identity, so minting a new object per tick would
        // issue a DBOS read every poll for a value that cannot have changed during an outage.
        await refreshSidebarData("A", s);
        expect(activeRunProgress().get("run-x")).toBe(carried!);
    });

    test("a step-read DbError for a DIFFERENT run never shows one run's progress under another", async () => {
        // Prime with run A active.
        await refreshSidebarData(
            "A",
            seams(null, [runRow({ runId: "run-a", status: "running" })], () => fakeRuntime, [stepRow("s", "running")]),
        );
        expect(activeRunProgress().get("run-a")!.tag).toBe(idTail("run-a"));

        // A goes terminal and B takes its place, and B's step read blips. Under the old single-slot
        // store this was the misattribution hazard — the kept row belonged to A. Keying by run id
        // makes it unrepresentable: B simply has no entry, and A's is gone because A is terminal.
        const s: RefreshSeams = {
            runtime: () => fakeRuntime,
            loadProfile: () => okAsync(null),
            loadRuns: () => okAsync([runRow({ runId: "run-b", status: "running" }), runRow({ runId: "run-a", status: "completed" })]),
            loadActiveRuns: () => okAsync([runRow({ runId: "run-b", status: "running" }), runRow({ runId: "run-a", status: "completed" })]),
            loadSteps: () => errAsync(dbErr),
            loadPlan: () => okAsync(null),
        };
        await refreshSidebarData("A", s);
        expect(activeRunProgress().has("run-b")).toBe(false);
        expect(activeRunProgress().has("run-a")).toBe(false);
    });

    test("the runtime-not-ready no-op clears the row", async () => {
        await refreshSidebarData(
            "A",
            seams(null, [runRow({ status: "running" })], () => fakeRuntime, [stepRow("s", "running")]),
        );
        expect(activeRunProgress().size).toBeGreaterThan(0);

        await refreshSidebarData(
            "A",
            seams(null, [], () => null),
        );
        expect(activeRunProgress().size).toBe(0);
    });

    test("an analysis swap clears the row synchronously, before the new analysis loads", async () => {
        // A reactive workspace so Trigger 1's effect re-runs on the swap (mirrors the snapshot-swap test).
        const [store, setStore] = createStore<{ analysis: { id: string } | null }>({ analysis: { id: "A" } });
        const ws = store as unknown as Workspace;

        // B's profile read is gated so the reset window (row null) is deterministically observable.
        let releaseB!: (v: DataProfileStatus | null) => void;
        const gatedB: ResultAsync<DataProfileStatus | null, DbError> = ResultAsync.fromSafePromise(
            new Promise<DataProfileStatus | null>((res) => {
                releaseB = res;
            }),
        );
        const refresh = async (id: string): Promise<void> => {
            const s: RefreshSeams =
                id === "A"
                    ? seams(null, [runRow({ status: "running" })], () => fakeRuntime, [stepRow("s", "running")])
                    : {
                          runtime: () => fakeRuntime,
                          loadProfile: () => gatedB,
                          loadRuns: () => okAsync([]),
                          loadActiveRuns: () => okAsync([]),
                          loadSteps: () => okAsync([]),
                          loadPlan: () => okAsync(null),
                      };
            await refreshSidebarData(id, s);
        };

        const dispose = mountWatch(ws, { refresh, arm: () => () => {} });
        try {
            const readyDriver: BootDriver = async () => ok({ conversation: { model: "m" }, pool: {} } as unknown as HarnessRuntime);
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver); // Trigger 1 fires refresh(A)
            await new Promise<void>((r) => setTimeout(r, 0)); // let A's reads settle
            expect(activeRunProgress().size).toBeGreaterThan(0); // A's active run is pinned

            setStore("analysis", { id: "B" }); // swap → Trigger 1 resets synchronously, refresh(B) parks on the gate
            expect(activeRunProgress().size).toBe(0); // no stale A entries during the swap window

            releaseB(profileStatus({ status: "completed" })); // let B settle so no read leaks past the test
            await new Promise<void>((r) => setTimeout(r, 0));
        } finally {
            dispose();
        }
    });
});

// The data profile is the activity panel's SECOND kind of subject, published from the SAME
// profile read the DATA PROFILE section consumes — so these pin what a profile row turns into, never
// how it is read.
describe("refreshSidebarData — the profile's panel-subject entry", () => {
    test("a running profile publishes an entry carrying its startedAt and recorded workflowId", async () => {
        await refreshSidebarData("A", seams(runningProfile({ startedAt: "2026-07-30T10:00:00.000Z", workflowId: "wf-7" }), []));
        // `analysisId` comes from the refresh's argument rather than a ledger column: the entry carries
        // whose profile it is so a consumer holding one entry still knows.
        expect(activeProfileProgress()).toEqual({ analysisId: "A", startedAt: "2026-07-30T10:00:00.000Z", workflowId: "wf-7", stale: false });
    });

    test("a running profile whose workflow id is not yet recorded still publishes", async () => {
        // The profile body writes its workflow id as its first durable step, so a freshly-claimed row
        // has none. Withholding the subject would hide the profile for exactly the window in which it
        // just started — absence of the id is a normal state, not a reason to show nothing.
        await refreshSidebarData("A", seams(runningProfile({ workflowId: null }), []));
        const entry = activeProfileProgress();
        expect(entry).not.toBeNull();
        expect(entry?.workflowId).toBeNull();
        expect(entry?.stale).toBe(false);
    });

    test("a terminal profile publishes none, and clears an entry published on a previous refresh", async () => {
        await refreshSidebarData("A", seams(runningProfile(), []));
        expect(activeProfileProgress()).not.toBeNull();

        await refreshSidebarData("A", seams(profileStatus({ status: "completed" }), []));
        expect(activeProfileProgress()).toBeNull();

        // Failure is the other terminal end and must clear identically — a failed profile is no more
        // "work in flight" than a completed one.
        await refreshSidebarData("A", seams(runningProfile(), []));
        expect(activeProfileProgress()).not.toBeNull();
        await refreshSidebarData("A", seams(profileStatus({ status: "failed", error: "boom", result: null }), []));
        expect(activeProfileProgress()).toBeNull();
    });

    test("a pending profile publishes no entry, yet still arms the poll", async () => {
        // Two independent decisions, asserted so either can regress alone. A `pending` row carries no
        // start stamp and no workflow, so an entry would be a name beside two blanks — but the poll
        // must keep looking, because seeded-and-queued work will produce something to show.
        await refreshSidebarData("A", seams(profileStatus({ status: "pending", startedAt: null, completedAt: null, result: null }), []));
        expect(activeProfileProgress()).toBeNull();
        expect(hasActiveWork(profileSnapshot(), runsSnapshot())).toBe(true);
    });

    test("publishing a profile entry leaves the per-run entries untouched", async () => {
        const active = [runRow({ runId: "run-1", status: "running" })];
        await refreshSidebarData(
            "A",
            seams(null, active, () => fakeRuntime, [stepRow("s", "running")]),
        );
        const runsOnly = activeRunProgress().get("run-1");
        expect(runsOnly).toBeDefined();

        await refreshSidebarData(
            "A",
            seams(runningProfile(), active, () => fakeRuntime, [stepRow("s", "running")]),
        );
        // The rail renders off this map, so a profile joining the panel must not rewrite, reorder, or
        // displace any of it — the two live surfaces share a refresh, not a data set.
        expect(activeProfileProgress()).not.toBeNull();
        expect([...activeRunProgress().keys()]).toEqual(["run-1"]);
        expect(activeRunProgress().get("run-1")).toEqual(runsOnly!);
    });
});

// A profile read failure collapses the whole profile SNAPSHOT to a single `unavailable`, so without a
// carry-forward the panel's profile subject would vanish and return on any transient blip — which
// reads as the profile having finished and a new one starting.
describe("refreshSidebarData — a failed profile read carries the profile entry forward", () => {
    /** Seams whose profile read fails while every other read succeeds — the isolated profile blip. */
    function blippedProfile(): RefreshSeams {
        return { ...seams(null, []), loadProfile: () => errAsync(dbErr) };
    }

    test("a blip keeps the previous entry and marks it stale; a recovered read clears staleness", async () => {
        await refreshSidebarData("A", seams(runningProfile({ workflowId: "wf-7" }), []));
        const fresh = activeProfileProgress()!;
        expect(fresh.stale).toBe(false);

        await refreshSidebarData("A", blippedProfile());
        // The CONTENT is the last known state; only its freshness changes, because freshness is a
        // property of THIS refresh and the panel mutes itself on it.
        expect(activeProfileProgress()).toEqual({ ...fresh, stale: true });
        // The section degraded, and that is exactly the failure the entry has to survive.
        expect(profileSnapshot().kind).toBe("unavailable");

        await refreshSidebarData("A", seams(runningProfile({ workflowId: "wf-7" }), []));
        const recovered = activeProfileProgress();
        expect(recovered?.stale).toBe(false);
        expect(recovered).toEqual(fresh);
    });

    test("a second consecutive failure carries the SAME object, not an equal copy", async () => {
        await refreshSidebarData("A", seams(runningProfile(), []));
        await refreshSidebarData("A", blippedProfile());
        const carried = activeProfileProgress()!;
        expect(carried.stale).toBe(true);

        await refreshSidebarData("A", blippedProfile());
        // Identity, not equality: consumers memoize on this entry, so minting an equal-but-new object
        // every poll would re-fire all of them for a value that cannot have changed during an outage.
        expect(activeProfileProgress()).toBe(carried);
    });
});

// Ordering is load-bearing rather than cosmetic. A parity profile is auto-triggered when a chat opens
// on drifted inputs, so it enters the set without the user having asked for anything; a newest-first
// set would routinely hand it the head and displace a run the user launched deliberately on any
// surface that reads the head as its default focus.
describe("activeSubjects — a profile never displaces a run", () => {
    /** The subject set flattened to ids (`"profile"` for the profile) so kind AND order are one assertion. */
    function subjectIds(): string[] {
        return activeSubjects().map((s) => (s.kind === "run" ? s.run.runId : "profile"));
    }

    test("a profile sorts behind the only active run", async () => {
        await refreshSidebarData(
            "A",
            seams(runningProfile(), [runRow({ runId: "run-1", status: "running" })], () => fakeRuntime, [stepRow("s", "running")]),
        );
        expect(subjectIds()).toEqual(["run-1", "profile"]);
    });

    test("two active runs keep their newest-first order and the profile is last", async () => {
        const runs = [
            runRow({ runId: "newest", status: "running", startedAt: "2026-07-30T11:00:00.000Z" }),
            runRow({ runId: "older", status: "running", startedAt: "2026-07-30T09:00:00.000Z" }),
        ];
        await refreshSidebarData(
            "A",
            seams(runningProfile(), runs, () => fakeRuntime, [stepRow("s", "running")]),
        );
        // The runs query's own newest-first order, untouched by the profile joining the set.
        expect(subjectIds()).toEqual(["newest", "older", "profile"]);
        expect(activeSubjects()[0]?.kind).toBe("run");
    });

    test("a profile alone is the only subject", async () => {
        await refreshSidebarData("A", seams(runningProfile(), []));
        expect(subjectIds()).toEqual(["profile"]);
    });

    test("a profile that starts after a run does not take the head", async () => {
        const runs = [runRow({ runId: "user-launched", status: "running" })];
        await refreshSidebarData(
            "A",
            seams(null, runs, () => fakeRuntime, [stepRow("s", "running")]),
        );
        expect(subjectIds()).toEqual(["user-launched"]);

        await refreshSidebarData(
            "A",
            seams(runningProfile(), runs, () => fakeRuntime, [stepRow("s", "running")]),
        );
        // The later arrival goes to the TAIL, so the run the user launched keeps the head it had.
        expect(subjectIds()).toEqual(["user-launched", "profile"]);
        expect(activeSubjects()[0]?.kind).toBe("run");
    });
});

describe("hasActiveWork — poll arming predicate", () => {
    const notReady: ProfileSnapshot = { kind: "not_ready" };
    const noRuns: RunsSnapshot = { kind: "loaded", runs: [] };

    test("a pending/running profile is active", () => {
        expect(hasActiveWork({ kind: "loaded", profile: profileStatus({ status: "running" }) }, noRuns)).toBe(true);
        expect(hasActiveWork({ kind: "loaded", profile: profileStatus({ status: "pending" }) }, noRuns)).toBe(true);
    });

    test("a completed/failed profile alone is not active", () => {
        expect(hasActiveWork({ kind: "loaded", profile: profileStatus({ status: "completed" }) }, noRuns)).toBe(false);
        expect(hasActiveWork({ kind: "loaded", profile: profileStatus({ status: "failed", error: "x" }) }, noRuns)).toBe(false);
    });

    test("a non-terminal run arms; all-terminal runs do not", () => {
        expect(hasActiveWork({ kind: "absent" }, { kind: "loaded", runs: [runRow({ status: "running" })] })).toBe(true);
        const terminal = [runRow({ status: "completed" }), runRow({ status: "failed" }), runRow({ status: "canceled" }), runRow({ status: "partial" })];
        expect(hasActiveWork({ kind: "absent" }, { kind: "loaded", runs: terminal })).toBe(false);
    });

    test("not_ready snapshots alone are never active (idle costs nothing)", () => {
        expect(hasActiveWork(notReady, { kind: "not_ready" })).toBe(false);
    });

    test("an unavailable snapshot arms — a transient DB blip self-heals via the same 5s poll", () => {
        expect(hasActiveWork({ kind: "unavailable" }, { kind: "not_ready" })).toBe(true);
        expect(hasActiveWork(notReady, { kind: "unavailable" })).toBe(true);
        expect(hasActiveWork({ kind: "unavailable" }, { kind: "unavailable" })).toBe(true);
    });
});

describe("watchSidebarData — triggers and bounded poll", () => {
    test("reaching ready with an open analysis refreshes", async () => {
        const refreshed: string[] = [];
        const dispose = mountWatch(wsFor("A"), { refresh: async (id) => void refreshed.push(id), arm: () => () => {} });
        try {
            expect(refreshed).toHaveLength(0); // boot idle at mount → no refresh
            const readyDriver: BootDriver = async () => ok({ conversation: { model: "m" }, pool: {} } as unknown as HarnessRuntime);
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver);
            expect(refreshed).toEqual(["A"]); // the ready edge fired the refresh
        } finally {
            dispose();
        }
    });

    test("a busy→idle transition refreshes; the up-edge does not", () => {
        const refreshed: string[] = [];
        setChatStatus("idle");
        const dispose = mountWatch(wsFor("A"), { refresh: async (id) => void refreshed.push(id), arm: () => () => {} });
        try {
            expect(refreshed).toHaveLength(0);
            setChatStatus("busy");
            expect(refreshed).toHaveLength(0); // busy is the up-edge — no refresh
            setChatStatus("idle");
            expect(refreshed).toEqual(["A"]); // down-edge refreshes
        } finally {
            dispose();
        }
    });

    test("the poll arms on active work, ticks a refresh, and disarms when work goes terminal", async () => {
        const refreshed: string[] = [];
        const arms: Array<{ fn: () => void; ms: number }> = [];
        let disarms = 0;
        const watchSeams: WatchSeams = {
            refresh: async (id) => void refreshed.push(id),
            arm: (fn, ms) => {
                arms.push({ fn, ms });
                return () => {
                    disarms += 1;
                };
            },
        };
        const dispose = mountWatch(wsFor("A"), watchSeams);
        try {
            expect(arms).toHaveLength(0); // not_ready snapshots → no work → no interval

            await refreshSidebarData("A", seams(profileStatus({ status: "running" }), []));
            expect(arms).toHaveLength(1); // a running profile armed the poll
            expect(arms[0]?.ms).toBe(5_000);
            expect(disarms).toBe(0);

            arms[0]?.fn(); // a tick refreshes for the open analysis
            expect(refreshed).toEqual(["A"]);

            await refreshSidebarData("A", seams(profileStatus({ status: "completed" }), []));
            expect(disarms).toBe(1); // all work terminal → the interval is torn down
            expect(arms).toHaveLength(1); // and never re-armed
        } finally {
            dispose();
        }
    });

    test("disposing the watcher tears down a live interval", async () => {
        const arms: Array<() => void> = [];
        let disarms = 0;
        const watchSeams: WatchSeams = {
            refresh: async () => {},
            arm: () => {
                const disarm = (): void => void (disarms += 1);
                arms.push(disarm);
                return disarm;
            },
        };
        const dispose = mountWatch(wsFor("A"), watchSeams);
        await refreshSidebarData("A", seams(profileStatus({ status: "running" }), []));
        expect(arms).toHaveLength(1);
        expect(disarms).toBe(0);
        dispose();
        expect(disarms).toBe(1); // onCleanup disarmed the live interval
    });
});

describe("watchSidebarData — swap resets the snapshots before the new analysis loads", () => {
    test("a swap immediately renders not_ready, then B's data once its ledger read resolves", async () => {
        // A reactive workspace (real store) so Trigger 1's effect re-runs on the analysis swap — the
        // plain-object `wsFor` stand-in would not repaint.
        const [store, setStore] = createStore<{ analysis: { id: string } | null }>({ analysis: { id: "A" } });
        const ws = store as unknown as Workspace;

        // B's profile read is GATED so the reset window (not_ready) is deterministically observable
        // before B's data lands — the same technique the staleness-guard test uses.
        let releaseB!: (v: DataProfileStatus | null) => void;
        const gatedB: ResultAsync<DataProfileStatus | null, DbError> = ResultAsync.fromSafePromise(
            new Promise<DataProfileStatus | null>((res) => {
                releaseB = res;
            }),
        );
        const refresh = async (id: string): Promise<void> => {
            const s: RefreshSeams =
                id === "A"
                    ? seams(profileStatus({ status: "completed" }), [runRow()])
                    : {
                          runtime: () => fakeRuntime,
                          loadProfile: () => gatedB,
                          loadRuns: () => okAsync([]),
                          loadActiveRuns: () => okAsync([]),
                          loadSteps: () => okAsync([]),
                          loadPlan: () => okAsync(null),
                      };
            await refreshSidebarData(id, s);
        };

        const dispose = mountWatch(ws, { refresh, arm: () => () => {} });
        try {
            const readyDriver: BootDriver = async () => ok({ conversation: { model: "m" }, pool: {} } as unknown as HarnessRuntime);
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver); // Trigger 1 fires refresh(A)
            await new Promise<void>((r) => setTimeout(r, 0)); // let A's ledger reads settle
            expect(profileSnapshot().kind).toBe("loaded"); // A's data is on screen — stale state to clear

            setStore("analysis", { id: "B" }); // swap → Trigger 1 resets synchronously, refresh(B) parks on the gate
            expect(profileSnapshot().kind).toBe("not_ready"); // no stale A render during the swap window
            expect(runsSnapshot().kind).toBe("not_ready");

            releaseB(profileStatus({ status: "running" })); // B's read resolves
            await new Promise<void>((r) => setTimeout(r, 0));
            const p = profileSnapshot();
            expect(p.kind).toBe("loaded"); // B's data lands after the window
            if (p.kind === "loaded") expect(p.profile.status).toBe("running");
        } finally {
            dispose();
        }
    });
});

describe("profileDetailLines — one line set per snapshot kind", () => {
    test("not_ready → a single placeholder line", () => {
        expect(profileDetailLines({ kind: "not_ready" })).toEqual(["runtime not ready"]);
    });

    test("absent → not profiled yet", () => {
        expect(profileDetailLines({ kind: "absent" })).toEqual(["not profiled yet"]);
    });

    test("unavailable → status unavailable", () => {
        expect(profileDetailLines({ kind: "unavailable" })).toEqual(["profile status unavailable"]);
    });

    test("loaded completed → status, absolute times, duration, summary, per-file, seed count", () => {
        const lines = profileDetailLines(loaded());
        expect(lines[0]).toBe("status: completed");
        // Detail dialogs pin absolute local times — assert via the same toLocaleString the code path
        // runs on the fixture timestamps, never a hardcoded locale string.
        expect(lines).toContain(`started ${new Date("2026-07-08T00:00:00.000Z").toLocaleString()}`);
        expect(lines).toContain(`completed ${new Date("2026-07-08T00:00:05.000Z").toLocaleString()}`);
        // Both timestamps parse → a duration line (the fixture's start/complete are 5s apart); asserted
        // through the shared formatter, not its literal output.
        expect(lines).toContain(`duration ${Date.formatDuration(5_000)}`);
        expect(lines).toContain("line one");
        expect(lines).toContain("line two");
        expect(lines).toContain("files (2):");
        expect(lines.some((l) => l.includes("data/counts.tsv") && l.includes("raw counts"))).toBe(true);
        expect(lines.some((l) => l.includes("data/meta.csv") && l.includes("sample metadata"))).toBe(true);
        // seedInputFileIds (3) wins over the profiled input-signature count.
        expect(lines[lines.length - 1]).toBe("3 seed inputs");
    });

    test("loaded completed with groups → groups section, legacy files list suppressed", () => {
        const lines = profileDetailLines(
            loaded({
                result: {
                    summary: "s",
                    groups: [
                        {
                            id: "per-sample-counts",
                            name: "per-sample-counts",
                            memberRepresents: "one sample's counts",
                            description: "gene-level count tables",
                            role: "primary-data",
                            category: "expression-matrix",
                            count: 2,
                            fileCount: 2,
                            totalBytes: 10,
                            displayPattern: "counts/{sample}.tsv",
                            formats: [{ format: "tsv", count: 2 }],
                        },
                    ],
                    files: [{ path: "a.csv", description: "d" }],
                    profiledAt: "2026-07-08T00:00:05.000Z",
                },
            }),
        );
        expect(lines).toContain("groups (1):");
        expect(lines.some((l) => l.includes("per-sample-counts") && l.includes("2 members"))).toBe(true);
        expect(lines.some((l) => l.startsWith("files ("))).toBe(false);
    });

    test("loaded failed → surfaces the multi-line error and a duration", () => {
        const lines = profileDetailLines(loaded({ status: "failed", error: "boom\ndetails here", result: null, seedInputFileIds: null }));
        expect(lines[0]).toBe("status: failed");
        // The ledger stamps completedAt on the failure path too, so a failed profile still reports how
        // long it ran — a duration, not an elapsed age.
        expect(lines).toContain(`duration ${Date.formatDuration(5_000)}`);
        expect(lines.some((l) => l.startsWith("elapsed "))).toBe(false);
        expect(lines).toContain("boom");
        expect(lines).toContain("details here");
        // No result + no seed set → zero, pluralized.
        expect(lines[lines.length - 1]).toBe("0 seed inputs");
    });

    test("loaded pending without a result → status, elapsed (not duration), seed count, no files section", () => {
        const lines = profileDetailLines(
            loaded({ status: "pending", startedAt: "2026-07-08T00:00:00.000Z", completedAt: null, result: null, seedInputFileIds: ["only-one"] }),
        );
        expect(lines[0]).toBe("status: pending");
        expect(lines).toContain(`started ${new Date("2026-07-08T00:00:00.000Z").toLocaleString()}`);
        expect(lines.some((l) => l.startsWith("completed "))).toBe(false);
        // Still running (no completedAt) → an elapsed-at-open age, never a duration.
        expect(lines.some((l) => l.startsWith("elapsed "))).toBe(true);
        expect(lines.some((l) => l.startsWith("duration "))).toBe(false);
        expect(lines.some((l) => l.startsWith("files ("))).toBe(false);
        // Singular when exactly one seed input.
        expect(lines[lines.length - 1]).toBe("1 seed input");
    });

    test("the profile's own figures ride the timing lines, in the one shared notation", () => {
        const lines = profileDetailLines(loaded({}, { calls: 4, inputTokens: 55_500, outputTokens: 3_200 }));
        // Its calls carry no thread, so they belong to no session and appear in no session figure —
        // this dialog and the rail's DATA PROFILE section are the only places they are visible at all.
        // The LABELLED form, unlike the compact figure the rail's DATA PROFILE section carries for this
        // same profile: this is a property line in a full-width dialog, read rather than scanned.
        const usage = `usage 55.5k in ${GLYPHS.middot} 3.2k out`;
        expect(lines).toContain(usage);
        // Placed among the properties, not after the summary/files prose — the same `label value`
        // vocabulary as `started` / `duration`.
        expect(lines.indexOf(usage)).toBeLessThan(lines.indexOf("line one"));
    });

    test("a profile with nothing reported carries no usage line rather than a zeroed one", () => {
        // Three ways to have no figure, all of which must omit the line: the read failed (no usage on
        // the snapshot at all), the profile made no calls, and calls whose providers reported nothing.
        for (const snap of [loaded(), loaded({}, { calls: 0 }), loaded({}, { calls: 3 })]) {
            expect(profileDetailLines(snap).some((l) => l.startsWith("usage "))).toBe(false);
        }
    });
});

// The poll's own overlap guard. `refreshSidebarData` claims the generation token at entry, so a newer
// refresh CANCELS an older one — unguarded ticks slower than the interval would supersede each other
// forever and the store would never receive a write. `unavailable` is itself an arming condition, so
// that failure would be self-sustaining against a degraded database.
describe("the bounded poll never overlaps itself", () => {
    /** Watch seams whose `refresh` parks until released, recording each entry. */
    function parkedRefreshSeams(): { watchSeams: WatchSeams; tick: () => void; entries: () => number; release: () => void } {
        const arms: Array<() => void> = [];
        let entries = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        return {
            watchSeams: {
                refresh: async () => {
                    entries += 1;
                    await gate;
                },
                arm: (fn) => {
                    arms.push(fn);
                    return () => {};
                },
            },
            tick: () => {
                for (const fn of arms) fn();
            },
            entries: () => entries,
            release: () => release(),
        };
    }

    test("N ticks during one slow refresh issue exactly one refresh", async () => {
        const h = parkedRefreshSeams();
        const dispose = mountWatch(wsFor("A"), h.watchSeams);
        try {
            // Arm the poll: a running profile is active work.
            await refreshSidebarData("A", seams(profileStatus({ status: "running" }), []));
            const armedAfterEdge = h.entries();

            h.tick();
            h.tick();
            h.tick();
            expect(h.entries()).toBe(armedAfterEdge + 1); // three ticks, one refresh

            h.release();
            await Promise.resolve();
            await Promise.resolve();

            // Once the in-flight refresh settles the poll resumes.
            h.tick();
            expect(h.entries()).toBe(armedAfterEdge + 2);
        } finally {
            dispose();
        }
    });

    test("a lifecycle edge still refreshes while a poll tick is in flight", async () => {
        const h = parkedRefreshSeams();
        const dispose = mountWatch(wsFor("A"), h.watchSeams);
        try {
            await refreshSidebarData("A", seams(profileStatus({ status: "running" }), []));
            const before = h.entries();

            h.tick();
            expect(h.entries()).toBe(before + 1); // the poll owns a refresh

            // The turn-completion down-edge must NOT be skipped: it carries new information.
            setChatStatus("busy");
            setChatStatus("idle");
            expect(h.entries()).toBe(before + 2);

            h.release();
        } finally {
            dispose();
        }
    });
});

// The other half of that guard: it must always come back. A read that never settles would hold a
// boolean claim for the process lifetime, and because the poll and the run-observation push consult
// the SAME claim, one stall would freeze every live surface at its last value — no error anywhere,
// and indistinguishable from a run that stopped progressing.
describe("the in-flight guard is bounded", () => {
    /** 3 × the 5s poll cadence, past which a claim is abandoned — plus a millisecond to clear it. */
    const PAST_THE_BOUND_MS = 3 * 5_000 + 1;
    const runEvent = (): void => {
        Bus.emit("inflexa", { type: "run.observed", analysisId: "A", snapshot: { runId: "r1", status: "running", steps: [] } });
    };

    test("a refresh whose reads never settle is abandoned, and the next tick refreshes the store", async () => {
        const arms: Array<() => void> = [];
        let entries = 0;
        const watchSeams: WatchSeams = {
            // The first refresh parks FOREVER — the wedged read the bound exists for. Every later one
            // runs the REAL refresh against immediate seams, so "the next tick proceeds" is asserted
            // against a store write rather than against a call count.
            refresh: (analysisId) => {
                entries += 1;
                if (entries === 1) return new Promise<void>(() => {});
                return refreshSidebarData(analysisId, seams(profileStatus({ status: "running" }), [runRow({ runId: "after-the-bound" })]));
            },
            arm: (fn) => {
                arms.push(fn);
                return () => {};
            },
        };
        const dispose = mountWatch(wsFor("A"), watchSeams);
        const tick = (): void => {
            for (const fn of arms) fn();
        };
        try {
            // A running profile is active work, so the poll arms.
            await refreshSidebarData("A", seams(profileStatus({ status: "running" }), []));
            expect(arms.length).toBeGreaterThan(0);

            tick();
            expect(entries).toBe(1); // claims the guard, and never settles
            tick();
            expect(entries).toBe(1); // still inside the bound: a merely slow refresh is not abandoned

            setSystemTime(new Date(Date.now() + PAST_THE_BOUND_MS));
            tick();
            expect(entries).toBe(2); // past the bound: the guard is taken and a fresh refresh runs
            // And nothing partial or empty was published in the abandoned refresh's place — the
            // snapshot is still the one the arming refresh wrote.
            expect(runsSnapshot()).toEqual({ kind: "loaded", runs: [], usageByRun: new Map() });

            setSystemTime();
            await new Promise<void>((r) => setTimeout(r, 0));
            const snap = runsSnapshot();
            expect(snap.kind === "loaded" && snap.runs.map((r) => r.runId)).toEqual(["after-the-bound"]);
        } finally {
            setSystemTime();
            dispose();
        }
    });

    test("the run-observation push recovers from the same stall — one guard, both triggers", async () => {
        let entries = 0;
        const dispose = mountWatch(wsFor("A"), {
            refresh: () => {
                entries += 1;
                return new Promise<void>(() => {});
            },
            arm: () => () => {},
        });
        try {
            runEvent();
            expect(entries).toBe(1);
            runEvent();
            expect(entries).toBe(1); // inside the bound: dropped, exactly as the burst rule says

            setSystemTime(new Date(Date.now() + PAST_THE_BOUND_MS));
            runEvent();
            expect(entries).toBe(2); // an event is never left permanently disabled by a wedged read
        } finally {
            setSystemTime();
            dispose();
        }
    });
});

describe("watchSidebarData — run-observation trigger", () => {
    const runEvent = (analysisId: string): void => {
        Bus.emit("inflexa", { type: "run.observed", analysisId, snapshot: { runId: "r1", status: "running", steps: [] } });
    };

    test("a run.observed event for the open analysis refreshes without waiting for the poll", async () => {
        let refreshes = 0;
        const dispose = mountWatch(wsFor("A"), { refresh: () => ((refreshes += 1), Promise.resolve()), arm: () => () => {} });
        const before = refreshes;

        runEvent("A");
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(refreshes).toBe(before + 1);
        dispose();
    });

    test("an event for a DIFFERENT analysis is ignored", async () => {
        let refreshes = 0;
        const dispose = mountWatch(wsFor("A"), { refresh: () => ((refreshes += 1), Promise.resolve()), arm: () => () => {} });
        const before = refreshes;

        runEvent("OTHER");
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(refreshes).toBe(before);
        dispose();
    });

    test("a burst arriving faster than a refresh completes is skipped, not queued", async () => {
        // Same discipline as the poll: a superseding storm would leave the store with no write at
        // all, because each refresh cancels the last via its generation token.
        let refreshes = 0;
        let release: () => void = () => {};
        const dispose = mountWatch(wsFor("A"), {
            refresh: () => {
                refreshes += 1;
                return new Promise<void>((r) => {
                    release = r;
                });
            },
            arm: () => () => {},
        });
        const before = refreshes;

        runEvent("A");
        expect(refreshes).toBe(before + 1);
        runEvent("A");
        runEvent("A");
        expect(refreshes).toBe(before + 1); // both dropped while the first is in flight

        release();
        await new Promise<void>((r) => setTimeout(r, 0));
        runEvent("A");
        expect(refreshes).toBe(before + 2); // and it recovers once the in-flight one settles
        dispose();
    });

    test("an event never disarms the poll — the bus is in-process, so an out-of-process run needs it", async () => {
        // A run launched by a separate `inflexa run` emits nothing here; the interval is the only
        // thing that makes it visible, so the push must not replace it.
        let arms = 0;
        const dispose = mountWatch(wsFor("A"), {
            refresh: () => Promise.resolve(),
            arm: () => {
                arms += 1;
                return () => {};
            },
        });
        await refreshSidebarData(
            "A",
            seams(null, [runRow({ status: "running" })], () => fakeRuntime, [stepRow("s", "running")]),
        );
        const armedBefore = arms;
        expect(armedBefore).toBeGreaterThan(0);

        runEvent("A");
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(arms).toBe(armedBefore); // still armed, not re-armed and not torn down
        dispose();
    });
});

// The three token-ledger reads the refresh performs alongside its Postgres ones. Every one of them is
// DECORATIVE — the entity it belongs to renders with or without it — so each case pins two things: the
// figure reaches the surface that names the entity, and losing the read costs only the figure.
describe("refreshSidebarData — per-entity token figures", () => {
    /** Seams whose ledger reads answer from the given fixtures; anything omitted reads as nothing recorded. */
    function ledgerSeams(base: RefreshSeams, over: Partial<RefreshSeams>): RefreshSeams {
        return { ...base, loadProfileUsage: () => ok({ calls: 0 }), loadRunUsage: () => ok({ calls: 0 }), loadStepUsage: () => ok([]), ...over };
    }

    test("the profile's totals ride its snapshot, keyed to the analysis being refreshed", async () => {
        let asked: string[] = [];
        await refreshSidebarData(
            "A",
            ledgerSeams(seams(profileStatus(), []), {
                loadProfileUsage: (analysisId) => {
                    asked.push(analysisId);
                    return ok({ calls: 4, inputTokens: 55_500, outputTokens: 3_200 });
                },
            }),
        );
        const snap = profileSnapshot();
        expect(snap.kind).toBe("loaded");
        expect(snap.kind === "loaded" && snap.usage).toEqual({ calls: 4, inputTokens: 55_500, outputTokens: 3_200 });
        expect(asked).toEqual(["A"]);

        // An analysis that has never profiled has no row to hang a figure on, so no read is issued.
        asked = [];
        await refreshSidebarData(
            "A",
            ledgerSeams(seams(null, []), {
                loadProfileUsage: (analysisId) => {
                    asked.push(analysisId);
                    return ok({ calls: 4 });
                },
            }),
        );
        expect(asked).toEqual([]);
    });

    test("a failed profile usage read leaves the profile loaded, without its figure", async () => {
        await refreshSidebarData("A", ledgerSeams(seams(profileStatus(), []), { loadProfileUsage: () => err(dbErr) }));
        const snap = profileSnapshot();
        // The section keeps everything it had — a missing decoration must never take the entity with it.
        expect(snap.kind).toBe("loaded");
        expect(snap.kind === "loaded" && snap.usage).toBeUndefined();
        expect(snap.kind === "loaded" && snap.profile.status).toBe("completed");
    });

    test("each listed run's totals are keyed by its OWN run id, and one failure costs only that row's figure", async () => {
        const runs = [runRow({ runId: "run-a", status: "completed" }), runRow({ runId: "run-b", status: "completed" })];
        await refreshSidebarData(
            "A",
            ledgerSeams(seams(null, runs), {
                loadRunUsage: (_analysisId, runId) => (runId === "run-a" ? ok({ calls: 3, inputTokens: 809_200 }) : err(dbErr)),
            }),
        );
        const snap = runsSnapshot();
        expect(snap.kind).toBe("loaded");
        const byRun = snap.kind === "loaded" ? snap.usageByRun : undefined;
        expect(byRun?.get("run-a")).toEqual({ calls: 3, inputTokens: 809_200 });
        // Absent, not zeroed: the row still renders, it just carries no figure.
        expect(byRun?.has("run-b")).toBe(false);
        // ...and BOTH runs are still listed, which is the property the figure must never cost.
        expect(snap.kind === "loaded" && snap.runs.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
    });

    test("a running step's view carries its own figure, and a step with nothing reported carries none", async () => {
        await refreshSidebarData(
            "A",
            ledgerSeams(
                seams(null, [runRow({ runId: "run-a", status: "running" })], () => fakeRuntime, [stepRow("qc", "running"), stepRow("align", "pending")]),
                {
                    loadStepUsage: () =>
                        ok([
                            { stepId: "qc", totals: { calls: 5, inputTokens: 42_600, outputTokens: 1_100 } },
                            // The run's own calls — the plan and synthesis frames it owns directly. An
                            // ABSENCE of a step, not a step named this, so it decorates no row.
                            { stepId: null, totals: { calls: 2, inputTokens: 9_000 } },
                        ]),
                },
            ),
        );
        const steps = activeRunProgress().get("run-a")?.steps ?? [];
        expect(steps.map((s) => s.label)).toEqual(["qc", "align"]);
        expect(steps[0]?.usageFigure).toBe(`${GLYPHS.arrowUp}42.6k ${GLYPHS.arrowDown}1.1k`);
        // A step whose calls reported nothing carries NO figure rather than a zeroed one, and the
        // run-level group is nowhere among the step rows.
        expect(steps[1]?.usageFigure).toBeUndefined();
        expect(steps.some((s) => s.usageFigure?.includes("9.0k"))).toBe(false);
    });

    test("two active runs never see each other's step figures", async () => {
        const runs = [runRow({ runId: "run-a", status: "running" }), runRow({ runId: "run-b", status: "running" })];
        await refreshSidebarData("A", {
            ...ledgerSeams(seams(null, runs), {}),
            loadSteps: () => okAsync([stepRow("s", "running")]),
            loadStepUsage: (_analysisId, runId) =>
                ok([{ stepId: "s", totals: runId === "run-a" ? { calls: 1, inputTokens: 800_000 } : { calls: 1, inputTokens: 1_200 } }]),
        });
        expect(activeRunProgress().get("run-a")?.steps[0]?.usageFigure).toBe(`${GLYPHS.arrowUp}800.0k`);
        expect(activeRunProgress().get("run-b")?.steps[0]?.usageFigure).toBe(`${GLYPHS.arrowUp}1.2k`);
    });

    test("a failed step usage read leaves every step rendered, without figures", async () => {
        await refreshSidebarData(
            "A",
            ledgerSeams(
                seams(null, [runRow({ runId: "run-a", status: "running" })], () => fakeRuntime, [stepRow("qc", "running")]),
                {
                    loadStepUsage: () => err(dbErr),
                },
            ),
        );
        const steps = activeRunProgress().get("run-a")?.steps ?? [];
        expect(steps.map((s) => s.label)).toEqual(["qc"]);
        expect(steps[0]?.usageFigure).toBeUndefined();
    });

    test("an idle rail issues NO step usage read — the same zero-query property the step read holds", async () => {
        let stepUsageReads = 0;
        const counting = (base: RefreshSeams): RefreshSeams =>
            ledgerSeams(base, {
                loadStepUsage: () => {
                    stepUsageReads += 1;
                    return ok([]);
                },
            });

        // All-terminal runs...
        await refreshSidebarData("A", counting(seams(null, [runRow({ status: "completed" })])));
        expect(stepUsageReads).toBe(0);
        // ...and no runs at all. The read rides the active-run fan-out, so it inherits its arming.
        await refreshSidebarData("A", counting(seams(null, [])));
        expect(stepUsageReads).toBe(0);

        // ...but an active run pays for exactly one.
        await refreshSidebarData("A", counting(seams(null, [runRow({ status: "running" })], () => fakeRuntime, [stepRow("s", "running")])));
        expect(stepUsageReads).toBe(1);
    });

    test("a fixture that stubs none of the ledger reads still publishes every entity", async () => {
        // The three ledger seams are OPTIONAL precisely so a case about run progress is not made to
        // stub reads it has no claim about — and omitting them must land exactly where a failed read
        // does: entities present, figures absent.
        await refreshSidebarData(
            "A",
            seams(profileStatus(), [runRow({ runId: "run-a", status: "running" })], () => fakeRuntime, [stepRow("qc", "running")]),
        );
        expect(profileSnapshot().kind).toBe("loaded");
        expect(runsSnapshot().kind).toBe("loaded");
        expect(activeRunProgress().get("run-a")?.steps[0]?.usageFigure).toBeUndefined();
    });
});
