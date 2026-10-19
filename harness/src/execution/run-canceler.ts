/**
 * RunCanceler — the encapsulated external-cancel path for an `executeAnalysis` run.
 *
 * A cancelled DBOS workflow can never start another step, so the body's own
 * terminal block (`collectAndComplete`) can be unreachable once the cancel lands
 * and nothing converges: the run row stays `running` (blocking same-plan relaunch
 * through `queryActiveRun`'s active-status dedup) and pending step rows never
 * sweep. A step that started before the cancel still runs to its end, and its
 * run status write is conditional on a `running` row. This module is the
 * host-side counterpart: cancel the engine's parent + children, then converge
 * the ledgers the workflow would have.
 *
 * The writer that wins the conditional terminal write of the run row owns the
 * run end: the run emit, the charge close, and the mandate revoke. This module
 * does those acts only when its write changed the row. A refused write means
 * the body won the row and owns them; a failed write leaves the row `running`,
 * so a second cancel converges the run. The step rows settle on every path.
 *
 * The engine capability stays internal — the production default is the
 * purger's `DBOSClient`-backed child-cascading cancel, which needs no launched
 * engine (see `dbos-workflow-purger.ts` for why the static `DBOS` facade is
 * the wrong tool here). `cancelWorkflows` is an optional test seam over it.
 *
 * No stream writes: `DBOS.writeStream` writes only from inside the workflow
 * that owns the stream, so the run-event reader (`run-event-stream.ts`)
 * synthesizes the terminal part from the run row.
 */

import type { Pool } from "pg";

import type { AgentSession } from "../auth/types.js";
import type { RunCharge } from "../billing/run-charge.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { deliverNotice } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { elapsedSinceIso, recordRunCompleted, recordStepCompleted } from "../lib/metrics.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { ProvenanceSeam, RunProvenanceEvent } from "../provenance/seam.js";
import { markRunCanceledIfActive, queryRun } from "../state/runs.js";
import type { RunStatus, StepExecutionRow } from "../state/schema.js";
import { cancelRunningStepExecutions, queryStepsByRun, sweepPendingStepExecutions } from "../state/step-executions.js";
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
    /** What actually converged. `charge` and `mandate` are vacuously true when
     * there is nothing for this cancel to converge — a refused terminal write
     * (the body owns them) and, for `mandate`, a row with no persisted jti — so
     * hosts alert on any false flag. */
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
    /** Receives the end of a run that this canceler cancels. An absent binding, or a binding with no run emit, emits nothing. */
    readonly provenance?: ProvenanceSeam;
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

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "partial", "failed", "canceled", "suspended_insufficient_funds"]);

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

    /** Steps whose child started (a persisted child workflow id) and has not written its terminal row. */
    const incompleteSteps = async (runId: string): Promise<StepExecutionRow[]> =>
        unwrapOrThrow(await queryStepsByRun(pool, runId)).filter((step) => step.childWorkflowId !== null && step.completedAt === null);
    const childIds = (steps: readonly StepExecutionRow[]): string[] => steps.flatMap((step) => (step.childWorkflowId !== null ? [step.childWorkflowId] : []));

    const emitRunEvent = deps.provenance?.emitRunEvent;
    const emitGuarded = (event: RunProvenanceEvent, session: AgentSession): void => {
        if (emitRunEvent === undefined) return;
        try {
            emitRunEvent(event, session);
        } catch (err) {
            logger.error("the run emit of the provenance binding threw", { runId: event.runId, event: event.type, ...logger.errorFields(err) });
        }
    };

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
            const knownChildren = childIds(await incompleteSteps(runId));
            await cancelWorkflows([workflowId, ...knownChildren]);
            // The steps the cancel cut: read after the cancel landed, so a child that
            // wrote its terminal row in the meantime is not among them.
            let cutSteps: StepExecutionRow[] | undefined;
            try {
                cutSteps = await incompleteSteps(runId);
                const late = childIds(cutSteps).filter((id) => !knownChildren.includes(id));
                if (late.length > 0) await cancelWorkflows(late);
            } catch (err) {
                logger.error("late-child cancel sweep failed", { runId, ...logger.errorFields(err) });
            }

            // Convergence — each phase isolated so one failure skips nothing after it.
            // The terminal write has three outcomes: changed (this cancel won the row),
            // refused (the body won it), failed (the row is unchanged).
            let writeOutcome: "changed" | "refused" | "failed" = "failed";
            try {
                writeOutcome = unwrapOrThrow(await markRunCanceledIfActive(pool, runId, EXTERNAL_CANCEL_REASON)) ? "changed" : "refused";
            } catch (err) {
                logger.error("markRunCanceledIfActive failed", { runId, ...logger.errorFields(err) });
            }
            const transitioned = writeOutcome === "changed";
            // A terminal step of the workflow that started before the cancel can still
            // write, but its write is conditional on a `running` row too. The first
            // write wins, and the run-end acts ride behind the write that won: a
            // refused write means the run settled on its own and its own terminal step
            // does them. A cut child never reached its terminal row, so its step
            // records here too.
            if (transitioned) {
                recordRunCompleted({ workflow: "analysis", status: "canceled", durationMs: elapsedSinceIso(row.startedAt) });
                for (const step of cutSteps ?? []) recordStepCompleted({ agentId: step.agentId, status: "canceled" });

                // The end of the run rides the same condition. One wall-clock read stamps every event:
                // the canceler is not a workflow, so no replay fires these emits again.
                const atMs = Date.now();
                for (const step of cutSteps ?? []) {
                    const durationMs = elapsedSinceIso(step.startedAt, atMs);
                    emitGuarded(
                        {
                            type: "step_completed",
                            analysisId: row.analysisId,
                            runId,
                            stepId: step.stepId,
                            status: "canceled",
                            ...(durationMs !== undefined ? { durationMs } : {}),
                            atMs,
                        },
                        session,
                    );
                }
                emitGuarded(
                    {
                        type: "run_completed",
                        analysisId: row.analysisId,
                        runId,
                        status: "canceled",
                        atMs,
                        durationMs: Math.max(0, atMs - Date.parse(row.startedAt)),
                    },
                    session,
                );
            }

            let pendingSwept = false;
            try {
                unwrapOrThrow(await sweepPendingStepExecutions(pool, runId));
                pendingSwept = true;
            } catch (err) {
                logger.error("pending-step sweep failed", { runId, ...logger.errorFields(err) });
            }
            let runningSettled = false;
            try {
                unwrapOrThrow(await cancelRunningStepExecutions(pool, runId, EXTERNAL_CANCEL_REASON));
                runningSettled = true;
            } catch (err) {
                logger.error("running-step settle failed", { runId, ...logger.errorFields(err) });
            }
            const steps = pendingSwept && runningSettled;

            // Only the writer that won the row closes the charge and revokes. A refused
            // write left both to the body; a failed write left the row `running`, so a
            // second cancel converges the run. The flags of a refused write are true
            // because there is nothing for this cancel to converge.
            let charge = writeOutcome === "refused";
            let mandate = writeOutcome === "refused" || (writeOutcome === "failed" && row.mandateJti === null);
            if (transitioned) {
                charge = await deliverNotice(
                    logger.with({ runId }),
                    "RunCharge.close",
                    runCharge.close({ analysisId: row.analysisId, runId, outcome: { kind: "canceled" }, session }),
                );

                mandate =
                    row.mandateJti === null ||
                    (await deliverNotice(
                        logger.with({ runId, jti: row.mandateJti }),
                        "RunAuthorizer.revokeByJti",
                        runAuthorizer.revokeByJti({ jti: row.mandateJti, auth: session.auth }, EXTERNAL_CANCEL_REASON),
                    ));
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
