/**
 * The terminal sequence every durable run shares.
 *
 * A run's finalisation is not a list of independent cleanups — it is an ordering,
 * and each constraint in it exists because breaking it produced a bug:
 *
 *  1. **A checkpointed clock read, then the caller's terminal provenance, BEFORE
 *     the status write.** A host watching the run polls `cortex_runs.status` and
 *     may shut down the instant it leaves `running` (the CLI flushes provenance
 *     and exits). Emitting after the status write races that shutdown and can
 *     drop the run's terminal record entirely; emitting first makes the record
 *     dirty before the row can be observed terminal. The clock is `DBOS.now()`,
 *     so a recovery replay re-emits the identical timestamp and the host's
 *     ledger merges rather than conflicts.
 *  2. **The status write, then any caller ledger note.** A reader that sees a
 *     terminal status then also sees whatever the run recorded about how it got
 *     there.
 *  3. **The pending-row sweep, or the budget suspend — never both.** They are
 *     exact complements of one condition, and that condition is the BRANCH the
 *     caller took, never the status it wrote: the resumable 402 pause also
 *     writes `"canceled"`, yet its `pending` rows must survive for the resumed
 *     workflow to execute. Hence one `pausedByBudget` flag rather than a status
 *     comparison.
 *  4. **Charge close, then authorization revoke.**
 *  5. **Exactly one terminal stream part, last.**
 *
 * Every side effect is its own named `DBOS.runStep` and every failure is logged
 * without rolling back the ones that already succeeded: a run that finished must
 * not be undone by a failed bookkeeping note. Step names are fixed here so a
 * workflow recovered across this refactor replays into the same cache slots.
 *
 * What stays with the caller: deriving the terminal status, building the
 * terminal part (which may need its own durable steps), and its own provenance
 * payload. This module owns the order, not the meaning.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

import type { RunSession } from "../../auth/types.js";
import type { RunCharge } from "../../billing/run-charge.js";
import type { RunAuthorization, RunAuthorizer } from "../../execution/run-authorizer.js";
import type { Logger } from "../../lib/logger.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { suspendAnalysis, sweepPendingStepExecutions, updateRunStatus } from "../../state/index.js";

/** The terminal statuses a run body can derive. `"running"` is not terminal and cannot be finalised. */
export type TerminalRunStatus = "completed" | "partial" | "failed" | "canceled";

export interface FinaliseRunArgs {
    /** The caller's already-scoped logger, so a finalisation failure names the workflow that hit it. */
    readonly logger: Logger;
    readonly pool: Pool;
    readonly runCharge: RunCharge;
    readonly runAuthorizer: RunAuthorizer;
    readonly runId: string;
    readonly analysisId: string;
    /** Derived by the caller — this module never infers a status from step state. */
    readonly status: TerminalRunStatus;
    readonly failureReason: string | null;
    /**
     * True only on the resumable budget-pause branch, and selected structurally
     * by the caller taking that branch. Suppresses the sweep and suspends the
     * analysis instead. MUST NOT be derived from `status`, which reads
     * `"canceled"` on both the pause and a real cancel.
     */
    readonly pausedByBudget: boolean;
    readonly session: RunSession;
    readonly authorization: RunAuthorization;
    /**
     * Called with the checkpointed terminal clock read, before the status write,
     * so the caller can emit its own terminal provenance with a replay-stable
     * timestamp. The caller owns the payload and its own error guard.
     */
    readonly onTerminalClock?: (terminalAtMs: number) => void;
    /** A ledger note that must land immediately after the status write. Log-don't-roll-back applies. */
    readonly afterStatusWrite?: () => Promise<void>;
    /** Built once, emitted once, last. May run its own durable steps to compose the payload. */
    readonly buildTerminalPart: () => Promise<unknown>;
}

/** `RunCharge.close` reason for a terminal status. A budget pause is a pause, not an error. */
function chargeReasonFor(status: TerminalRunStatus, pausedByBudget: boolean): "ok" | "error" | "canceled" | "budget_exceeded" {
    if (status === "completed" || status === "partial") return "ok";
    if (status === "failed") return "error";
    return pausedByBudget ? "budget_exceeded" : "canceled";
}

/** Revoke reason for a terminal status, in the same four-way split. */
function revokeReasonFor(status: TerminalRunStatus, pausedByBudget: boolean): string {
    if (status === "completed" || status === "partial") return "workflow-completed";
    if (status === "failed") return "workflow-failed";
    return pausedByBudget ? "workflow-suspended" : "workflow-canceled";
}

/**
 * Run the shared terminal sequence. Returns once the single terminal stream part
 * has been written; the caller assembles its own workflow result.
 */
export async function finaliseRun(args: FinaliseRunArgs): Promise<void> {
    const { logger, pool, runId, analysisId, status, failureReason, pausedByBudget } = args;

    // (1) Checkpointed clock read + the caller's terminal provenance, both before
    //     the status write. Deliberately NOT step-wrapped: a recovery replay must
    //     re-fire the observation, and `DBOS.now()` keeps it replay-stable.
    const terminalAtMs = await DBOS.now();
    args.onTerminalClock?.(terminalAtMs);

    // (2) The status write.
    try {
        await DBOS.runStep(
            async () => {
                unwrapOrThrow(
                    await updateRunStatus(pool, runId, status, failureReason ?? (status === "canceled" && !pausedByBudget ? "external_cancel" : null)),
                );
            },
            { name: "persist-final-status" },
        );
    } catch (err) {
        logger.error("persist-final-status failed", { status, ...logger.errorFields(err) });
    }

    // (2b) The caller's ledger note, after the status write so a reader seeing a
    //      terminal status also sees it.
    if (args.afterStatusWrite) {
        await args.afterStatusWrite();
    }

    // (3) Sweep never-started rows, or suspend for a resumable pause — complements
    //     of the branch the caller took, never of the status it wrote.
    if (!pausedByBudget) {
        try {
            await DBOS.runStep(
                async () => {
                    unwrapOrThrow(await sweepPendingStepExecutions(pool, runId));
                },
                { name: "sweep-pending-steps" },
            );
        } catch (err) {
            logger.error("sweep-pending-steps failed", logger.errorFields(err));
        }
    } else {
        try {
            await DBOS.runStep(
                async () => {
                    unwrapOrThrow(await suspendAnalysis(pool, analysisId));
                },
                { name: "suspend-analysis" },
            );
        } catch (err) {
            logger.error("suspend-analysis failed", logger.errorFields(err));
        }
    }

    // (4) Charge close, then authorization revoke.
    const chargeReason = chargeReasonFor(status, pausedByBudget);
    try {
        await DBOS.runStep(() => args.runCharge.close({ analysisId, runId, reason: chargeReason, session: args.session }), { name: "close-running-charge" });
    } catch (err) {
        logger.error("closeRunningCharge failed", { chargeReason, ...logger.errorFields(err) });
    }

    const revokeReason = revokeReasonFor(status, pausedByBudget);
    try {
        await DBOS.runStep(() => args.runAuthorizer.revoke(args.authorization, revokeReason), { name: "revoke-run-auth" });
    } catch (err) {
        logger.error("revokeRunAuthorization failed", { revokeReason, ...logger.errorFields(err) });
    }

    // (5) Exactly one terminal part on the run-event stream.
    await DBOS.writeStream("events", await args.buildTerminalPart());
}
