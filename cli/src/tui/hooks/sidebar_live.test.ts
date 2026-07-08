import { afterEach, describe, expect, test } from "bun:test";
import { ok, okAsync, errAsync, ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";

import type { CortexRunRow, DataProfileStatus, DbError } from "@inflexa-ai/harness";
import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, startHarnessBoot, type BootDriver } from "./boot.ts";
import { setChatStatus } from "./status.ts";
import {
    __resetSidebarLiveForTest,
    hasActiveWork,
    profileSnapshot,
    refreshSidebarData,
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
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        attemptCount: 0,
        ...over,
    };
}

/** Build refresh seams whose reads resolve immediately with the given data. */
function seams(profile: DataProfileStatus | null, runs: CortexRunRow[], runtime: () => HarnessRuntime | null = () => fakeRuntime): RefreshSeams {
    return { runtime, loadProfile: () => okAsync(profile), loadRuns: () => okAsync(runs) };
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

describe("refreshSidebarData — snapshot ladder", () => {
    test("no-ops to not_ready when the runtime is not booted, issuing no query", async () => {
        let profileReads = 0;
        let runReads = 0;
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
        };
        await refreshSidebarData("A", guarded);

        expect(profileSnapshot().kind).toBe("not_ready");
        expect(runsSnapshot().kind).toBe("not_ready");
        expect(profileReads).toBe(0);
        expect(runReads).toBe(0);
    });

    test("a DbError degrades to unavailable, never a crash", async () => {
        const failing: RefreshSeams = { runtime: () => fakeRuntime, loadProfile: () => errAsync(dbErr), loadRuns: () => errAsync(dbErr) };
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
        const seamsA: RefreshSeams = { runtime: () => fakeRuntime, loadProfile: () => gatedA, loadRuns: () => okAsync([runRow({ status: "running" })]) };
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

    test("not_ready / unavailable snapshots are never active (idle costs nothing)", () => {
        expect(hasActiveWork(notReady, { kind: "not_ready" })).toBe(false);
        expect(hasActiveWork({ kind: "unavailable" }, { kind: "unavailable" })).toBe(false);
    });
});

describe("watchSidebarData — triggers and bounded poll", () => {
    test("reaching ready with an open analysis refreshes", async () => {
        const refreshed: string[] = [];
        const dispose = mountWatch(wsFor("A"), { refresh: async (id) => void refreshed.push(id), arm: () => () => {} });
        try {
            expect(refreshed).toHaveLength(0); // boot idle at mount → no refresh
            const readyDriver: BootDriver = async () => ok({ model: "m", pool: {} } as unknown as HarnessRuntime);
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
