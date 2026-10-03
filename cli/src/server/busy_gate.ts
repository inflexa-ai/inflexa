import { loadDataProfileStatus, queryActiveRunsByAnalysis, type DataProfileStatus, type Pool } from "@inflexa-ai/harness";
import { ResultAsync } from "neverthrow";

import type { BusyReason } from "../api/analyses.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { profileWorkInFlight } from "./profile_queue.ts";
import { hasRunningTurn } from "./turns.ts";

/** The reads of {@link workspaceBusyReasons}. Tests replace each one. */
export type BusyGateOpts = {
    readonly hasRunningTurn: (analysisId: string) => boolean;
    readonly profileWorkInFlight: (analysisId: string) => boolean;
    /** The data profile ledger row, or `null` when the analysis has no profile. The error channel means the ledger is unreadable. */
    readonly profileStatus: (pool: Pool, analysisId: string) => ResultAsync<DataProfileStatus | null, unknown>;
    /** The ids of the runs that the ledger records as active. The error channel means the ledger is unreadable. */
    readonly activeRunIds: (pool: Pool, analysisId: string) => ResultAsync<string[], unknown>;
    /** Whether a run id, or a `<runId>-N` child, has a live durable workflow. The error channel means the status table is unreadable. */
    readonly anyLiveRunWorkflow: (pool: Pool, runIds: readonly string[]) => ResultAsync<boolean, unknown>;
};

/** The production {@link BusyGateOpts}. */
export const DEFAULT_BUSY_GATE_OPTS: BusyGateOpts = {
    hasRunningTurn,
    profileWorkInFlight,
    profileStatus: loadDataProfileStatus,
    activeRunIds: (pool, analysisId) => queryActiveRunsByAnalysis(pool, analysisId).map((runs) => runs.map((run) => run.runId)),
    anyLiveRunWorkflow,
};

/**
 * Why the workspace folder of an analysis must not move or be retired now. Empty when it may.
 *
 * A rename moves the folder and a delete archives or removes it. The harness resolves paths beneath that
 * folder for the whole life of a run, and each run of the analysis executes in the server process. Three
 * kinds of work can hold the folder: a chat turn, a data profile, and a durable run that outlived the turn
 * that started it (`execute_analysis` returns before its workflow does).
 *
 * A data profile has two halves. The profile queue holds the drive that stages the inputs, and the drive
 * ends when it starts the profile workflow. The profile ledger row stays `running` until that workflow
 * settles. That row blocks with no liveness read: the parity drive resets a row with no workflow behind it
 * (`reconcileOrphanedDataProfile` of the harness).
 *
 * The ledger read asks for the ACTIVE runs of the analysis, not a page of its recent ones: a page answers
 * "is anything in flight" only while each live run is inside the window. The active set is bounded by the
 * live concurrency, not by the history.
 *
 * A `running` run ledger row blocks only while a LIVE workflow stands behind it. A crashed host leaves the row
 * `running` for ever, while the durable status of its workflow settles terminal. Thus the status table is
 * the liveness record. An unreadable ledger or status table reads as busy, because the gate must refuse
 * rather than guess. With no runtime, no workflow of this process can hold the folder.
 */
export async function workspaceBusyReasons(
    analysisId: string,
    runtime: HarnessRuntime | null,
    opts: BusyGateOpts = DEFAULT_BUSY_GATE_OPTS,
): Promise<BusyReason[]> {
    const reasons: BusyReason[] = [];
    if (opts.hasRunningTurn(analysisId)) reasons.push("chat_turn");
    const profileDrive = opts.profileWorkInFlight(analysisId);
    if (profileDrive) reasons.push("data_profile");
    if (runtime === null) return reasons;

    if (!profileDrive) {
        const profile = await opts.profileStatus(runtime.pool, analysisId);
        if (profile.isErr()) reasons.push("profile_state_unreadable");
        else if (profile.value?.status === "running") reasons.push("data_profile");
    }

    const active = await opts.activeRunIds(runtime.pool, analysisId);
    if (active.isErr()) return [...reasons, "run_state_unreadable"];
    if (active.value.length === 0) return reasons;
    const live = await opts.anyLiveRunWorkflow(runtime.pool, active.value);
    if (live.isErr()) return [...reasons, "run_state_unreadable"];
    return live.value ? [...reasons, "run"] : reasons;
}

/** The live-workflow read of {@link BusyGateOpts}: `PENDING` or `ENQUEUED` in the DBOS status table, for a run or one of its `<runId>-N` children. */
function anyLiveRunWorkflow(pool: Pool, runIds: readonly string[]): ResultAsync<boolean, unknown> {
    return ResultAsync.fromPromise(
        pool.query<{ n: string }>({
            text: `SELECT COUNT(*) AS n FROM dbos.workflow_status ws
                     WHERE ws.status IN ('PENDING', 'ENQUEUED')
                       AND EXISTS (
                           SELECT 1 FROM unnest($1::text[]) AS r(id)
                           WHERE ws.workflow_uuid = r.id OR ws.workflow_uuid LIKE r.id || '-%'
                       )`,
            values: [runIds],
        }),
        (cause) => cause,
    ).map((result) => Number(result.rows[0]?.n ?? 0) > 0);
}
