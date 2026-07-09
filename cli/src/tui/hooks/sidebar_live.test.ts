import { afterEach, describe, expect, test } from "bun:test";
import { ok, okAsync, errAsync, ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";

// Side-effect import: installs `Date.relativeAge` (the loaded-profile timestamp lines call it) via the
// same central loader the app boots with.
import "../../extensions/index.ts";
import type { CortexRunRow, DataProfileStatus, DbError } from "@inflexa-ai/harness";
import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, startHarnessBoot, type BootDriver } from "./boot.ts";
import { setChatStatus } from "./status.ts";
import {
    __resetSidebarLiveForTest,
    hasActiveWork,
    profileDetailLines,
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
                    : { runtime: () => fakeRuntime, loadProfile: () => gatedB, loadRuns: () => okAsync([]) };
            await refreshSidebarData(id, s);
        };

        const dispose = mountWatch(ws, { refresh, arm: () => () => {} });
        try {
            const readyDriver: BootDriver = async () => ok({ model: "m", pool: {} } as unknown as HarnessRuntime);
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

    test("loaded completed → status, times, summary, per-file, seed count", () => {
        const lines = profileDetailLines(loaded());
        expect(lines[0]).toBe("status: completed");
        expect(lines.some((l) => l.startsWith("started "))).toBe(true);
        expect(lines.some((l) => l.startsWith("completed "))).toBe(true);
        expect(lines).toContain("line one");
        expect(lines).toContain("line two");
        expect(lines).toContain("files (2):");
        expect(lines.some((l) => l.includes("data/counts.tsv") && l.includes("raw counts"))).toBe(true);
        expect(lines.some((l) => l.includes("data/meta.csv") && l.includes("sample metadata"))).toBe(true);
        // seedInputFileIds (3) wins over the profiled inputFileIds count.
        expect(lines[lines.length - 1]).toBe("3 seed inputs");
    });

    test("loaded failed → surfaces the multi-line error", () => {
        const lines = profileDetailLines(loaded({ status: "failed", error: "boom\ndetails here", result: null, seedInputFileIds: null }));
        expect(lines[0]).toBe("status: failed");
        expect(lines).toContain("boom");
        expect(lines).toContain("details here");
        // No result + no seed set → zero, pluralized.
        expect(lines[lines.length - 1]).toBe("0 seed inputs");
    });

    test("loaded pending without a result → status + seed count, no files section", () => {
        const lines = profileDetailLines(
            loaded({ status: "pending", startedAt: "2026-07-08T00:00:00.000Z", completedAt: null, result: null, seedInputFileIds: ["only-one"] }),
        );
        expect(lines[0]).toBe("status: pending");
        expect(lines.some((l) => l.startsWith("started "))).toBe(true);
        expect(lines.some((l) => l.startsWith("completed "))).toBe(false);
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
