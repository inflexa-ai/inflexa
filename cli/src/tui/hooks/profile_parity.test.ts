import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { createRoot } from "solid-js";

import type { ChatContext, DataProfileState, DataProfileView, ProfileOutcome } from "../../api/runs.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Notice } from "../theme.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, __setBootStateForTest } from "./boot.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshOpts } from "./sidebar_live.ts";
import {
    __resetProfileParityForTest,
    driveForceReprofile,
    driveProfileParity,
    gatedForceReprofile,
    gatedProfileParity,
    watchProfileParity,
    type ForceDriverOpts,
    type ParityDriverOpts,
    type ParityWatchOpts,
} from "./profile_parity.ts";

// The two drivers' outcome→side-effect mappings are exercised offline: the server read is injected to
// answer each outcome directly, and `refreshSidebar`/`notify` are spies. Parity keeps managed-parity skips
// SILENT; force is a deliberate action so its skips SPEAK. Both share the swap guard (a
// `currentAnalysisId` that no longer matches the captured analysis drops both the poke and the notice).
// The reactive `watchProfileParity` edges (boot ready / swap, and a run reaching either terminal state)
// are driven with an injected `drive`, the real boot store, and the real sidebar snapshot. The profile
// queue and the re-profile after an input change are the server's: src/server/profile_queue.test.ts and
// src/server/routes/runs.test.ts cover them.

// The drivers read only `.name`/`.id` off the analysis.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;

/** A 500 of the server, as the client gives it. */
const SERVER_ERROR: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "The server failed to handle the request." } };

/** The body of `GET {A}/chat-context` for a drive whose outcome is `parity`. */
function chatContext(parity: ProfileOutcome): ChatContext {
    return { analysisId: ANALYSIS.id, agentId: "conversation-agent", dataProfile: { status: null }, parity };
}

/** Parity options whose `check` answers a fixed outcome and whose `refreshSidebar`/`notify` record calls. */
function driverOpts(outcome: ProfileOutcome): { opts: ParityDriverOpts; refreshedWith: string[]; notices: Notice[]; checks: string[] } {
    const refreshedWith: string[] = [];
    const notices: Notice[] = [];
    const checks: string[] = [];
    const opts: ParityDriverOpts = {
        check: (analysisId) => {
            checks.push(analysisId);
            return okAsync(chatContext(outcome));
        },
        refreshSidebar: async (analysisId) => {
            refreshedWith.push(analysisId);
        },
        notify: (notice) => {
            notices.push(notice);
        },
    };
    return { opts, refreshedWith, notices, checks };
}

/** Force options whose `force` answers a fixed outcome and whose `refreshSidebar`/`notify` record calls. */
function forceOpts(outcome: ProfileOutcome): { opts: ForceDriverOpts; refreshedWith: string[]; notices: Notice[] } {
    const refreshedWith: string[] = [];
    const notices: Notice[] = [];
    const opts: ForceDriverOpts = {
        force: () => okAsync({ outcome }),
        refreshSidebar: async (analysisId) => {
            refreshedWith.push(analysisId);
        },
        notify: (notice) => {
            notices.push(notice);
        },
    };
    return { opts, refreshedWith, notices };
}

describe("driveProfileParity — sidebar poke", () => {
    // `triggered` seeded a running row and `cleared` nulled a stale one; both change ledger state the
    // sidebar's own refresh triggers can't see, so both (and ONLY they) poke it.
    const pokeOutcomes: ProfileOutcome[] = [
        { kind: "triggered", restarted: false, materialized: true },
        { kind: "cleared", materialized: false },
    ];
    for (const outcome of pokeOutcomes) {
        test(`${outcome.kind} refreshes the sidebar with the analysis id`, async () => {
            const { opts, refreshedWith } = driverOpts(outcome);
            await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
            expect(refreshedWith).toEqual([ANALYSIS.id]);
        });
    }

    // Every other outcome changes no ledger state the sidebar needs, so none of them poke it —
    // `skipped_failed` joins this silent set (a failed row awaits a deliberate retry).
    const silentOutcomes: ProfileOutcome[] = [
        { kind: "already_profiled", materialized: true },
        { kind: "already_running", materialized: false },
        { kind: "no_inputs", materialized: false },
        { kind: "skipped_failed", materialized: true },
        { kind: "failed", reason: "the profile workflow could not be started", materialized: false },
    ];
    for (const outcome of silentOutcomes) {
        test(`${outcome.kind} does not refresh the sidebar`, async () => {
            const { opts, refreshedWith } = driverOpts(outcome);
            await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
            expect(refreshedWith).toEqual([]);
        });
    }
});

describe("driveProfileParity — notices", () => {
    test("asks the chat context of the captured analysis", async () => {
        const { opts, checks } = driverOpts({ kind: "already_profiled", materialized: true });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
        expect(checks).toEqual([ANALYSIS.id]);
    });

    test("triggered (restarted: false) raises the first-time Profiling notice", async () => {
        const { opts, notices } = driverOpts({ kind: "triggered", restarted: false, materialized: true });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
        expect(notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });

    test("triggered (restarted: true) words it as Re-profiling", async () => {
        const { opts, notices } = driverOpts({ kind: "triggered", restarted: true, materialized: true });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
        expect(notices).toEqual([{ kind: "info", text: `Re-profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });

    test("cleared raises an info notice", async () => {
        const { opts, notices } = driverOpts({ kind: "cleared", materialized: false });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
        expect(notices).toEqual([{ kind: "info", text: `Data profile cleared — "${ANALYSIS.name}" has no inputs` }]);
    });

    test("failed raises a warn notice carrying the reason", async () => {
        const { opts, notices } = driverOpts({ kind: "failed", reason: "boom", materialized: false });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
        expect(notices).toEqual([{ kind: "warn", text: `Could not start profiling "${ANALYSIS.name}": boom` }]);
    });

    test("a client error raises the same warn notice, with the error of the client as the reason", async () => {
        const { opts, refreshedWith, notices } = driverOpts({ kind: "already_profiled", materialized: true });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, { ...opts, check: () => errAsync(SERVER_ERROR) });
        expect(notices).toEqual([{ kind: "warn", text: `Could not start profiling "${ANALYSIS.name}": ${describeClientError(SERVER_ERROR)}` }]);
        expect(refreshedWith).toEqual([]);
    });

    // Managed-parity skips stay silent — `skipped_failed` especially, since the sidebar already shows
    // the failed state and a toast would nag on every open while retry is deliberate.
    const silentOutcomes: ProfileOutcome[] = [
        { kind: "already_profiled", materialized: true },
        { kind: "already_running", materialized: false },
        { kind: "no_inputs", materialized: false },
        { kind: "skipped_failed", materialized: true },
    ];
    for (const outcome of silentOutcomes) {
        test(`${outcome.kind} raises no notice`, async () => {
            const { opts, notices } = driverOpts(outcome);
            await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
            expect(notices).toEqual([]);
        });
    }
});

describe("driveProfileParity — analysis swap guard", () => {
    test("swapped while the request was in flight neither pokes the sidebar nor notifies", async () => {
        const { opts, refreshedWith, notices, checks } = driverOpts({ kind: "triggered", restarted: false, materialized: true });
        // Open at the start of the drive, moved off the captured analysis by the time the response lands.
        let reads = 0;
        await driveProfileParity(ANALYSIS, () => (reads++ === 0 ? ANALYSIS.id : "a2"), opts);
        expect(checks).toEqual([ANALYSIS.id]);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([]);
    });

    test("a drive whose analysis is no longer open asks the server nothing", async () => {
        // A gated drive can wait on the sandbox gate while the user swaps away.
        const { opts, checks, notices } = driverOpts({ kind: "triggered", restarted: false, materialized: true });
        await driveProfileParity(ANALYSIS, () => "a2", opts);
        expect(checks).toEqual([]);
        expect(notices).toEqual([]);
    });

    test("unswapped pokes the sidebar and notifies", async () => {
        const { opts, refreshedWith, notices } = driverOpts({ kind: "triggered", restarted: false, materialized: true });
        await driveProfileParity(ANALYSIS, () => ANALYSIS.id, opts);
        expect(refreshedWith).toEqual([ANALYSIS.id]);
        expect(notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });
});

describe("driveForceReprofile — deliberate re-profile speaks its skips", () => {
    test("triggered pokes the sidebar and words the notice by restarted", async () => {
        const first = forceOpts({ kind: "triggered", restarted: false, materialized: true });
        await driveForceReprofile(ANALYSIS, () => ANALYSIS.id, first.opts);
        expect(first.refreshedWith).toEqual([ANALYSIS.id]);
        expect(first.notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);

        const again = forceOpts({ kind: "triggered", restarted: true, materialized: true });
        await driveForceReprofile(ANALYSIS, () => ANALYSIS.id, again.opts);
        expect(again.notices).toEqual([{ kind: "info", text: `Re-profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });

    test("already_running refuses with an info notice and no poke", async () => {
        const { opts, refreshedWith, notices } = forceOpts({ kind: "already_running", materialized: false });
        await driveForceReprofile(ANALYSIS, () => ANALYSIS.id, opts);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([{ kind: "info", text: "A profile run is already in progress" }]);
    });

    test("no_inputs refuses with a warn notice and no poke", async () => {
        const { opts, refreshedWith, notices } = forceOpts({ kind: "no_inputs", materialized: false });
        await driveForceReprofile(ANALYSIS, () => ANALYSIS.id, opts);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([{ kind: "warn", text: "No inputs to profile — add inputs first" }]);
    });

    test("failed raises the same warn notice parity does", async () => {
        const { opts, notices } = forceOpts({ kind: "failed", reason: "boom", materialized: false });
        await driveForceReprofile(ANALYSIS, () => ANALYSIS.id, opts);
        expect(notices).toEqual([{ kind: "warn", text: `Could not start profiling "${ANALYSIS.name}": boom` }]);
    });

    test("a client error raises the warn notice, with the error of the client as the reason", async () => {
        const { opts, refreshedWith, notices } = forceOpts({ kind: "triggered", restarted: false, materialized: true });
        await driveForceReprofile(ANALYSIS, () => ANALYSIS.id, { ...opts, force: () => errAsync(SERVER_ERROR) });
        expect(notices).toEqual([{ kind: "warn", text: `Could not start profiling "${ANALYSIS.name}": ${describeClientError(SERVER_ERROR)}` }]);
        expect(refreshedWith).toEqual([]);
    });

    test("swapped while the request was in flight neither pokes the sidebar nor notifies", async () => {
        const { opts, refreshedWith, notices } = forceOpts({ kind: "triggered", restarted: false, materialized: true });
        await driveForceReprofile(ANALYSIS, () => "a2", opts);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([]);
    });
});

describe("the sandbox gate", () => {
    /** Run one gated drive to its decision, and give the analyses that the drive reached. */
    async function gatedRun(verdict: "ready" | "blocked", gated: typeof gatedProfileParity | typeof gatedForceReprofile): Promise<string[]> {
        const driven: string[] = [];
        gated(ANALYSIS, () => ANALYSIS.id, {
            gate: () => Promise.resolve(verdict),
            drive: (analysis) => {
                driven.push(analysis.id);
            },
        });
        // The decision lands on a microtask after the gate answers; a macrotask runs after each of them.
        await Promise.sleep(0);
        return driven;
    }

    test("a blocked gate starts no drive, and a ready gate starts one", async () => {
        expect(await gatedRun("blocked", gatedProfileParity)).toEqual([]);
        expect(await gatedRun("ready", gatedProfileParity)).toEqual([ANALYSIS.id]);
    });

    test("the force drive waits on the same gate", async () => {
        expect(await gatedRun("blocked", gatedForceReprofile)).toEqual([]);
        expect(await gatedRun("ready", gatedForceReprofile)).toEqual([ANALYSIS.id]);
    });
});

// --- reactive edges (boot ready / swap + run completion) ------------------------------------------

afterEach(() => {
    __resetProfileParityForTest();
    __resetBootForTest();
    __resetSidebarLiveForTest();
});

function bootReady(): void {
    __setBootStateForTest({ phase: "ready", model: "m", connection: { provider: "anthropic", mode: "cliproxy" } });
}

/** A mutable workspace stand-in — the reactive edges read `.analysis` off it live (no reactive store). */
function wsMut(id: string): Workspace {
    return { analysis: { id, name: `n-${id}` } as unknown as Analysis } as unknown as Workspace;
}

/** Record every `drive` call. */
function watchRecorder(): { opts: ParityWatchOpts; drives: string[] } {
    const drives: string[] = [];
    return {
        opts: {
            drive: (analysis) => {
                drives.push(analysis.id);
            },
        },
        drives,
    };
}

/** Mount `watchProfileParity` in a disposable reactive root; returns the dispose. */
function mountWatch(ws: Workspace, opts: ParityWatchOpts): () => void {
    let dispose: () => void = () => undefined;
    createRoot((d) => {
        dispose = d;
        watchProfileParity(ws, opts);
    });
    return dispose;
}

function profileState(over: Partial<DataProfileState>): DataProfileState {
    return {
        status: "running",
        error: null,
        startedAt: "2026-07-08T00:00:00.000Z",
        completedAt: null,
        result: null,
        workflowId: null,
        seedInputFileIds: null,
        ...over,
    };
}

/** Refresh options that publish `profile` as the profile snapshot, with no runs. */
function refreshOpts(profile: DataProfileView): RefreshOpts {
    return {
        ready: () => true,
        loadProfile: () => okAsync(profile),
        loadRuns: () => okAsync([]),
        loadActiveRuns: () => okAsync([]),
        loadRun: () => errAsync(SERVER_ERROR),
    };
}

describe("watchProfileParity — boot ready / swap edge", () => {
    test("never drives before ready, then drives once at the ready edge", () => {
        const h = watchRecorder();
        const dispose = mountWatch(wsMut("A"), h.opts);
        try {
            expect(h.drives).toEqual([]);
            bootReady();
            expect(h.drives).toEqual(["A"]);
        } finally {
            dispose();
        }
    });

    test("de-dups per analysis: a second mount of the same analysis does not drive again", () => {
        bootReady();
        const h = watchRecorder();
        const first = mountWatch(wsMut("A"), h.opts);
        first();
        const second = mountWatch(wsMut("A"), h.opts);
        try {
            expect(h.drives).toEqual(["A"]);
        } finally {
            second();
        }
    });

    test("a different analysis drives again", () => {
        bootReady();
        const h = watchRecorder();
        const first = mountWatch(wsMut("A"), h.opts);
        first();
        const second = mountWatch(wsMut("B"), h.opts);
        try {
            expect(h.drives).toEqual(["A", "B"]);
        } finally {
            second();
        }
    });
});

describe("watchProfileParity — run-terminal edge", () => {
    test("a running→failed transition drives the re-check too", async () => {
        // A live run suppresses the whole check, materialization included, so a run that DIES must
        // release the deferred work exactly as one that completes: inputs registered mid-profile were
        // skipped once as `already_running`, and without this edge nothing would re-check them until the
        // next chat open.
        bootReady();
        const h = watchRecorder();
        const dispose = mountWatch(wsMut("A"), h.opts);
        try {
            h.drives.length = 0; // ignore the boot edge

            await refreshSidebarData("A", refreshOpts(profileState({ status: "running" })));
            expect(h.drives).toEqual([]);

            await refreshSidebarData("A", refreshOpts(profileState({ status: "failed", error: "the sandbox died" })));
            expect(h.drives).toEqual(["A"]);
        } finally {
            dispose();
        }
    });

    test("a running→completed transition drives once; entering running does not", async () => {
        bootReady();
        const h = watchRecorder();
        const dispose = mountWatch(wsMut("A"), h.opts);
        try {
            h.drives.length = 0;

            await refreshSidebarData("A", refreshOpts(profileState({ status: "running" })));
            expect(h.drives).toEqual([]); // entering running is not the edge

            await refreshSidebarData("A", refreshOpts(profileState({ status: "completed", completedAt: "2026-07-08T00:00:05.000Z" })));
            expect(h.drives).toEqual(["A"]); // the running→completed down-edge fires
        } finally {
            dispose();
        }
    });

    test("a completed snapshot without a preceding running does not drive", async () => {
        bootReady();
        const h = watchRecorder();
        const dispose = mountWatch(wsMut("A"), h.opts);
        try {
            h.drives.length = 0;
            await refreshSidebarData("A", refreshOpts(profileState({ status: "completed", completedAt: "2026-07-08T00:00:05.000Z" })));
            expect(h.drives).toEqual([]);
        } finally {
            dispose();
        }
    });

    test("a swap transitioning the shared snapshot A-running → B-completed or B-failed fires nothing", async () => {
        // The shared profile snapshot is not analysis-scoped, so an analysis swap can walk it
        // A-running → B-terminal — a status pair that reads as a terminal transition but is B's, not A's.
        for (const terminal of [
            profileState({ status: "completed", completedAt: "2026-07-08T00:00:05.000Z" }),
            profileState({ status: "failed", error: "B's own failure" }),
        ]) {
            __resetSidebarLiveForTest();
            __resetProfileParityForTest();
            bootReady();
            const h = watchRecorder();
            const ws = wsMut("A");
            const dispose = mountWatch(ws, h.opts);
            try {
                h.drives.length = 0;
                await refreshSidebarData("A", refreshOpts(profileState({ status: "running" })));
                ws.analysis = { id: "B", name: "n-B" } as unknown as Analysis;
                await refreshSidebarData("B", refreshOpts(terminal));
                expect(h.drives).toEqual([]);
            } finally {
                dispose();
            }
        }
    });
});
