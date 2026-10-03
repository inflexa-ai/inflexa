import { loadDataProfileStatus, type DataProfileStatus, type Pool } from "@inflexa-ai/harness";
import type { ResultAsync } from "neverthrow";

import type { BusyReason } from "../api/analyses.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { countLiveDurableWork, type LiveDurableWork } from "./durable_work.ts";
import { profileWorkInFlight } from "./profile_queue.ts";
import { hasRunningTurn } from "./turns.ts";

/** The reads of {@link workspaceBusyReasons}. Tests replace each one. */
export type BusyGateOpts = {
    readonly hasRunningTurn: (analysisId: string) => boolean;
    readonly profileWorkInFlight: (analysisId: string) => boolean;
    /** The data profile ledger row, or `null` when the analysis has no profile. The error channel means the ledger is unreadable. */
    readonly profileStatus: (pool: Pool, analysisId: string) => ResultAsync<DataProfileStatus | null, unknown>;
    /** The runs and the data profiles of the analysis with a live durable workflow. The error channel means the ledger is unreadable. */
    readonly liveDurableWork: (pool: Pool, analysisId: string) => ResultAsync<LiveDurableWork, unknown>;
};

/** The production {@link BusyGateOpts}. */
export const DEFAULT_BUSY_GATE_OPTS: BusyGateOpts = {
    hasRunningTurn,
    profileWorkInFlight,
    profileStatus: loadDataProfileStatus,
    liveDurableWork: countLiveDurableWork,
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
 * An active run ledger row blocks only while a LIVE workflow stands behind it ({@link countLiveDurableWork}).
 * An unreadable ledger or status table reads as busy, because the gate must refuse rather than guess. With no
 * runtime, no workflow of this process can hold the folder.
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

    const live = await opts.liveDurableWork(runtime.pool, analysisId);
    if (live.isErr()) return [...reasons, "run_state_unreadable"];
    return live.value.runs > 0 ? [...reasons, "run"] : reasons;
}
