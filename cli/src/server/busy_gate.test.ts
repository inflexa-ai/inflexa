import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { Pool } from "@inflexa-ai/harness";

import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { DEFAULT_BUSY_GATE_OPTS, workspaceBusyReasons, type BusyGateOpts } from "./busy_gate.ts";

// The gate over a runtime whose pool answers from fixed rows. Each `as` cast below makes a stand-in that
// carries only the pool, which is the one part of the runtime that the gate reads.

/** A pool whose profile ledger row reads `running`, and whose DBOS status table holds the profile workflow as live. */
function poolWithRunningProfile(analysisId: string): Pool {
    const workflowId = `dataprofile:${analysisId}:nonce-1`;
    const query = async (config: string | { readonly text: string }): Promise<{ rows: unknown[]; rowCount: number }> => {
        const text = typeof config === "string" ? config : config.text;
        if (text.includes("cortex_analysis_state")) {
            const row = {
                data_profile_status: "running",
                data_profile_error: null,
                data_profile_started_at: "2026-10-02T15:57:11.894Z",
                data_profile_completed_at: null,
                data_profile_result: null,
                data_profile_workflow_id: workflowId,
                seed_input_file_ids: ["f1"],
            };
            return { rows: [row], rowCount: 1 };
        }
        if (text.includes("workflow_status")) return { rows: [{ n: "1", status: "PENDING", workflow_uuid: workflowId }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    };
    return { query } as unknown as Pool;
}

describe("workspaceBusyReasons", () => {
    test("a data profile workflow that runs holds the folder, with no profile drive in the queue", async () => {
        const analysisId = "analysis-1";
        const runtime = { pool: poolWithRunningProfile(analysisId) } as unknown as HarnessRuntime;
        // No turn, no queued drive, and no active run: the running profile workflow is the only work.
        const opts: BusyGateOpts = {
            ...DEFAULT_BUSY_GATE_OPTS,
            hasRunningTurn: () => false,
            profileWorkInFlight: () => false,
            liveDurableWork: () => okAsync({ runs: 0, profiles: 0 }),
        };

        expect(await workspaceBusyReasons(analysisId, runtime, opts)).toContain("data_profile");
    });

    test("a run with a live workflow holds the folder, and an unreadable ledger reads as busy", async () => {
        const runtime = { pool: poolWithRunningProfile("analysis-1") } as unknown as HarnessRuntime;
        const idle: BusyGateOpts = {
            ...DEFAULT_BUSY_GATE_OPTS,
            hasRunningTurn: () => false,
            profileWorkInFlight: () => false,
            profileStatus: () => okAsync(null),
        };

        expect(await workspaceBusyReasons("analysis-1", runtime, { ...idle, liveDurableWork: () => okAsync({ runs: 1, profiles: 0 }) })).toEqual(["run"]);
        expect(await workspaceBusyReasons("analysis-1", runtime, { ...idle, liveDurableWork: () => okAsync({ runs: 0, profiles: 0 }) })).toEqual([]);
        expect(await workspaceBusyReasons("analysis-1", runtime, { ...idle, liveDurableWork: () => errAsync(new Error("down")) })).toEqual([
            "run_state_unreadable",
        ]);
    });
});
