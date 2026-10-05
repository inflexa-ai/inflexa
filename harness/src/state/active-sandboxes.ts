/**
 * Active-sandbox registry (CONTEXT.md) — the projection over
 * `cortex_step_executions` rows with a non-null `sandbox_ref` and a running
 * status. Owns the `sandbox_ref` column: written by
 * `sandbox/create-sandbox.ts` on mint, cleared on teardown, reconciled by
 * `sandbox/reaper.ts` after it deletes a machine.
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import type { PersistedSandboxRef } from "./schema.js";

/**
 * Record the live sandbox handle on a step row. Called inside the
 * `createSandbox` DBOS step after the backend has confirmed the sandbox
 * is up.
 */
export function setSandboxRef(pool: Querier, runId: string, stepId: string, sandboxRef: PersistedSandboxRef): ResultAsync<void, DbError> {
    return tryMutation("activeSandboxes.setSandboxRef", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET sandbox_ref = $1::jsonb
          WHERE run_id = $2 AND step_id = $3`,
            values: [JSON.stringify(sandboxRef), runId, stepId],
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
          SET sandbox_ref = NULL
          WHERE run_id = $1 AND step_id = $2`,
            values: [runId, stepId],
        });
    });
}

/**
 * Reconcile a step row after the reaper deletes its sandbox machine (ADR
 * 0016). Always clears `sandbox_ref` (drops the row from the
 * active-sandbox registry); a row still stuck at
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
              status = CASE WHEN status = 'running' THEN $2 ELSE status END,
              completed_at = CASE WHEN status = 'running' THEN $3 ELSE completed_at END
          WHERE sandbox_ref->>'sandboxId' = $1`,
            values: [sandboxId, terminalStatus, completedAt],
        });
        return (result.rowCount ?? 0) > 0;
    });
}
