import { afterEach, describe, expect, test } from "bun:test";
import { ok, okAsync, errAsync, ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";

import { Bus } from "../../lib/bus.ts";
import { createStore } from "solid-js/store";

// Side-effect import: installs `Date.relativeAge` (the loaded-profile timestamp lines call it) via the
// same central loader the app boots with.
import "../../extensions/index.ts";
import type { CortexRunRow, DataProfileStatus, DbError, StepExecutionRow } from "@inflexa-ai/harness";
import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, startHarnessBoot, type BootDriver } from "./boot.ts";
import { setChatStatus } from "./status.ts";
import {
    __resetSidebarLiveForTest,
    activeRunProgress,
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
        result: { summary: "s", files: [{ path: "a.csv", description: "d" }], inputFileIds: [], profiledAt: "2026-07-08T00:00:05.000Z" },
        seedInputFileIds: null,
        ...over,
    };
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
function loaded(over: Partial<DataProfileStatus> = {}): ProfileSnapshot {
    return {
        kind: "loaded",
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
                inputFileIds: ["i1", "i2"],
                profiledAt: "2026-07-08T00:00:05.000Z",
            },
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
        // seedInputFileIds (3) wins over the profiled inputFileIds count.
        expect(lines[lines.length - 1]).toBe("3 seed inputs");
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
