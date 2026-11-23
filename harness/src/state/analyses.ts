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
 *
 * `seedInputCount` is the file count of the input set that the next profile must cover. An
 * absent count leaves the stored seed unchanged.
 */
export function upsertAnalysis(pool: Querier, resourceId: string, context: string | null, seedInputCount?: number): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("analyses.upsertAnalysis", async () => {
        await pool.query({
            text: `INSERT INTO cortex_analysis_state
            (analysis_id, status, context, data_profile_status,
             seed_input_count, created_at, updated_at)
            VALUES ($1, 'active', $2, 'pending', $3, $4, $5)
            ON CONFLICT (analysis_id) DO UPDATE SET
              context = EXCLUDED.context,
              seed_input_count = COALESCE(EXCLUDED.seed_input_count, cortex_analysis_state.seed_input_count),
              updated_at = EXCLUDED.updated_at`,
            values: [resourceId, context ?? null, seedInputCount ?? null, now, now],
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
