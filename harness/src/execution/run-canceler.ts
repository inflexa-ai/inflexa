/**
 * RunCanceler — the encapsulated external-cancel path for an `executeAnalysis` run.
 *
 * A cancelled DBOS workflow can never execute another step, so the body's own
 * terminal block (`collectAndComplete`) is unreachable on external cancel and
 * nothing converges: the run row stays `running` (blocking same-plan relaunch
 * through `queryActiveRun`'s active-status dedup), pending step rows never
 * sweep, the running charge never closes, and the run mandate is never
 * revoked. This module is the host-side counterpart: cancel the engine's
 * parent + children, then converge each ledger the workflow would have.
 *
 * The engine capability stays internal — the production default is the
 * purger's `DBOSClient`-backed child-cascading cancel, which needs no launched
 * engine (see `dbos-workflow-purger.ts` for why the static `DBOS` facade is
 * the wrong tool here). `cancelWorkflows` is an optional test seam over it.
 *
 * No stream writes: `DBOS.writeStream` is body-only, so hosts synthesize the
 * terminal frame read-side.
 */

import type { Pool } from "pg";

import type { AgentSession } from "../auth/types.js";
import type { RunCharge } from "../billing/run-charge.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { markRunCanceledIfActive, queryRun } from "../state/runs.js";
import type { RunStatus } from "../state/schema.js";
import { queryStepsByRun, sweepPendingStepExecutions } from "../state/step-executions.js";
import { createDbosWorkflowPurger } from "./dbos-workflow-purger.js";
import type { RunAuthorizer } from "./run-authorizer.js";

/** The reason stamped on the run row and the revoke — the same literal
 * `collectAndComplete` records for a cancel it observes from inside. */
const EXTERNAL_CANCEL_REASON = "external_cancel";

export class UnknownRunError extends Error {
    constructor(readonly runId: string) {
        super(`no run exists for id ${runId}`);
        this.name = "UnknownRunError";
    }
}

export interface CancelRunResult {
    readonly runId: string;
    /** The DBOS parent workflow id — equal to `runId` by the launch contract
     * (`execute_analysis` launches with `workflowId: runId`). */
    readonly workflowId: string;
    readonly outcome: "canceled" | "already_terminal";
    /**
     * The run row's status after the cancel. `canceled` when this cancel won
     * the row; the run's own terminal status when it completed concurrently
     * (the conditional write refuses to clobber it).
     */
    readonly finalStatus: RunStatus;
    /** What actually converged. `mandate` is vacuously true for a row with no
     * persisted jti — nothing to revoke, so hosts alert on any false flag. */
    readonly converged: {
        readonly steps: boolean;
        readonly charge: boolean;
        readonly mandate: boolean;
    };
}

export interface RunCancelerDeps {
    readonly pool: Pool;
    readonly runCharge: RunCharge;
    readonly runAuthorizer: RunAuthorizer;
    readonly logger?: Logger;
    /** Test seam over the engine cancel. Production default: the workflow
     * purger's `DBOSClient`-backed cancel, child-cascading and launch-free. */
    readonly cancelWorkflows?: (workflowIds: readonly string[]) => Promise<void>;
}

export interface RunCanceler {
    /**
     * Cancel the run's workflows and converge its ledgers. Rejects when the
     * engine cancel itself fails (retry-safe: nothing converged) or the run is
     * unknown; convergence-phase failures resolve with their flag false.
     */
    cancel(runId: string, session: AgentSession): Promise<CancelRunResult>;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "partial", "failed", "canceled"]);

export function createRunCanceler(deps: RunCancelerDeps): RunCanceler {
    const { pool, runCharge, runAuthorizer } = deps;
    const logger = (deps.logger ?? createNoopLogger()).named("run-canceler");

    // Lazy so a canceler built for a host that never cancels constructs no client;
    // one purger per factory (its client registers pool handlers — see its comment).
    let engineCancel = deps.cancelWorkflows;
    const cancelWorkflows = async (workflowIds: readonly string[]): Promise<void> => {
        engineCancel ??= (() => {
            const purger = createDbosWorkflowPurger({ pool, logger });
            return async (ids: readonly string[]): Promise<void> => {
                unwrapOrThrow(await purger.cancel([...ids]));
            };
        })();
        await engineCancel(workflowIds);
    };

    /** Persisted child workflow ids of steps not yet completed. */
    const incompleteChildIds = async (runId: string): Promise<string[]> =>
        unwrapOrThrow(await queryStepsByRun(pool, runId)).flatMap((step) =>
            step.childWorkflowId !== null && step.completedAt === null ? [step.childWorkflowId] : [],
        );

    return {
        async cancel(runId, session) {
            const row = unwrapOrThrow(await queryRun(pool, runId));
            if (row === null) throw new UnknownRunError(runId);
            const workflowId = runId;

            if (TERMINAL.has(row.status)) {
                return {
                    runId,
                    workflowId,
                    outcome: "already_terminal",
                    finalStatus: row.status,
                    converged: { steps: false, charge: false, mandate: false },
                };
            }

            // The child-cascading cancel walks the engine's own parent ledger, which
            // has a row the moment a child starts — that covers a child whose
            // mark-running step has not yet committed its child_workflow_id. The
            // persisted ids and the post-cancel re-query are belt-and-braces over
            // both ledgers' lag.
            const knownChildren = await incompleteChildIds(runId);
            await cancelWorkflows([workflowId, ...knownChildren]);
            try {
                const late = (await incompleteChildIds(runId)).filter((id) => !knownChildren.includes(id));
                if (late.length > 0) await cancelWorkflows(late);
            } catch (err) {
                logger.error("late-child cancel sweep failed", { runId, ...logger.errorFields(err) });
            }

            // Convergence — each phase isolated so one failure skips nothing after it.
            let transitioned = false;
            try {
                transitioned = unwrapOrThrow(await markRunCanceledIfActive(pool, runId, EXTERNAL_CANCEL_REASON));
            } catch (err) {
                logger.error("markRunCanceledIfActive failed", { runId, ...logger.errorFields(err) });
            }

            let steps = false;
            try {
                unwrapOrThrow(await sweepPendingStepExecutions(pool, runId));
                steps = true;
            } catch (err) {
                logger.error("pending-step sweep failed", { runId, ...logger.errorFields(err) });
            }

            // Best-effort: the billing authority self-heals (defensive open + stale
            // reaper), so a failed close loses attribution only.
            let charge = false;
            try {
                await runCharge.close({ analysisId: row.analysisId, runId, reason: "canceled", session });
                charge = true;
            } catch (err) {
                logger.error("running-charge close failed", { runId, ...logger.errorFields(err) });
            }

            let mandate = row.mandateJti === null;
            if (row.mandateJti !== null) {
                try {
                    await runAuthorizer.revokeByJti({ jti: row.mandateJti, auth: session.auth }, EXTERNAL_CANCEL_REASON);
                    mandate = true;
                } catch (err) {
                    logger.error("mandate revoke failed", { runId, jti: row.mandateJti, ...logger.errorFields(err) });
                }
            }

            // No transition means the run reached a terminal state on its own (or the
            // write failed) — report the row as it stands rather than claiming `canceled`.
            let finalStatus: RunStatus = "canceled";
            if (!transitioned) {
                const reread = unwrapOrThrow(await queryRun(pool, runId));
                finalStatus = reread?.status ?? "canceled";
            }

            return { runId, workflowId, outcome: "canceled", finalStatus, converged: { steps, charge, mandate } };
        },
    };
}
