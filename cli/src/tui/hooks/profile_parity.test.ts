import { describe, expect, test } from "bun:test";

import type { ProfileParityOutcome } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import { driveProfileParity, type ParityDriverSeams } from "./profile_parity.ts";

// The driver's outcome→side-effect mapping is exercised offline: `check` is injected to return each
// parity outcome directly (no runtime, no ledger reads), and `refreshSidebar` is a spy. The single
// behaviour under test is the sidebar poke — `triggered` is the one outcome that seeded a ledger row
// the sidebar's own refresh triggers cannot see, so it (and ONLY it) must re-read the sidebar store.

// The driver reads only `.name`/`.id` off the analysis; the runtime is handed opaquely to `check`.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;
const RUNTIME = {} as unknown as HarnessRuntime;

/** Seams whose `check` yields a fixed outcome and whose `refreshSidebar` records the ids it was poked with. */
function driverSeams(outcome: ProfileParityOutcome): { seams: ParityDriverSeams; refreshedWith: string[] } {
    const refreshedWith: string[] = [];
    const seams: ParityDriverSeams = {
        check: async () => outcome,
        refreshSidebar: async (analysisId) => {
            refreshedWith.push(analysisId);
        },
    };
    return { seams, refreshedWith };
}

describe("driveProfileParity — sidebar poke", () => {
    test("triggered refreshes the sidebar with the analysis id", async () => {
        const { seams, refreshedWith } = driverSeams({ kind: "triggered" });
        await driveProfileParity(RUNTIME, ANALYSIS, seams);
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
            await driveProfileParity(RUNTIME, ANALYSIS, seams);
            expect(refreshedWith).toEqual([]);
        });
    }
});
