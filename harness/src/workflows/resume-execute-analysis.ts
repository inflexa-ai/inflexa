/**
 * Resume helper for the `executeAnalysis` parent workflow.
 *
 * The actual resume *entry-point* (the HTTP route, the operator CLI hook,
 * the analytics-tier replay) is not built yet — no caller in this repo, and
 * this module is not on the public barrel, so the 402-pause resume path is
 * currently unreachable. This module owns the **internal contract** every
 * future resume call site MUST satisfy so the parent body re-opens the running
 * charge correctly after a 402 pause.
 *
 * Contract:
 *
 *   1. Call `prepareExecuteAnalysisResume(pool, parentWorkflowId)` BEFORE
 *      `DBOS.resumeWorkflow(parentWorkflowId)`.
 *   2. The helper finds the cortex_runs row by `workflow_id`, atomically
 *      bumps `attempt_count`, and returns the new attempt + the runId.
 *      Children that are still CANCELLED need an explicit
 *      `DBOS.resumeWorkflow(childWorkflowId)` from the caller; completed
 *      children's `getResult` returns from the DBOS cache.
 *   3. On resume the parent body reads the bumped attempt_count and uses
 *      it in `open-running-charge:${attempt}` / `close-running-charge:${attempt}`
 *      / `revoke-run-auth:${attempt}` so each step name has never been
 *      cached. A fresh managed-root charge is opened to replace the one that
 *      closed with `budget_exceeded` on the pause.
 *   4. The same attempt is passed through to children via
 *      `SandboxStepInput.attempt`, where it drives
 *      `attemptStepNameFormatter` and so the resumed LLM calls miss the
 *      prior cached 402 and fire fresh (NOTES #3).
 *   5. The workflow id and run id MUST NOT change across resume:
 *      `cortex_runs.workflow_id` is rewritten by nothing in this code
 *      path. The whole point of the bumped attempt counter is that the
 *      same workflow id can survive multiple resumes without cache
 *      collisions.
 *
 * Failure modes:
 *
 *   - The row does not exist → `MissingRunError`. Caller MUST surface a 404
 *     to the originating operator; do NOT call `DBOS.resumeWorkflow` on a
 *     missing run.
 *   - The row's status is terminal (`completed`/`partial`/`failed`/`canceled`
 *     without `suspended_insufficient_funds` on the analysis): the helper
 *     still bumps the counter so a defensive retry is harmless, but the
 *     caller SHOULD skip the resume — the workflow already ran to
 *     completion. The future resume entry point owns this guard.
 */

import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { bumpRunAttemptCount, queryRun } from "../state/index.js";
import type { CortexRunRow } from "../state/schema.js";

export class MissingRunError extends Error {
    constructor(readonly workflowId: string) {
        super(`No cortex_runs row found for run_id=${workflowId}`);
        this.name = "MissingRunError";
    }
}

export interface PrepareResumeResult {
    readonly runId: string;
    readonly workflowId: string;
    readonly attempt: number;
    readonly previousStatus: CortexRunRow["status"];
}

/**
 * Bump the parent-workflow resume attempt counter and return the new
 * value. The caller invokes `DBOS.resumeWorkflow(workflowId)` immediately
 * after; the resumed parent body reads the bumped counter and re-opens
 * the running charge with a step name that has never been cached.
 *
 * `workflowId` and `runId` are the same bare UUID — `cortex_runs.run_id`
 * IS the DBOS workflowID.
 *
 * Idempotency: each call bumps once. A double-call before
 * `DBOS.resumeWorkflow` is harmless — both step names are misses and the
 * close on the just-opened charge will still cleanly land.
 */
export async function prepareExecuteAnalysisResume(pool: Pool, workflowId: string): Promise<PrepareResumeResult> {
    const row = unwrapOrThrow(await queryRun(pool, workflowId));
    if (!row) {
        throw new MissingRunError(workflowId);
    }
    const attempt = unwrapOrThrow(await bumpRunAttemptCount(pool, row.runId));
    return {
        runId: row.runId,
        workflowId,
        attempt,
        previousStatus: row.status,
    };
}
