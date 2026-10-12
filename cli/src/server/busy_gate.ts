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
 * What the busy rule knows about one analysis:
 *
 * - `turn`: a chat turn of the analysis runs.
 * - `profileDrive`: the profile queue holds a drive of the analysis. The ledger row is then not read, and `profile` is ignored.
 * - `profile`: the ledger row is `running` or not (`idle`). `unreadable` is a failed read, and `unknown` is no read, because there is no runtime.
 * - `liveRuns`: the count of the runs with a live durable workflow, `unreadable` for a failed read, and `unknown` for no read.
 */
export type BusyFacts = {
    readonly turn: boolean;
    readonly profileDrive: boolean;
    readonly profile: "running" | "idle" | "unreadable" | "unknown";
    readonly liveRuns: number | "unreadable" | "unknown";
};

/**
 * The one rule of the busy reasons, for the gate and for the list. An unreadable state reads as busy, because
 * the gate must refuse rather than guess, and an unknown state adds nothing. The order is `chat_turn`,
 * `data_profile`, `profile_state_unreadable`, and then `run` or `run_state_unreadable`. A profile drive holds
 * `data_profile` by itself, thus the ledger row is not read for it.
 */
export function busyReasonsOf(facts: BusyFacts): BusyReason[] {
    const reasons: BusyReason[] = [];
    if (facts.turn) reasons.push("chat_turn");
    if (facts.profileDrive) reasons.push("data_profile");
    else if (facts.profile === "unreadable") reasons.push("profile_state_unreadable");
    else if (facts.profile === "running") reasons.push("data_profile");
    if (facts.liveRuns === "unreadable") reasons.push("run_state_unreadable");
    else if (facts.liveRuns !== "unknown" && facts.liveRuns > 0) reasons.push("run");
    return reasons;
}

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
    const turn = opts.hasRunningTurn(analysisId);
    const profileDrive = opts.profileWorkInFlight(analysisId);
    if (runtime === null) return busyReasonsOf({ turn, profileDrive, profile: "unknown", liveRuns: "unknown" });

    let profile: BusyFacts["profile"] = "unknown";
    if (!profileDrive) {
        const status = await opts.profileStatus(runtime.pool, analysisId);
        profile = status.isErr() ? "unreadable" : status.value?.status === "running" ? "running" : "idle";
    }
    const live = await opts.liveDurableWork(runtime.pool, analysisId);
    return busyReasonsOf({ turn, profileDrive, profile, liveRuns: live.isErr() ? "unreadable" : live.value.runs });
}
