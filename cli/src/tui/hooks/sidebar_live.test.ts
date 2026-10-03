import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import type { DataProfileResult } from "@inflexa-ai/harness/contracts/index.js";

// Side-effect import: installs `Date.relativeAge` (the loaded-profile timestamp lines call it) via the
// same central loader the app boots with.
import "../../extensions/index.ts";
import type { DataProfileState, DataProfileView, RunDetail, RunStepSummary, RunSummary, StepExecutionStatus } from "../../api/runs.ts";
import type { UsageTotals } from "../../api/usage.ts";
import type { ClientError } from "../../client/api.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, __setBootStateForTest } from "./boot.ts";
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
    type RefreshOpts,
    type RunsSnapshot,
} from "./sidebar_live.ts";

afterEach(() => {
    __resetSidebarLiveForTest();
    __resetBootForTest();
    setChatStatus("idle");
});

/** The options of {@link watchSidebarData}: its refresh and its timer. */
type WatchOpts = NonNullable<Parameters<typeof watchSidebarData>[1]>;

/** The client error of a failed read: the server answered 500. */
const serverErr: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "The server failed to handle the request." } };

function profileState(over: Partial<DataProfileState> = {}): DataProfileState {
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
function runningProfile(over: Partial<DataProfileState> = {}): DataProfileState {
    return profileState({ status: "running", startedAt: "2026-07-30T10:00:00.000Z", completedAt: null, result: null, workflowId: "wf-1", ...over });
}

/** A run in the wire shape of `GET {A}/runs`. */
function runRow(over: Partial<RunSummary> = {}): RunSummary {
    const runId = over.runId ?? "run-1";
    return {
        runId,
        threadId: null,
        workflowName: "executeAnalysis",
        workflowId: runId,
        status: "completed",
        startedAt: "2026-07-08T00:00:00.000Z",
        completedAt: null,
        error: null,
        ...over,
    };
}

/** A minimal step of a run detail keyed by id + status — the refresh maps steps → step views via `stepStateOf`. */
function stepRow(stepId: string, status: StepExecutionStatus, over: Partial<RunStepSummary> = {}): RunStepSummary {
    return { stepId, agentId: "agent", status, startedAt: null, completedAt: null, durationMs: null, error: null, attempts: 1, blockedReason: null, ...over };
}

/** The `GET {A}/run/:runId` body of `run`, with its steps. */
function detailOf(run: RunSummary, steps: RunStepSummary[], unattributedUsage: UsageTotals | null = null): RunDetail {
    return { ...run, steps, unattributedUsage };
}

/** The `GET {A}/data-profile` body of a row, or of a never-profiled analysis. */
function viewOf(profile: DataProfileState | null, usage?: UsageTotals): DataProfileView {
    if (profile === null) return { status: null };
    return usage === undefined ? profile : { ...profile, usage };
}

/** Build refresh options whose reads resolve immediately with the given data. Steps default to empty. */
function opts(profile: DataProfileState | null, runs: RunSummary[], ready: () => boolean = () => true, steps: RunStepSummary[] = []): RefreshOpts {
    return {
        ready,
        loadProfile: () => okAsync(viewOf(profile)),
        loadRuns: () => okAsync(runs),
        // Derived from the same rows, filtered to the non-terminal ones — what the real `active=true`
        // read returns. Echoing the whole list would let a fixture assert behaviour the production read
        // cannot produce.
        loadActiveRuns: () => okAsync(runs.filter((r) => !RUN_STATUS_TERMINAL[r.status])),
        loadRun: (_analysisId, runId) => okAsync(detailOf(runs.find((r) => r.runId === runId) ?? runRow({ runId, status: "running" }), steps)),
    };
}

/** Mount `watchSidebarData` in a disposable reactive root; returns the dispose so the test tears it down. */
function mountWatch(ws: Workspace, watchOpts: WatchOpts): () => void {
    let dispose!: () => void;
    createRoot((d) => {
        dispose = d;
        watchSidebarData(ws, watchOpts);
    });
    return dispose;
}

/** Drive the boot store to `ready`, as `watchServerBoot` does when the server reports it. */
function bootReady(): void {
    __setBootStateForTest({ phase: "ready", model: "m", connection: { provider: "anthropic", mode: "cliproxy" } });
}

// The watch reads only `workspace.analysis?.id`, so a partial stand-in cast is sound and keeps the
// trigger tests offline (no reactive store, no lock, no session).
function wsFor(id: string | null): Workspace {
    const analysis = id === null ? null : ({ id } as unknown as Workspace["analysis"]);
    return { analysis } as unknown as Workspace;
}

/** Build a `loaded` profile snapshot for the {@link profileDetailLines} composer tests. */
function loaded(over: Partial<DataProfileState> = {}, usage?: UsageTotals): ProfileSnapshot {
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

/** A profile read that parks until the test releases it with a view. */
function gatedProfile(): { read: ResultAsync<DataProfileView, ClientError>; release: (view: DataProfileView) => void } {
    let release!: (view: DataProfileView) => void;
    const read = ResultAsync.fromSafePromise(
        new Promise<DataProfileView>((res) => {
            release = res;
        }),
    );
    return { read, release };
}

describe("refreshSidebarData — snapshot ladder", () => {
    test("no-ops to not_ready when the runtime is not ready, issuing no request", async () => {
        let reads = 0;
        // Prime to a loaded state so the reset back to not_ready is observable.
        await refreshSidebarData("A", opts(profileState(), [runRow()]));
        expect(profileSnapshot().kind).toBe("loaded");

        const count = <T>(value: T): ResultAsync<T, ClientError> => {
            reads += 1;
            return okAsync(value);
        };
        const guarded: RefreshOpts = {
            ready: () => false,
            loadProfile: () => count<DataProfileView>({ status: null }),
            loadRuns: () => count<RunSummary[]>([]),
            loadActiveRuns: () => count<RunSummary[]>([]),
            loadRun: () => count(detailOf(runRow(), [])),
        };
        await refreshSidebarData("A", guarded);

        expect(profileSnapshot().kind).toBe("not_ready");
        expect(runsSnapshot().kind).toBe("not_ready");
        expect(reads).toBe(0);
    });

    test("a failed read degrades to unavailable, never a crash", async () => {
        const failing: RefreshOpts = {
            ready: () => true,
            loadProfile: () => errAsync(serverErr),
            loadRuns: () => errAsync(serverErr),
            loadActiveRuns: () => errAsync(serverErr),
            loadRun: () => errAsync(serverErr),
        };
        await refreshSidebarData("A", failing);
        expect(profileSnapshot().kind).toBe("unavailable");
        expect(runsSnapshot().kind).toBe("unavailable");
    });

    test("a never-profiled analysis is absent while runs still load", async () => {
        await refreshSidebarData("A", opts(null, [runRow()]));
        expect(profileSnapshot().kind).toBe("absent");
        const r = runsSnapshot();
        expect(r.kind).toBe("loaded");
        if (r.kind === "loaded") expect(r.runs).toHaveLength(1);
    });

    test("a present profile + runs load through", async () => {
        await refreshSidebarData("A", opts(profileState({ status: "completed" }), [runRow(), runRow({ runId: "run-2" })]));
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
        const gatedA = gatedProfile();
        const optsA: RefreshOpts = { ...opts(null, [runRow({ status: "running" })]), loadProfile: () => gatedA.read };
        const optsB = opts(profileState({ status: "completed" }), [runRow({ status: "completed" })]);

        const pA = refreshSidebarData("A", optsA); // parks on the gated profile read
        await refreshSidebarData("B", optsB); // starts + finishes; wins the store

        const afterB = profileSnapshot();
        expect(afterB.kind).toBe("loaded");
        if (afterB.kind === "loaded") expect(afterB.profile.status).toBe("completed");

        gatedA.release(runningProfile()); // A now resolves — but it is stale
        await pA;

        const settled = profileSnapshot();
        expect(settled.kind).toBe("loaded");
        // B's completed profile survives; the superseded A drops rather than overwriting it.
        if (settled.kind === "loaded") expect(settled.profile.status).toBe("completed");
    });
});

// The runs LISTING is windowed to the newest N by start time, which drops the OLDEST running run
// first — precisely the long analysis these surfaces exist to keep visible. The uncapped active read
// is what makes that impossible; these pin the merge that consumes it.
describe("refreshSidebarData — an active run is never lost to the listing window", () => {
    test("a running run outside the newest-N window is still listed and still tracked", async () => {
        const longRunner = runRow({ runId: "run-old", status: "running", startedAt: "2026-07-28T09:00:00.000Z" });
        // The window holds only newer, finished runs — `run-old` has fallen off it entirely.
        const window = Array.from({ length: 10 }, (_, i) => runRow({ runId: `run-new-${i}`, status: "completed", startedAt: `2026-07-28T1${i}:00:00.000Z` }));
        const o: RefreshOpts = {
            ...opts(null, [], () => true, [stepRow("s", "running")]),
            loadRuns: () => okAsync(window),
            loadActiveRuns: () => okAsync([longRunner]),
        };
        await refreshSidebarData("A", o);

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
        const o: RefreshOpts = {
            ...opts(null, [], () => true, [stepRow("s", "running")]),
            loadRuns: () => okAsync([live, runRow({ runId: "run-b", status: "completed" })]),
            loadActiveRuns: () => okAsync([live]),
        };
        await refreshSidebarData("A", o);

        const snap = runsSnapshot();
        if (snap.kind !== "loaded") throw new Error("expected loaded");
        expect(snap.runs.filter((r) => r.runId === "run-a")).toHaveLength(1);
        expect(snap.runs).toHaveLength(2);
    });

    test("a failed active read degrades to the window's own view rather than blanking the section", async () => {
        const o: RefreshOpts = {
            ...opts(null, [], () => true, [stepRow("s", "running")]),
            loadRuns: () => okAsync([runRow({ runId: "run-a", status: "running" })]),
            loadActiveRuns: () => errAsync(serverErr),
        };
        await refreshSidebarData("A", o);

        // A read that adds coverage must never be able to take coverage away.
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
        const o: RefreshOpts = {
            ...opts(null, [], () => true, [stepRow("s", "running")]),
            loadRuns: () => errAsync(serverErr),
            loadActiveRuns: () => okAsync([runRow({ runId: "run-a", status: "running" })]),
        };
        await refreshSidebarData("A", o);

        const snap = runsSnapshot();
        if (snap.kind !== "loaded") throw new Error("expected loaded, not unavailable");
        expect(snap.runs.map((r) => r.runId)).toEqual(["run-a"]);
        expect(activeRunProgress().has("run-a")).toBe(true);
    });

    test("only BOTH run reads failing degrades the section to unavailable", async () => {
        const o: RefreshOpts = { ...opts(null, []), loadRuns: () => errAsync(serverErr), loadActiveRuns: () => errAsync(serverErr) };
        await refreshSidebarData("A", o);
        expect(runsSnapshot().kind).toBe("unavailable");
    });
});

describe("refreshSidebarData — sticky run-progress row", () => {
    test("a non-terminal newest run publishes its progress (name, tag, done/total, mapped steps)", async () => {
        const steps = [stepRow("qc", "completed"), stepRow("align", "running"), stepRow("call", "pending")];
        const run = runRow({ runId: "11112222-3333-4444-5555-6666aabbccdd", status: "running", workflowName: "executeAnalysis" });
        await refreshSidebarData(
            "A",
            opts(null, [run], () => true, steps),
        );
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

    test("EVERY active run gets its own entry and its own run read", async () => {
        const asked: string[] = [];
        const runs = [runRow({ runId: "newest", status: "running" }), runRow({ runId: "older", status: "running" })];
        const o: RefreshOpts = {
            ...opts(null, runs),
            loadRun: (_analysisId, runId) => {
                asked.push(runId);
                return okAsync(
                    detailOf(
                        runs.find((r) => r.runId === runId)!,
                        [stepRow("s", "running")],
                    ),
                );
            },
        };
        await refreshSidebarData("A", o);
        // Both, because a second concurrent run having no live surface is the defect this replaces.
        expect(asked.sort()).toEqual(["newest", "older"]);
        expect([...activeRunProgress().keys()].sort()).toEqual(["newest", "older"]);
    });

    test("a terminal run's entry is removed while an active sibling's survives", async () => {
        const o = (olderStatus: "running" | "completed"): RefreshOpts =>
            opts(null, [runRow({ runId: "live", status: "running" }), runRow({ runId: "older", status: olderStatus })], () => true, [stepRow("s", "running")]);
        await refreshSidebarData("A", o("running"));
        expect([...activeRunProgress().keys()].sort()).toEqual(["live", "older"]);

        await refreshSidebarData("A", o("completed"));
        expect([...activeRunProgress().keys()]).toEqual(["live"]);
    });

    test("runs and steps are labelled from the plan title and the step names that the run read carries", async () => {
        const run = runRow({ runId: "run-1", status: "running", planTitle: "GSEA cross-species comparison" });
        const o: RefreshOpts = {
            ...opts(null, [run]),
            loadRun: () => okAsync(detailOf(run, [stepRow("qc", "running", { name: "quality control" }), stepRow("T1S2", "pending")])),
        };
        await refreshSidebarData("A", o);
        const p = activeRunProgress().get("run-1")!;
        // The plan title replaces "executeAnalysis", which is identical on every ledger row.
        expect(p.name).toBe("GSEA cross-species comparison");
        // And the step's human name replaces its T{track}S{step}-style slug; a step with no name keeps it.
        expect(p.steps.map((s) => s.label)).toEqual(["quality control", "T1S2"]);
    });

    test("all-terminal runs clear the row and fire NO run read (idle costs no step query)", async () => {
        // Prime with an active run so the clear-to-empty is observable.
        await refreshSidebarData(
            "A",
            opts(null, [runRow({ status: "running" })], () => true, [stepRow("s", "running")]),
        );
        expect(activeRunProgress().size).toBeGreaterThan(0);

        let runReads = 0;
        const o: RefreshOpts = {
            ...opts(null, [runRow({ runId: "r1", status: "completed" }), runRow({ runId: "r2", status: "failed" })]),
            loadRun: () => {
                runReads += 1;
                return okAsync(detailOf(runRow(), []));
            },
        };
        await refreshSidebarData("A", o);
        expect(activeRunProgress().size).toBe(0);
        expect(runReads).toBe(0);
    });

    test("no runs at all → the row stays empty, and no run read is issued", async () => {
        let runReads = 0;
        const o: RefreshOpts = {
            ...opts(null, []),
            loadRun: () => {
                runReads += 1;
                return okAsync(detailOf(runRow(), []));
            },
        };
        await refreshSidebarData("A", o);
        expect(activeRunProgress().size).toBe(0);
        expect(runReads).toBe(0);
    });

    test("a failed run read keeps the previous row rather than blinking it away", async () => {
        await refreshSidebarData(
            "A",
            opts(null, [runRow({ runId: "run-x", status: "running" })], () => true, [stepRow("s", "running")]),
        );
        const first = activeRunProgress();
        expect(first.has("run-x")).toBe(true);

        // The run is still active but its read blips → keep the previous snapshot, self-heal next poll.
        const o: RefreshOpts = { ...opts(null, [runRow({ runId: "run-x", status: "running" })]), loadRun: () => errAsync(serverErr) };
        await refreshSidebarData("A", o);
        // The previous entry's CONTENT is carried forward — the blip did not blink a genuinely
        // running run away — but re-stamped `stale`, because freshness is a property of THIS refresh
        // and the panel mutes itself on it.
        const carried = activeRunProgress().get("run-x");
        expect(carried).toEqual({ ...first.get("run-x")!, stale: true });
        expect(carried!.stale).toBe(true);
        expect(first.get("run-x")!.stale).toBe(false);

        // A SECOND consecutive blip carries the same object by IDENTITY, not an equal copy. This is
        // load-bearing, not an optimization detail: the panel's focus memo reads this map, and minting
        // a new object per tick would re-fire each consumer for a value that cannot have changed
        // during an outage.
        await refreshSidebarData("A", o);
        expect(activeRunProgress().get("run-x")).toBe(carried!);
    });

    test("a failed run read for a DIFFERENT run never shows one run's progress under another", async () => {
        // Prime with run A active.
        await refreshSidebarData(
            "A",
            opts(null, [runRow({ runId: "run-a", status: "running" })], () => true, [stepRow("s", "running")]),
        );
        expect(activeRunProgress().get("run-a")!.tag).toBe(idTail("run-a"));

        // A goes terminal and B takes its place, and B's read blips. Keying by run id makes the
        // misattribution unrepresentable: B simply has no entry, and A's is gone because A is terminal.
        const o: RefreshOpts = {
            ...opts(null, [runRow({ runId: "run-b", status: "running" }), runRow({ runId: "run-a", status: "completed" })]),
            loadRun: () => errAsync(serverErr),
        };
        await refreshSidebarData("A", o);
        expect(activeRunProgress().has("run-b")).toBe(false);
        expect(activeRunProgress().has("run-a")).toBe(false);
    });

    test("the runtime-not-ready no-op clears the row", async () => {
        await refreshSidebarData(
            "A",
            opts(null, [runRow({ status: "running" })], () => true, [stepRow("s", "running")]),
        );
        expect(activeRunProgress().size).toBeGreaterThan(0);

        await refreshSidebarData(
            "A",
            opts(null, [], () => false),
        );
        expect(activeRunProgress().size).toBe(0);
    });

    test("an analysis swap clears the row synchronously, before the new analysis loads", async () => {
        // A reactive workspace so Trigger 1's effect re-runs on the swap (mirrors the snapshot-swap test).
        const [store, setStore] = createStore<{ analysis: { id: string } | null }>({ analysis: { id: "A" } });
        const ws = store as unknown as Workspace;

        // B's profile read is gated so the reset window (row empty) is deterministically observable.
        const gatedB = gatedProfile();
        const refresh = async (id: string): Promise<void> => {
            const o: RefreshOpts =
                id === "A"
                    ? opts(null, [runRow({ status: "running" })], () => true, [stepRow("s", "running")])
                    : { ...opts(null, []), loadProfile: () => gatedB.read };
            await refreshSidebarData(id, o);
        };

        const dispose = mountWatch(ws, { refresh, arm: () => () => {} });
        try {
            bootReady(); // Trigger 1 fires refresh(A)
            await new Promise<void>((r) => setTimeout(r, 0)); // let A's reads settle
            expect(activeRunProgress().size).toBeGreaterThan(0); // A's active run is pinned

            setStore("analysis", { id: "B" }); // swap → Trigger 1 resets synchronously, refresh(B) parks on the gate
            expect(activeRunProgress().size).toBe(0); // no stale A entries during the swap window

            gatedB.release(profileState({ status: "completed" })); // let B settle so no read leaks past the test
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
        await refreshSidebarData("A", opts(runningProfile({ startedAt: "2026-07-30T10:00:00.000Z", workflowId: "wf-7" }), []));
        // `analysisId` comes from the refresh's argument rather than a ledger column: the entry carries
        // whose profile it is so a consumer holding one entry still knows.
        expect(activeProfileProgress()).toEqual({ analysisId: "A", startedAt: "2026-07-30T10:00:00.000Z", workflowId: "wf-7", stale: false });
    });

    test("a running profile whose workflow id is not yet recorded still publishes", async () => {
        // The profile body writes its workflow id as its first durable step, so a freshly-claimed row
        // has none. Withholding the subject would hide the profile for exactly the window in which it
        // just started — absence of the id is a normal state, not a reason to show nothing.
        await refreshSidebarData("A", opts(runningProfile({ workflowId: null }), []));
        const entry = activeProfileProgress();
        expect(entry).not.toBeNull();
        expect(entry?.workflowId).toBeNull();
        expect(entry?.stale).toBe(false);
    });

    test("a terminal profile publishes none, and clears an entry published on a previous refresh", async () => {
        await refreshSidebarData("A", opts(runningProfile(), []));
        expect(activeProfileProgress()).not.toBeNull();

        await refreshSidebarData("A", opts(profileState({ status: "completed" }), []));
        expect(activeProfileProgress()).toBeNull();

        // Failure is the other terminal end and must clear identically — a failed profile is no more
        // "work in flight" than a completed one.
        await refreshSidebarData("A", opts(runningProfile(), []));
        expect(activeProfileProgress()).not.toBeNull();
        await refreshSidebarData("A", opts(profileState({ status: "failed", error: "boom", result: null }), []));
        expect(activeProfileProgress()).toBeNull();
    });

    test("a pending profile publishes no entry, yet still arms the poll", async () => {
        // Two independent decisions, asserted so either can regress alone. A `pending` row carries no
        // start stamp and no workflow, so an entry would be a name beside two blanks — but the poll
        // must keep looking, because seeded-and-queued work will produce something to show.
        await refreshSidebarData("A", opts(profileState({ status: "pending", startedAt: null, completedAt: null, result: null }), []));
        expect(activeProfileProgress()).toBeNull();
        expect(hasActiveWork(profileSnapshot(), runsSnapshot())).toBe(true);
    });

    test("publishing a profile entry leaves the per-run entries untouched", async () => {
        const active = [runRow({ runId: "run-1", status: "running" })];
        await refreshSidebarData(
            "A",
            opts(null, active, () => true, [stepRow("s", "running")]),
        );
        const runsOnly = activeRunProgress().get("run-1");
        expect(runsOnly).toBeDefined();

        await refreshSidebarData(
            "A",
            opts(runningProfile(), active, () => true, [stepRow("s", "running")]),
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
    /** Options whose profile read fails while every other read succeeds — the isolated profile blip. */
    function blippedProfile(): RefreshOpts {
        return { ...opts(null, []), loadProfile: () => errAsync(serverErr) };
    }

    test("a blip keeps the previous entry and marks it stale; a recovered read clears staleness", async () => {
        await refreshSidebarData("A", opts(runningProfile({ workflowId: "wf-7" }), []));
        const fresh = activeProfileProgress()!;
        expect(fresh.stale).toBe(false);

        await refreshSidebarData("A", blippedProfile());
        // The CONTENT is the last known state; only its freshness changes, because freshness is a
        // property of THIS refresh and the panel mutes itself on it.
        expect(activeProfileProgress()).toEqual({ ...fresh, stale: true });
        // The section degraded, and that is exactly the failure the entry has to survive.
        expect(profileSnapshot().kind).toBe("unavailable");

        await refreshSidebarData("A", opts(runningProfile({ workflowId: "wf-7" }), []));
        const recovered = activeProfileProgress();
        expect(recovered?.stale).toBe(false);
        expect(recovered).toEqual(fresh);
    });

    test("a second consecutive failure carries the SAME object, not an equal copy", async () => {
        await refreshSidebarData("A", opts(runningProfile(), []));
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
            opts(runningProfile(), [runRow({ runId: "run-1", status: "running" })], () => true, [stepRow("s", "running")]),
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
            opts(runningProfile(), runs, () => true, [stepRow("s", "running")]),
        );
        // The runs read's own newest-first order, untouched by the profile joining the set.
        expect(subjectIds()).toEqual(["newest", "older", "profile"]);
        expect(activeSubjects()[0]?.kind).toBe("run");
    });

    test("a profile alone is the only subject", async () => {
        await refreshSidebarData("A", opts(runningProfile(), []));
        expect(subjectIds()).toEqual(["profile"]);
    });

    test("a profile that starts after a run does not take the head", async () => {
        const runs = [runRow({ runId: "user-launched", status: "running" })];
        await refreshSidebarData(
            "A",
            opts(null, runs, () => true, [stepRow("s", "running")]),
        );
        expect(subjectIds()).toEqual(["user-launched"]);

        await refreshSidebarData(
            "A",
            opts(runningProfile(), runs, () => true, [stepRow("s", "running")]),
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
        expect(hasActiveWork({ kind: "loaded", profile: profileState({ status: "running" }) }, noRuns)).toBe(true);
        expect(hasActiveWork({ kind: "loaded", profile: profileState({ status: "pending" }) }, noRuns)).toBe(true);
    });

    test("a completed/failed profile alone is not active", () => {
        expect(hasActiveWork({ kind: "loaded", profile: profileState({ status: "completed" }) }, noRuns)).toBe(false);
        expect(hasActiveWork({ kind: "loaded", profile: profileState({ status: "failed", error: "x" }) }, noRuns)).toBe(false);
    });

    test("a non-terminal run arms; all-terminal runs do not", () => {
        expect(hasActiveWork({ kind: "absent" }, { kind: "loaded", runs: [runRow({ status: "running" })] })).toBe(true);
        const terminal = [runRow({ status: "completed" }), runRow({ status: "failed" }), runRow({ status: "canceled" }), runRow({ status: "partial" })];
        expect(hasActiveWork({ kind: "absent" }, { kind: "loaded", runs: terminal })).toBe(false);
    });

    test("not_ready snapshots alone are never active (idle costs nothing)", () => {
        expect(hasActiveWork(notReady, { kind: "not_ready" })).toBe(false);
    });

    test("an unavailable snapshot arms — a transient blip self-heals via the same 5s poll", () => {
        expect(hasActiveWork({ kind: "unavailable" }, { kind: "not_ready" })).toBe(true);
        expect(hasActiveWork(notReady, { kind: "unavailable" })).toBe(true);
        expect(hasActiveWork({ kind: "unavailable" }, { kind: "unavailable" })).toBe(true);
    });
});

describe("watchSidebarData — triggers and bounded poll", () => {
    test("reaching ready with an open analysis refreshes", () => {
        const refreshed: string[] = [];
        const dispose = mountWatch(wsFor("A"), { refresh: async (id) => void refreshed.push(id), arm: () => () => {} });
        try {
            expect(refreshed).toHaveLength(0); // boot idle at mount → no refresh
            bootReady();
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
        const watchOpts: WatchOpts = {
            refresh: async (id) => void refreshed.push(id),
            arm: (fn, ms) => {
                arms.push({ fn, ms });
                return () => {
                    disarms += 1;
                };
            },
        };
        const dispose = mountWatch(wsFor("A"), watchOpts);
        try {
            expect(arms).toHaveLength(0); // not_ready snapshots → no work → no interval

            await refreshSidebarData("A", opts(runningProfile(), []));
            expect(arms).toHaveLength(1); // a running profile armed the poll
            expect(arms[0]?.ms).toBe(5_000);
            expect(disarms).toBe(0);

            arms[0]?.fn(); // a tick refreshes for the open analysis
            expect(refreshed).toEqual(["A"]);

            await refreshSidebarData("A", opts(profileState({ status: "completed" }), []));
            expect(disarms).toBe(1); // all work terminal → the interval is torn down
            expect(arms).toHaveLength(1); // and never re-armed
        } finally {
            dispose();
        }
    });

    test("disposing the watcher tears down a live interval", async () => {
        const arms: Array<() => void> = [];
        let disarms = 0;
        const watchOpts: WatchOpts = {
            refresh: async () => {},
            arm: () => {
                const disarm = (): void => void (disarms += 1);
                arms.push(disarm);
                return disarm;
            },
        };
        const dispose = mountWatch(wsFor("A"), watchOpts);
        await refreshSidebarData("A", opts(runningProfile(), []));
        expect(arms).toHaveLength(1);
        expect(disarms).toBe(0);
        dispose();
        expect(disarms).toBe(1); // onCleanup disarmed the live interval
    });
});

describe("watchSidebarData — swap resets the snapshots before the new analysis loads", () => {
    test("a swap immediately renders not_ready, then B's data once its read resolves", async () => {
        // A reactive workspace (real store) so Trigger 1's effect re-runs on the analysis swap — the
        // plain-object `wsFor` stand-in would not repaint.
        const [store, setStore] = createStore<{ analysis: { id: string } | null }>({ analysis: { id: "A" } });
        const ws = store as unknown as Workspace;

        // B's profile read is GATED so the reset window (not_ready) is deterministically observable
        // before B's data lands — the same technique the staleness-guard test uses.
        const gatedB = gatedProfile();
        const refresh = async (id: string): Promise<void> => {
            const o: RefreshOpts = id === "A" ? opts(profileState({ status: "completed" }), [runRow()]) : { ...opts(null, []), loadProfile: () => gatedB.read };
            await refreshSidebarData(id, o);
        };

        const dispose = mountWatch(ws, { refresh, arm: () => () => {} });
        try {
            bootReady(); // Trigger 1 fires refresh(A)
            await new Promise<void>((r) => setTimeout(r, 0)); // let A's reads settle
            expect(profileSnapshot().kind).toBe("loaded"); // A's data is on screen — stale state to clear

            setStore("analysis", { id: "B" }); // swap → Trigger 1 resets synchronously, refresh(B) parks on the gate
            expect(profileSnapshot().kind).toBe("not_ready"); // no stale A render during the swap window
            expect(runsSnapshot().kind).toBe("not_ready");

            gatedB.release(runningProfile()); // B's read resolves
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
        // A legacy row carries no classification, no partition, no dimensions, no caveats — the
        // groups-era sections must be absent, not rendered empty.
        for (const prefix of ["dataset ", "census ", "groups (", "dimensions (", "caveats ("]) {
            expect(lines.some((l) => l.startsWith(prefix))).toBe(false);
        }
        // seedInputFileIds (3) wins over the profiled input-signature count.
        expect(lines[lines.length - 1]).toBe("3 seed inputs");
    });

    /** A groups-era result: classification, census, three groups (one swept residue), dimensions, caveats. */
    function groupsResult(over: Partial<DataProfileResult> = {}): DataProfileResult {
        return {
            summary: "s",
            domain: "transcriptomics",
            subtype: "bulk-rna-seq",
            organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
            partition: {
                scannedFiles: 30,
                keptFiles: 26,
                keptMembers: 26,
                groups: 3,
                unclassifiedMembers: 1,
                unclassifiedFiles: 1,
                quarantine: { count: 4, totalBytes: 10, reasons: [{ reason: "hidden", count: 4 }], sample: [".DS_Store"] },
            },
            groups: [
                {
                    id: "per-sample-counts",
                    name: "per-sample-counts",
                    memberRepresents: "one sample's counts",
                    description: "gene-level count tables",
                    role: "primary-data",
                    category: "expression-matrix",
                    count: 24,
                    fileCount: 24,
                    totalBytes: 1_288_490_189,
                    displayPattern: "counts/{sample}.tsv",
                    formats: [
                        { format: "tsv", count: 20 },
                        { format: "csv", count: 4 },
                    ],
                },
                // The residue is deliberately the byte-largest group: ordering must still pin it last.
                {
                    id: "unclassified",
                    name: "unclassified",
                    memberRepresents: "a file no operation claimed",
                    description: "swept residue",
                    role: "supplementary",
                    category: "other",
                    count: 1,
                    fileCount: 1,
                    totalBytes: 2_000_000_000,
                    displayPattern: "",
                    formats: [{ format: "txt", count: 1 }],
                    unclassified: true,
                },
                {
                    id: "metadata",
                    name: "metadata",
                    memberRepresents: "the sample sheet",
                    description: "sample metadata",
                    role: "sample-metadata",
                    category: "sample-annotation",
                    count: 1,
                    fileCount: 1,
                    totalBytes: 5_000,
                    displayPattern: "meta.csv",
                    formats: [{ format: "csv", count: 1 }],
                },
            ],
            dimensions: [
                {
                    label: "sample",
                    category: "biological-sample",
                    scope: "biological",
                    observations: [
                        {
                            kind: "slot",
                            groupIds: ["per-sample-counts"],
                            slotId: "s1",
                            tokenClass: "alnum",
                            cardinality: 24,
                            sampleValues: ["S01", "S02", "S03", "S04"],
                        },
                    ],
                },
                {
                    label: "condition",
                    category: "condition",
                    scope: "biological",
                    observations: [{ kind: "column", path: "meta.csv", column: "condition", exampleValues: ["control", "treated"], distinctValues: 2 }],
                },
            ],
            caveats: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"],
            files: [{ path: "a.csv", description: "d" }],
            profiledAt: "2026-07-08T00:00:05.000Z",
            ...over,
        };
    }

    test("loaded completed with groups → dataset, census, groups, dimensions, caveats; legacy files list suppressed", () => {
        const lines = profileDetailLines(loaded({ result: groupsResult() }));
        expect(lines).toContain(`dataset transcriptomics ${GLYPHS.middot} bulk-rna-seq ${GLYPHS.middot} Homo sapiens`);
        expect(lines).toContain(`census 26 files in 3 groups ${GLYPHS.middot} 1 unclassified ${GLYPHS.middot} 4 quarantined`);
        // One line per group: name — count × memberRepresents · bytes · formats · pattern.
        expect(lines).toContain("groups (3):");
        expect(lines).toContain(
            `  per-sample-counts ${GLYPHS.emDash} 24 ${GLYPHS.multiply} one sample's counts ${GLYPHS.middot} ${(1_288_490_189).formatBytes()} ${GLYPHS.middot} tsv/csv ${GLYPHS.middot} counts/{sample}.tsv`,
        );
        // The residue group is warning-marked and its empty display pattern is omitted, not printed blank.
        expect(lines).toContain(
            `  ${GLYPHS.warning} unclassified ${GLYPHS.emDash} 1 ${GLYPHS.multiply} a file no operation claimed ${GLYPHS.middot} ${(2_000_000_000).formatBytes()} ${GLYPHS.middot} txt`,
        );
        expect(lines.some((l) => l.startsWith("files ("))).toBe(false);
        // One line per dimension: label — cardinality · a bounded sample (ellipsis only when values remain).
        expect(lines).toContain("dimensions (2):");
        expect(lines).toContain(`  sample ${GLYPHS.emDash} 24 values ${GLYPHS.middot} S01, S02, S03, ${GLYPHS.ellipsis}`);
        expect(lines).toContain(`  condition ${GLYPHS.emDash} 2 values ${GLYPHS.middot} control, treated`);
        // Caveats are warning-marked and bounded; the fold names what it hides.
        expect(lines).toContain("caveats (8):");
        expect(lines).toContain(`  ${GLYPHS.warning} c6`);
        expect(lines.some((l) => l.includes("c7"))).toBe(false);
        expect(lines).toContain(`  ${GLYPHS.ellipsis} and 2 more`);
        expect(lines[lines.length - 1]).toBe("3 seed inputs");
    });

    test("the sections read top-down: dataset, census, summary, groups, dimensions, caveats", () => {
        const lines = profileDetailLines(loaded({ result: groupsResult({ summary: "prose" }) }));
        const order = [
            lines.findIndex((l) => l.startsWith("dataset ")),
            lines.findIndex((l) => l.startsWith("census ")),
            lines.indexOf("prose"),
            lines.indexOf("groups (3):"),
            lines.indexOf("dimensions (2):"),
            lines.indexOf("caveats (8):"),
        ];
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    test("groups list largest first, the residue last regardless of size", () => {
        const lines = profileDetailLines(loaded({ result: groupsResult() }));
        const at = (name: string): number => lines.findIndex((l) => l.includes(` ${name} ${GLYPHS.emDash} `));
        expect(at("per-sample-counts")).toBeLessThan(at("metadata"));
        expect(at("metadata")).toBeLessThan(at("unclassified"));
    });

    test("the census omits zero tallies rather than reporting them", () => {
        const partition = {
            ...groupsResult().partition!,
            unclassifiedMembers: 0,
            unclassifiedFiles: 0,
            quarantine: { count: 0, totalBytes: 0, reasons: [], sample: [] },
        };
        const lines = profileDetailLines(loaded({ result: groupsResult({ partition }) }));
        expect(lines).toContain("census 26 files in 3 groups");
        expect(lines.some((l) => l.includes("unclassified") && l.startsWith("census"))).toBe(false);
        expect(lines.some((l) => l.includes("quarantined"))).toBe(false);
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
// that failure would be self-sustaining against a degraded server.
describe("the bounded poll never overlaps itself", () => {
    /** Watch options whose `refresh` parks until released, recording each entry. */
    function parkedRefresh(): { watchOpts: WatchOpts; tick: () => void; entries: () => number; release: () => void } {
        const arms: Array<() => void> = [];
        let entries = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        return {
            watchOpts: {
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
        const h = parkedRefresh();
        const dispose = mountWatch(wsFor("A"), h.watchOpts);
        try {
            // Arm the poll: a running profile is active work.
            await refreshSidebarData("A", opts(runningProfile(), []));
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
        const h = parkedRefresh();
        const dispose = mountWatch(wsFor("A"), h.watchOpts);
        try {
            await refreshSidebarData("A", opts(runningProfile(), []));
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
// boolean claim for the process lifetime, and that one stall would freeze every live surface at its
// last value — no error anywhere, and indistinguishable from a run that stopped progressing.
describe("the in-flight guard is bounded", () => {
    /** 3 × the 5s poll cadence, past which a claim is abandoned — plus a millisecond to clear it. */
    const PAST_THE_BOUND_MS = 3 * 5_000 + 1;

    test("a refresh whose reads never settle is abandoned, and the next tick refreshes the store", async () => {
        const arms: Array<() => void> = [];
        let entries = 0;
        const watchOpts: WatchOpts = {
            // The first refresh parks FOREVER — the wedged read the bound exists for. Every later one
            // runs the REAL refresh against immediate reads, so "the next tick proceeds" is asserted
            // against a store write rather than against a call count.
            refresh: (analysisId) => {
                entries += 1;
                if (entries === 1) return new Promise<void>(() => {});
                return refreshSidebarData(analysisId, opts(runningProfile(), [runRow({ runId: "after-the-bound" })]));
            },
            arm: (fn) => {
                arms.push(fn);
                return () => {};
            },
        };
        const dispose = mountWatch(wsFor("A"), watchOpts);
        const tick = (): void => {
            for (const fn of arms) fn();
        };
        try {
            // A running profile is active work, so the poll arms.
            await refreshSidebarData("A", opts(runningProfile(), []));
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
            expect(runsSnapshot()).toEqual({ kind: "loaded", runs: [] });

            setSystemTime();
            await new Promise<void>((r) => setTimeout(r, 0));
            const snap = runsSnapshot();
            expect(snap.kind === "loaded" && snap.runs.map((r) => r.runId)).toEqual(["after-the-bound"]);
        } finally {
            setSystemTime();
            dispose();
        }
    });
});

// The figures ride the reads of the server. Every one of them is DECORATIVE — the entity it belongs to
// renders with or without it — so each case pins two things: the figure reaches the surface that names
// the entity, and a missing figure costs only the figure.
describe("refreshSidebarData — per-entity token figures", () => {
    test("the profile's totals ride its snapshot", async () => {
        const o: RefreshOpts = {
            ...opts(null, []),
            loadProfile: () => okAsync(viewOf(profileState(), { calls: 4, inputTokens: 55_500, outputTokens: 3_200 })),
        };
        await refreshSidebarData("A", o);
        const snap = profileSnapshot();
        expect(snap.kind).toBe("loaded");
        expect(snap.kind === "loaded" && snap.usage).toEqual({ calls: 4, inputTokens: 55_500, outputTokens: 3_200 });
        // The figure rides beside the row, never inside it.
        expect(snap.kind === "loaded" && "usage" in snap.profile).toBe(false);
    });

    test("a profile view with no usage leaves the profile loaded, without its figure", async () => {
        await refreshSidebarData("A", opts(profileState(), []));
        const snap = profileSnapshot();
        // The section keeps everything it had — a missing decoration must never take the entity with it.
        expect(snap.kind).toBe("loaded");
        expect(snap.kind === "loaded" && snap.usage).toBeUndefined();
        expect(snap.kind === "loaded" && snap.profile.status).toBe("completed");
    });

    test("each listed run carries its OWN figure, and a run with none still lists", async () => {
        const runs = [
            runRow({ runId: "run-a", status: "completed", usage: { calls: 3, inputTokens: 809_200 } }),
            runRow({ runId: "run-b", status: "completed" }),
        ];
        await refreshSidebarData("A", opts(null, runs));
        const snap = runsSnapshot();
        expect(snap.kind).toBe("loaded");
        if (snap.kind !== "loaded") return;
        expect(snap.runs.find((r) => r.runId === "run-a")?.usage).toEqual({ calls: 3, inputTokens: 809_200 });
        // Absent, not zeroed: the row still renders, it just carries no figure.
        expect(snap.runs.find((r) => r.runId === "run-b")?.usage).toBeUndefined();
        expect(snap.runs.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
    });

    test("a running step's view carries its own figure, and a step with nothing reported carries none", async () => {
        const run = runRow({ runId: "run-a", status: "running" });
        const o: RefreshOpts = {
            ...opts(null, [run]),
            loadRun: () =>
                okAsync(
                    detailOf(
                        run,
                        [
                            stepRow("qc", "running", { usage: { calls: 5, inputTokens: 42_600, outputTokens: 1_100 } }),
                            stepRow("align", "pending", { usage: { calls: 2 } }),
                        ],
                        // The run's own calls — the plan and synthesis frames it owns directly. An ABSENCE
                        // of a step, so it decorates no row.
                        { calls: 2, inputTokens: 9_000 },
                    ),
                ),
        };
        await refreshSidebarData("A", o);
        const steps = activeRunProgress().get("run-a")?.steps ?? [];
        expect(steps.map((s) => s.label)).toEqual(["qc", "align"]);
        expect(steps[0]?.usageFigure).toBe(`${GLYPHS.arrowUp}42.6k ${GLYPHS.arrowDown}1.1k`);
        // A step whose calls reported nothing carries NO figure rather than a zeroed one, and the
        // run-level remainder is nowhere among the step rows.
        expect(steps[1]?.usageFigure).toBeUndefined();
        expect(steps.some((s) => s.usageFigure?.includes("9.0k"))).toBe(false);
    });

    test("two active runs never see each other's step figures", async () => {
        const runs = [runRow({ runId: "run-a", status: "running" }), runRow({ runId: "run-b", status: "running" })];
        const o: RefreshOpts = {
            ...opts(null, runs),
            loadRun: (_analysisId, runId) =>
                okAsync(
                    detailOf(
                        runs.find((r) => r.runId === runId)!,
                        [stepRow("s", "running", { usage: runId === "run-a" ? { calls: 1, inputTokens: 800_000 } : { calls: 1, inputTokens: 1_200 } })],
                    ),
                ),
        };
        await refreshSidebarData("A", o);
        expect(activeRunProgress().get("run-a")?.steps[0]?.usageFigure).toBe(`${GLYPHS.arrowUp}800.0k`);
        expect(activeRunProgress().get("run-b")?.steps[0]?.usageFigure).toBe(`${GLYPHS.arrowUp}1.2k`);
    });
});
