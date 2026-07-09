import { afterEach, describe, expect, test } from "bun:test";
import { ok, okAsync } from "neverthrow";
import { createRoot } from "solid-js";

import { GLYPHS } from "../../lib/design_system.ts";
import { Bus } from "../../lib/bus.ts";
import type { ProfileParityOutcome } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { BusEvent } from "../../types/events.ts";
import type { Notice } from "../theme.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { __resetBootForTest, startHarnessBoot, type BootDriver } from "./boot.ts";
import { __resetSidebarLiveForTest, refreshSidebarData, type RefreshSeams } from "./sidebar_live.ts";
import type { DataProfileStatus } from "@inflexa-ai/harness";
import {
    __resetProfileParityForTest,
    driveForceReprofile,
    driveProfileParity,
    watchProfileParity,
    type ForceDriverSeams,
    type ParityDriverSeams,
    type ParityWatchSeams,
} from "./profile_parity.ts";

// The two drivers' outcome→side-effect mappings are exercised offline: the check/force seam is injected
// to return each outcome directly (no runtime, no ledger reads), and `refreshSidebar`/`notify` are spies.
// Parity keeps managed-parity skips SILENT; force is a deliberate action so its skips SPEAK. Both share
// the mid-check swap guard (a `currentAnalysisId` that no longer matches the captured analysis drops both
// the poke and the notice). The reactive `watchProfileParity` edges (live input mutation + run
// completion) are driven with the injectable watch seams, the real boot store, and the real bus.

// The drivers read only `.name`/`.id` off the analysis; the runtime is handed opaquely to the check.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;
const RUNTIME = {} as unknown as HarnessRuntime;

/** Parity seams whose `check` yields a fixed outcome and whose `refreshSidebar`/`notify` record calls. */
function driverSeams(outcome: ProfileParityOutcome): { seams: ParityDriverSeams; refreshedWith: string[]; notices: Notice[] } {
    const refreshedWith: string[] = [];
    const notices: Notice[] = [];
    const seams: ParityDriverSeams = {
        check: async () => outcome,
        refreshSidebar: async (analysisId) => {
            refreshedWith.push(analysisId);
        },
        notify: (notice) => {
            notices.push(notice);
        },
    };
    return { seams, refreshedWith, notices };
}

/** Force seams whose `force` yields a fixed outcome and whose `refreshSidebar`/`notify` record calls. */
function forceSeams(outcome: ProfileParityOutcome): { seams: ForceDriverSeams; refreshedWith: string[]; notices: Notice[] } {
    const refreshedWith: string[] = [];
    const notices: Notice[] = [];
    const seams: ForceDriverSeams = {
        force: async () => outcome,
        refreshSidebar: async (analysisId) => {
            refreshedWith.push(analysisId);
        },
        notify: (notice) => {
            notices.push(notice);
        },
    };
    return { seams, refreshedWith, notices };
}

describe("driveProfileParity — sidebar poke", () => {
    // `triggered` seeded a running row and `cleared` nulled a stale one; both change ledger state the
    // sidebar's own refresh triggers can't see, so both (and ONLY they) poke it.
    const pokeOutcomes: ProfileParityOutcome[] = [{ kind: "triggered", restarted: false }, { kind: "cleared" }];
    for (const outcome of pokeOutcomes) {
        test(`${outcome.kind} refreshes the sidebar with the analysis id`, async () => {
            const { seams, refreshedWith } = driverSeams(outcome);
            await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
            expect(refreshedWith).toEqual([ANALYSIS.id]);
        });
    }

    // Every other outcome changes no ledger state the sidebar needs, so none of them poke it —
    // `skipped_failed` joins this silent set (a failed row awaits a deliberate retry).
    const silentOutcomes: ProfileParityOutcome[] = [
        { kind: "already_profiled" },
        { kind: "already_running" },
        { kind: "no_inputs" },
        { kind: "skipped_failed" },
        { kind: "failed", reason: "the profile workflow could not be started" },
    ];
    for (const outcome of silentOutcomes) {
        test(`${outcome.kind} does not refresh the sidebar`, async () => {
            const { seams, refreshedWith } = driverSeams(outcome);
            await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
            expect(refreshedWith).toEqual([]);
        });
    }
});

describe("driveProfileParity — notices", () => {
    test("triggered (restarted: false) raises the first-time Profiling notice", async () => {
        const { seams, notices } = driverSeams({ kind: "triggered", restarted: false });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });

    test("triggered (restarted: true) words it as Re-profiling", async () => {
        const { seams, notices } = driverSeams({ kind: "triggered", restarted: true });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(notices).toEqual([{ kind: "info", text: `Re-profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });

    test("cleared raises an info notice", async () => {
        const { seams, notices } = driverSeams({ kind: "cleared" });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(notices).toEqual([{ kind: "info", text: `Data profile cleared — "${ANALYSIS.name}" has no inputs` }]);
    });

    test("failed raises a warn notice carrying the reason", async () => {
        const { seams, notices } = driverSeams({ kind: "failed", reason: "boom" });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(notices).toEqual([{ kind: "warn", text: `Could not start profiling "${ANALYSIS.name}": boom` }]);
    });

    // Managed-parity skips stay silent — `skipped_failed` especially, since the sidebar already shows
    // the failed state and a toast would nag on every open while retry is deliberate.
    const silentOutcomes: ProfileParityOutcome[] = [
        { kind: "already_profiled" },
        { kind: "already_running" },
        { kind: "no_inputs" },
        { kind: "skipped_failed" },
    ];
    for (const outcome of silentOutcomes) {
        test(`${outcome.kind} raises no notice`, async () => {
            const { seams, notices } = driverSeams(outcome);
            await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
            expect(notices).toEqual([]);
        });
    }
});

describe("driveProfileParity — mid-check analysis swap guard", () => {
    test("swapped mid-check neither pokes the sidebar nor notifies", async () => {
        const { seams, refreshedWith, notices } = driverSeams({ kind: "triggered", restarted: false });
        // The open analysis moved off the captured one while `check` was in flight.
        await driveProfileParity(RUNTIME, ANALYSIS, () => "a2", seams);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([]);
    });

    test("unswapped pokes the sidebar and notifies", async () => {
        const { seams, refreshedWith, notices } = driverSeams({ kind: "triggered", restarted: false });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(refreshedWith).toEqual([ANALYSIS.id]);
        expect(notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });
});

describe("driveForceReprofile — deliberate re-profile speaks its skips", () => {
    test("triggered pokes the sidebar and words the notice by restarted", async () => {
        const first = forceSeams({ kind: "triggered", restarted: false });
        await driveForceReprofile(RUNTIME, ANALYSIS, () => ANALYSIS.id, first.seams);
        expect(first.refreshedWith).toEqual([ANALYSIS.id]);
        expect(first.notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);

        const again = forceSeams({ kind: "triggered", restarted: true });
        await driveForceReprofile(RUNTIME, ANALYSIS, () => ANALYSIS.id, again.seams);
        expect(again.notices).toEqual([{ kind: "info", text: `Re-profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });

    test("already_running refuses with an info notice and no poke", async () => {
        const { seams, refreshedWith, notices } = forceSeams({ kind: "already_running" });
        await driveForceReprofile(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([{ kind: "info", text: "A profile run is already in progress" }]);
    });

    test("no_inputs refuses with a warn notice and no poke", async () => {
        const { seams, refreshedWith, notices } = forceSeams({ kind: "no_inputs" });
        await driveForceReprofile(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([{ kind: "warn", text: "No inputs to profile — add inputs first" }]);
    });

    test("failed raises the same warn notice parity does", async () => {
        const { seams, notices } = forceSeams({ kind: "failed", reason: "boom" });
        await driveForceReprofile(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(notices).toEqual([{ kind: "warn", text: `Could not start profiling "${ANALYSIS.name}": boom` }]);
    });

    test("swapped mid-check neither pokes the sidebar nor notifies", async () => {
        const { seams, refreshedWith, notices } = forceSeams({ kind: "triggered", restarted: false });
        await driveForceReprofile(RUNTIME, ANALYSIS, () => "a2", seams);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([]);
    });
});

// --- reactive edges (bus input mutation + run completion) -----------------------------------------

const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;

afterEach(() => {
    __resetProfileParityForTest();
    __resetBootForTest();
    __resetSidebarLiveForTest();
});

/** A booting driver that resolves ready, so `harnessRuntime()` becomes non-null and edge 1 can fire. */
const readyDriver: BootDriver = async () => ok({ model: "m", pool: {} } as unknown as HarnessRuntime);

/** A mutable workspace stand-in — the reactive edges read `.analysis` off it live (no reactive store). */
function wsMut(id: string): Workspace {
    return { analysis: { id, name: `n-${id}` } as unknown as Analysis } as unknown as Workspace;
}

/** Record every `drive` call and every armed timer, and expose an injectable cancel counter. */
function watchHarness(): { seams: ParityWatchSeams; drives: string[]; scheduled: Array<{ fn: () => void; ms: number }>; cancels: () => number } {
    const drives: string[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    let cancelCount = 0;
    const seams: ParityWatchSeams = {
        drive: (_runtime, analysis) => void drives.push(analysis.id),
        schedule: (fn, ms) => {
            scheduled.push({ fn, ms });
            return () => {
                cancelCount += 1;
            };
        },
    };
    return { seams, drives, scheduled, cancels: () => cancelCount };
}

/** Mount `watchProfileParity` in a disposable reactive root; returns the dispose. */
function mountWatch(ws: Workspace, seams: ParityWatchSeams): () => void {
    let dispose!: () => void;
    createRoot((d) => {
        dispose = d;
        watchProfileParity(ws, seams);
    });
    return dispose;
}

function emitInput(type: "prov.input_added" | "prov.input_removed", analysisId: string): void {
    // The handler reads only `.type`/`.analysisId`; a partial cast keeps the emit offline of the prov types.
    Bus.emit("inflexa", { type, analysisId } as unknown as BusEvent);
}

function profileStatus(over: Partial<DataProfileStatus>): DataProfileStatus {
    return {
        status: "running",
        error: null,
        startedAt: "2026-07-08T00:00:00.000Z",
        completedAt: null,
        result: null,
        seedInputFileIds: null,
        ...over,
    };
}

function refreshSeams(profile: DataProfileStatus | null): RefreshSeams {
    return { runtime: () => fakeRuntime, loadProfile: () => okAsync(profile), loadRuns: () => okAsync([]) };
}

describe("watchProfileParity — live input-mutation edge", () => {
    test("an input event for the open analysis schedules a debounced drift check that drives", async () => {
        const h = watchHarness();
        const dispose = mountWatch(wsMut("A"), h.seams);
        try {
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver); // edge 1 fires once at ready
            h.drives.length = 0; // isolate the bus edge from the boot edge

            emitInput("prov.input_added", "A");
            expect(h.scheduled).toHaveLength(1);
            expect(h.scheduled[0]?.ms).toBe(500);
            expect(h.drives).toEqual([]); // nothing until the debounce fires

            h.scheduled[0]?.fn(); // the trailing-edge timer elapses
            expect(h.drives).toEqual(["A"]);
        } finally {
            dispose();
        }
    });

    test("a burst re-arms the timer so only the last event drives once", async () => {
        const h = watchHarness();
        const dispose = mountWatch(wsMut("A"), h.seams);
        try {
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver);
            h.drives.length = 0;

            emitInput("prov.input_added", "A");
            emitInput("prov.input_added", "A");
            emitInput("prov.input_removed", "A");
            expect(h.scheduled).toHaveLength(3); // each event armed a fresh timer
            expect(h.cancels()).toBe(2); // …after cancelling the two prior ones

            h.scheduled[h.scheduled.length - 1]?.fn(); // only the survivor fires
            expect(h.drives).toEqual(["A"]);
        } finally {
            dispose();
        }
    });

    test("an event for a different analysis is ignored", async () => {
        const h = watchHarness();
        const dispose = mountWatch(wsMut("A"), h.seams);
        try {
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver);
            h.drives.length = 0;
            emitInput("prov.input_added", "B"); // not the open analysis
            expect(h.scheduled).toHaveLength(0);
        } finally {
            dispose();
        }
    });

    test("pre-ready input events schedule nothing (no runtime to check against)", async () => {
        const h = watchHarness();
        const dispose = mountWatch(wsMut("A"), h.seams);
        try {
            emitInput("prov.input_added", "A"); // boot is idle
            expect(h.scheduled).toHaveLength(0);
        } finally {
            dispose();
        }
    });

    test("a swap during the debounce window drops the check at fire time", async () => {
        const h = watchHarness();
        const ws = wsMut("A");
        const dispose = mountWatch(ws, h.seams);
        try {
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver);
            h.drives.length = 0;

            emitInput("prov.input_added", "A");
            expect(h.scheduled).toHaveLength(1);
            ws.analysis = { id: "B", name: "n-B" } as unknown as Analysis; // moved on before the timer fires
            h.scheduled[0]?.fn();
            expect(h.drives).toEqual([]); // the fire re-read the live analysis and bailed
        } finally {
            dispose();
        }
    });
});

describe("watchProfileParity — run-completion edge", () => {
    test("a running→completed transition drives once; other transitions do not", async () => {
        const h = watchHarness();
        const dispose = mountWatch(wsMut("A"), h.seams);
        try {
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver);
            h.drives.length = 0; // ignore the boot edge

            await refreshSidebarData("A", refreshSeams(profileStatus({ status: "running" })));
            expect(h.drives).toEqual([]); // entering running is not the edge

            await refreshSidebarData("A", refreshSeams(profileStatus({ status: "completed", completedAt: "2026-07-08T00:00:05.000Z" })));
            expect(h.drives).toEqual(["A"]); // the running→completed down-edge fires
        } finally {
            dispose();
        }
    });

    test("a completed snapshot without a preceding running does not drive", async () => {
        const h = watchHarness();
        const dispose = mountWatch(wsMut("A"), h.seams);
        try {
            await startHarnessBoot({} as ResolvedHarnessConfig, readyDriver);
            h.drives.length = 0;
            await refreshSidebarData("A", refreshSeams(profileStatus({ status: "completed", completedAt: "2026-07-08T00:00:05.000Z" })));
            expect(h.drives).toEqual([]); // no running→completed transition, no drive
        } finally {
            dispose();
        }
    });
});

// The profile-work queue. `stageInputs` rm/relinks one session tree and then deletes every on-disk file
// absent from its own manifest, and the empty-branch clear nulls `seed_input_file_ids` — neither is
// serialized by the harness's ledger CAS, which runs only after staging. So the drivers must exclude
// each other in-process. Assertions are on enter/exit ORDER, never on timing.
describe("profile drives serialize", () => {
    afterEach(() => __resetProfileParityForTest());

    /**
     * Parity seams whose `check` records enter/exit around a gate the test releases. `label` identifies
     * the drive in the trace, so an overlap shows up as `enter B` between `enter A` and `exit A`.
     */
    function gatedParitySeams(label: string, trace: string[]): { seams: ParityDriverSeams; release: () => void } {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        return {
            seams: {
                check: async () => {
                    trace.push(`enter ${label}`);
                    await gate;
                    trace.push(`exit ${label}`);
                    return { kind: "already_profiled" } as ProfileParityOutcome;
                },
                refreshSidebar: async () => {},
                notify: () => {},
            },
            release: () => release(),
        };
    }

    test("a second parity drive never enters while the first is staging", async () => {
        const trace: string[] = [];
        const a = gatedParitySeams("A", trace);
        const b = gatedParitySeams("B", trace);

        const driveA = driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, a.seams);
        const driveB = driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, b.seams);

        // B is queued behind A: releasing B's gate first must not let B enter.
        b.release();
        await Promise.resolve();
        expect(trace).toEqual(["enter A"]);

        a.release();
        await driveA;
        await driveB;
        expect(trace).toEqual(["enter A", "exit A", "enter B", "exit B"]);
    });

    test("a force reprofile queued mid-parity waits for it — they share one session tree", async () => {
        const trace: string[] = [];
        const parity = gatedParitySeams("parity", trace);

        let releaseForce!: () => void;
        const forceGate = new Promise<void>((r) => {
            releaseForce = r;
        });
        const forceSeams: ForceDriverSeams = {
            force: async () => {
                trace.push("enter force");
                await forceGate;
                trace.push("exit force");
                return { kind: "triggered", restarted: true };
            },
            refreshSidebar: async () => {},
            notify: () => {},
        };

        const p = driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, parity.seams);
        const f = driveForceReprofile(RUNTIME, ANALYSIS, () => ANALYSIS.id, forceSeams);

        releaseForce();
        await Promise.resolve();
        expect(trace).toEqual(["enter parity"]);

        parity.release();
        await p;
        await f;
        expect(trace).toEqual(["enter parity", "exit parity", "enter force", "exit force"]);
    });

    test("a rejected drive does not wedge the queue behind it", async () => {
        const trace: string[] = [];
        const boom: ParityDriverSeams = {
            check: async () => {
                trace.push("enter boom");
                throw new Error("staging exploded");
            },
            refreshSidebar: async () => {},
            notify: () => {},
        };
        const next = gatedParitySeams("next", trace);

        const failing = driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, boom);
        const queued = driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, next.seams);

        // The caller still observes the failure — the queue swallows it only for the SUCCESSORS.
        await expect(failing).rejects.toThrow("staging exploded");

        next.release();
        await queued;
        expect(trace).toEqual(["enter boom", "enter next", "exit next"]);
    });

    test("drives queued after the tail settles still run", async () => {
        const trace: string[] = [];
        const first = gatedParitySeams("first", trace);
        first.release();
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, first.seams);

        const second = gatedParitySeams("second", trace);
        second.release();
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, second.seams);

        expect(trace).toEqual(["enter first", "exit first", "enter second", "exit second"]);
    });
});
