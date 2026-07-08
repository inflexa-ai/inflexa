import { describe, expect, test } from "bun:test";

import { GLYPHS } from "../../lib/design_system.ts";
import type { ProfileParityOutcome } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Notice } from "../theme.ts";
import { driveProfileParity, type ParityDriverSeams } from "./profile_parity.ts";

// The driver's outcome→side-effect mapping is exercised offline: `check` is injected to return each
// parity outcome directly (no runtime, no ledger reads), and `refreshSidebar`/`notify` are spies. The
// behaviours under test are (1) the sidebar poke — `triggered` is the one outcome that seeded a ledger
// row the sidebar's own refresh triggers cannot see, so it (and ONLY it) must re-read the store — and
// (2) the mid-check swap guard: a `currentAnalysisId` that no longer matches the captured analysis at
// resolve time must drop BOTH the poke and the notice (staging is slow enough for a real swap race).

// The driver reads only `.name`/`.id` off the analysis; the runtime is handed opaquely to `check`.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;
const RUNTIME = {} as unknown as HarnessRuntime;

/** Seams whose `check` yields a fixed outcome and whose `refreshSidebar`/`notify` record their calls. */
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

describe("driveProfileParity — sidebar poke", () => {
    test("triggered refreshes the sidebar with the analysis id", async () => {
        const { seams, refreshedWith } = driverSeams({ kind: "triggered" });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(refreshedWith).toEqual([ANALYSIS.id]);
    });

    // Every non-`triggered` outcome changes no ledger state the sidebar needs, so none of them poke it.
    const silentOutcomes: ProfileParityOutcome[] = [
        { kind: "already_profiled" },
        { kind: "already_running" },
        { kind: "no_inputs" },
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

describe("driveProfileParity — mid-check analysis swap guard", () => {
    test("swapped mid-check neither pokes the sidebar nor notifies", async () => {
        const { seams, refreshedWith, notices } = driverSeams({ kind: "triggered" });
        // The open analysis moved off the captured one while `check` was in flight.
        await driveProfileParity(RUNTIME, ANALYSIS, () => "a2", seams);
        expect(refreshedWith).toEqual([]);
        expect(notices).toEqual([]);
    });

    test("unswapped pokes the sidebar and notifies", async () => {
        const { seams, refreshedWith, notices } = driverSeams({ kind: "triggered" });
        await driveProfileParity(RUNTIME, ANALYSIS, () => ANALYSIS.id, seams);
        expect(refreshedWith).toEqual([ANALYSIS.id]);
        expect(notices).toEqual([{ kind: "info", text: `Profiling "${ANALYSIS.name}" data${GLYPHS.ellipsis}` }]);
    });
});
