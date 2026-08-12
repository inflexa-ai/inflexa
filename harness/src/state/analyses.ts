/**
 * `cortex_analysis_state` operations — analysis lifecycle.
 */

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

/**
 * Upsert a cortex_analysis_state row.
 *
 * The seed endpoint is called repeatedly; this function handles both the
 * initial INSERT and subsequent UPDATEs by writing ALL mutable fields on
 * every call. Re-upserts replace `context` wholesale.
 *
 * User identity is derived from the ambient credential's JWT `sub` claim
 * at request time — not persisted in this table.
 */
export function upsertAnalysis(pool: Querier, resourceId: string, context: string | null, inputFileIds?: string[]): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("analyses.upsertAnalysis", async () => {
        await pool.query({
            text: `INSERT INTO cortex_analysis_state
            (analysis_id, status, context, data_profile_status,
             seed_input_file_ids, created_at, updated_at)
            VALUES ($1, 'active', $2, 'pending', $3::jsonb, $4, $5)
            ON CONFLICT (analysis_id) DO UPDATE SET
              context = EXCLUDED.context,
              seed_input_file_ids = COALESCE(EXCLUDED.seed_input_file_ids, cortex_analysis_state.seed_input_file_ids),
              updated_at = EXCLUDED.updated_at`,
            values: [resourceId, context ?? null, inputFileIds ? JSON.stringify(inputFileIds) : null, now, now],
        });
    });
}

export function loadAnalysisStatus(pool: Querier, resourceId: string): ResultAsync<{ status: string; context: string | null } | null, DbError> {
    return tryQuery("analyses.loadAnalysisStatus", async () => {
        const result = await pool.query<{ status: string; context: string | null }>({
            text: "SELECT status, context FROM cortex_analysis_state WHERE analysis_id = $1",
            values: [resourceId],
        });
        const row = result.rows[0];
        if (!row) return null;
        return { status: row.status, context: row.context ?? null };
    });
}

/**
 * Suspend an analysis due to a 402 `budget_exceeded` error.
 * Idempotent — no-op if already suspended.
 *
 * The only cause of suspension today is budget exhaustion; no reason is
 * persisted. If a second cause arises, add a column rather than a param so
 * history is queryable.
 */
export function suspendAnalysis(pool: Querier, analysisId: string): ResultAsync<void, DbError> {
    return tryMutation("analyses.suspendAnalysis", async () => {
        await pool.query({
            text: `UPDATE cortex_analysis_state
            SET status = 'suspended_insufficient_funds', updated_at = $1
            WHERE analysis_id = $2 AND status != 'suspended_insufficient_funds'`,
            values: [new Date().toISOString(), analysisId],
        });
    });
}

/**
 * Resume a suspended analysis after the user tops up.
 * Only transitions from `suspended_insufficient_funds` → `active`.
 */
export function resumeAnalysis(pool: Querier, analysisId: string): ResultAsync<void, DbError> {
    return tryMutation("analyses.resumeAnalysis", async () => {
        await pool.query({
            text: `UPDATE cortex_analysis_state
            SET status = 'active', updated_at = $1
            WHERE analysis_id = $2 AND status = 'suspended_insufficient_funds'`,
            values: [new Date().toISOString(), analysisId],
        });
    });
}
