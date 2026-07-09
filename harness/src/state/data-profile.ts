/**
 * Data-profile status operations — the `data_profile_*` columns on
 * `cortex_analysis_state`. Tracks the lifecycle of the per-analysis data
 * profiling pass (pending → running → completed | failed).
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

export interface DataProfileStatus {
    status: "pending" | "running" | "completed" | "failed";
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    result: {
        summary: string;
        files: Array<{ path: string; description: string }>;
        inputFileIds: string[];
        profiledAt: string;
    } | null;
    seedInputFileIds: string[] | null;
}

/**
 * Try to claim a startable row into `running`. Startable means `'pending'`
 * (seeded, not yet run) or NULL (no profile: never profiled, or cleared by
 * `clearDataProfile`). `ok(true)` when this call won the CAS, `ok(false)` when
 * it lost (already claimed) — losing the race is NOT an error, it stays in the
 * ok channel.
 *
 * NULL must be claimable here or a cleared analysis whose inputs return can
 * never be profiled again: the seed upsert's ON CONFLICT deliberately never
 * rewrites profile status, so the row stays NULL — and NULL matches neither
 * the rerun (`completed`) nor retry (`failed`) claims.
 */
export function tryStartDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryStartDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1
            WHERE analysis_id = $2 AND (data_profile_status = 'pending' OR data_profile_status IS NULL)`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function tryRetryDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryRetryDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_error = NULL, data_profile_completed_at = NULL
            WHERE analysis_id = $2 AND data_profile_status = 'failed'`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function tryRerunDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryRerunDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1,
                data_profile_error = NULL, data_profile_completed_at = NULL
            WHERE analysis_id = $2 AND data_profile_status = 'completed'`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function completeDataProfile(
    pool: Querier,
    analysisId: string,
    result?: {
        summary: string;
        files: Array<{ path: string; description: string }>;
        inputFileIds: string[];
        profiledAt: string;
    },
): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.completeDataProfile", async () => {
        await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'completed', data_profile_completed_at = $1,
                data_profile_result = $2::jsonb
            WHERE analysis_id = $3`,
            values: [now, result ? JSON.stringify(result) : null, analysisId],
        });
    });
}

export function failDataProfile(pool: Querier, analysisId: string, error: string): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.failDataProfile", async () => {
        await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'failed', data_profile_error = $1,
                data_profile_completed_at = $2
            WHERE analysis_id = $3`,
            values: [error, now, analysisId],
        });
    });
}

export function expireStaleDataProfile(pool: Querier, analysisId: string, timeoutMs: number): ResultAsync<boolean, DbError> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
    return tryMutation("dataProfile.expireStaleDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'failed',
                data_profile_error = 'Data profiling timed out',
                data_profile_completed_at = $1
            WHERE analysis_id = $2 AND data_profile_status = 'running'
              AND data_profile_started_at < $3`,
            values: [now.toISOString(), analysisId, cutoff],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Reset a ledger row wedged at `running` with no workflow behind it back to
 * `failed`, so the normal retry path can re-profile it.
 *
 * A start that rejects after the CAS already flipped the row to `running`
 * compensates itself (`triggerDataProfile`/`runDataProfile` fail the ledger in
 * their catch). This covers the residual case that compensation cannot: a host
 * that dies in the window between the CAS and the `DBOS.startWorkflow` insert
 * leaves a `running` row with no workflow for recovery to resume — nothing
 * would ever move it off `running`, and every later trigger reports
 * `already_running` forever.
 *
 * The `NOT EXISTS` guard keys off the DBOS workflow ledger directly (the same
 * `dataprofile:{analysisId}:{nonce}` id space this module's trigger mints) so a
 * genuinely in-flight or recovery-requeued run — whose `dbos.workflow_status`
 * row is PENDING/ENQUEUED/DELAYED — is never disturbed: only a row with no
 * active workflow is reset. Call it AFTER `DBOS.launch()` has run recovery, so
 * a resumable run has already been re-queued and is visible to the guard.
 */
export function reconcileOrphanedDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.reconcileOrphanedDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'failed',
                data_profile_error = 'Profiling never started (no backing workflow); reset for retry',
                data_profile_completed_at = $1
            WHERE analysis_id = $2 AND data_profile_status = 'running'
              AND NOT EXISTS (
                  SELECT 1 FROM dbos.workflow_status
                  WHERE workflow_uuid LIKE 'dataprofile:' || $2 || ':%'
                    AND status IN ('PENDING', 'ENQUEUED', 'DELAYED'))`,
            values: [now, analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Clear an analysis's data profile back to the honest "no profile" state,
 * nulling every `data_profile_*` column plus the `seed_input_file_ids` the
 * profile was taken against. `ok(true)` when a row was cleared, `ok(false)`
 * when the clear was skipped (no such analysis, or a live profile) — a skip
 * stays in the ok channel, exactly like the sibling CAS ops.
 *
 * An emptied input set makes any existing profile a lie: it describes files
 * the analysis no longer has, so the UI must fall back to "not profiled". The
 * `IS DISTINCT FROM 'running'` guard exists because a live profiling workflow's
 * completion write would resurrect half-cleared state (re-stamping `completed`
 * over the freshly-nulled ledger). Rather than fight the workflow, clearing
 * defers on a running row and leaves reconciliation to the caller's next
 * parity check once that workflow has settled.
 */
export function clearDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    return tryMutation("dataProfile.clearDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = NULL, data_profile_error = NULL,
                data_profile_started_at = NULL, data_profile_completed_at = NULL,
                data_profile_result = NULL, seed_input_file_ids = NULL
            WHERE analysis_id = $1 AND data_profile_status IS DISTINCT FROM 'running'`,
            values: [analysisId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function loadDataProfileStatus(pool: Querier, analysisId: string): ResultAsync<DataProfileStatus | null, DbError> {
    return tryQuery("dataProfile.loadDataProfileStatus", async () => {
        const result = await pool.query<{
            // A cleared profile leaves the status NULL — the same wire shape as a
            // never-profiled analysis, deliberately indistinguishable to consumers.
            data_profile_status: DataProfileStatus["status"] | null;
            data_profile_error: string | null;
            data_profile_started_at: string | null;
            data_profile_completed_at: string | null;
            data_profile_result: DataProfileStatus["result"];
            seed_input_file_ids: string[] | null;
        }>({
            text: `SELECT data_profile_status, data_profile_error,
                   data_profile_started_at, data_profile_completed_at,
                   data_profile_result, seed_input_file_ids
            FROM cortex_analysis_state WHERE analysis_id = $1`,
            values: [analysisId],
        });
        const row = result.rows[0];
        if (!row || row.data_profile_status === null) return null;
        return {
            status: row.data_profile_status,
            error: row.data_profile_error ?? null,
            startedAt: row.data_profile_started_at ?? null,
            completedAt: row.data_profile_completed_at ?? null,
            result: row.data_profile_result ?? null,
            seedInputFileIds: row.seed_input_file_ids ?? null,
        };
    });
}
