/**
 * Active-sandbox registry (CONTEXT.md) — the projection over
 * `cortex_step_executions` rows with a non-null `sandbox_ref` and a running
 * status. Owns the `sandbox_ref` + `exec_id` columns: written by
 * `sandbox/create-sandbox.ts` on mint, cleared on teardown, enumerated by
 * `sandbox/watchdog.ts` for liveness sweeps.
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import type { PersistedSandboxRef } from "./schema.js";

/**
 * Record the live sandbox handle on a step row. Called inside the
 * `createSandbox` DBOS step after the backend has confirmed the sandbox
 * is up. The `callbackSecret` is deliberately not part of the persisted
 * shape (see the harness-sandbox-exec spec) — it lives only in the cached step output.
 */
export function setSandboxRef(
    pool: Querier,
    runId: string,
    stepId: string,
    sandboxRef: PersistedSandboxRef,
    execId: string | null,
): ResultAsync<void, DbError> {
    return tryMutation("activeSandboxes.setSandboxRef", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET sandbox_ref = $1::jsonb, exec_id = $2
          WHERE run_id = $3 AND step_id = $4`,
            values: [JSON.stringify(sandboxRef), execId, runId, stepId],
        });
    });
}

/**
 * Tag the active-sandbox row with the exec currently in flight. Called from
 * `run-exec.ts` right before `awaitExec` so the liveness watchdog can target
 * the hung exec when the sandbox dies mid-command. Targets the same
 * `(run_id, step_id)` row `setSandboxRef` writes and `queryActiveSandboxes`
 * enumerates. Overwritten by the next exec; cleared on teardown.
 */
export function setActiveExecId(pool: Querier, runId: string, stepId: string, execId: string): ResultAsync<void, DbError> {
    return tryMutation("activeSandboxes.setActiveExecId", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET exec_id = $1
          WHERE run_id = $2 AND step_id = $3`,
            values: [execId, runId, stepId],
        });
    });
}

/**
 * Clear the sandbox handle. Called inside the `teardown` DBOS step. Safe
 * to call when no sandbox was ever recorded — the UPDATE simply targets
 * zero rows.
 */
export function clearSandboxRef(pool: Querier, runId: string, stepId: string): ResultAsync<void, DbError> {
    return tryMutation("activeSandboxes.clearSandboxRef", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET sandbox_ref = NULL, exec_id = NULL
          WHERE run_id = $1 AND step_id = $2`,
            values: [runId, stepId],
        });
    });
}

/**
 * Enumerate the active-sandbox registry — every running step with a live
 * sandbox attached. The liveness watchdog consumes this, shards the
 * result, and fans out per-shard check workflows.
 *
 * Returns the raw row tuple (no Zod parse) so the watchdog can shard
 * without paying for parse work it doesn't need.
 */
export interface ActiveSandboxRow {
    runId: string;
    stepId: string;
    analysisId: string;
    sandboxRef: PersistedSandboxRef;
    execId: string | null;
}

/**
 * Reconcile a step row after the reaper deletes its sandbox machine (ADR
 * 0016). Always clears `sandbox_ref`/`exec_id` (drops the row from the
 * active-sandbox registry, ending the watchdog churn); a row still stuck at
 * `status='running'` — a cancellation that never ran its `mark-*` step — is
 * also flipped to the owning workflow's terminal status so a terminal workflow
 * never leaves a perpetually-"running" step behind. Returns true if a row
 * matched. Safe when no row exists (Class A pure orphan): matches zero rows.
 */
export function reconcileReapedSandbox(pool: Querier, sandboxId: string, terminalStatus: "canceled" | "failed" | "completed"): ResultAsync<boolean, DbError> {
    // `completed_at` is a TEXT column holding ISO-8601 strings (see
    // `step-executions.ts`), so bind one — `now()` is `timestamptz` and the CASE
    // cannot unify a timestamptz branch with the text column ("CASE types text
    // and timestamp with time zone cannot be matched"), which aborted every sweep.
    const completedAt = new Date().toISOString();
    return tryMutation("activeSandboxes.reconcileReapedSandbox", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_step_executions
          SET sandbox_ref = NULL,
              exec_id = NULL,
              status = CASE WHEN status = 'running' THEN $2 ELSE status END,
              completed_at = CASE WHEN status = 'running' THEN $3 ELSE completed_at END
          WHERE sandbox_ref->>'sandboxId' = $1`,
            values: [sandboxId, terminalStatus, completedAt],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function queryActiveSandboxes(pool: Querier): ResultAsync<ActiveSandboxRow[], DbError> {
    return tryQuery("activeSandboxes.queryActiveSandboxes", async () => {
        const result = await pool.query<{
            run_id: string;
            step_id: string;
            analysis_id: string;
            sandbox_ref: PersistedSandboxRef;
            exec_id: string | null;
        }>({
            text: `SELECT run_id, step_id, analysis_id, sandbox_ref, exec_id
          FROM cortex_step_executions
          WHERE status = 'running' AND sandbox_ref IS NOT NULL`,
        });
        return result.rows.map((r) => ({
            runId: r.run_id,
            stepId: r.step_id,
            analysisId: r.analysis_id,
            sandboxRef: r.sandbox_ref,
            execId: r.exec_id ?? null,
        }));
    });
}
