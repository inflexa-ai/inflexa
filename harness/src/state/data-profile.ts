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
 * Try to claim the `pending → running` transition. `ok(true)` when this call
 * won the CAS, `ok(false)` when it lost (already claimed) — losing the race is
 * NOT an error, it stays in the ok channel.
 */
export function tryStartDataProfile(pool: Querier, analysisId: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("dataProfile.tryStartDataProfile", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_analysis_state
            SET data_profile_status = 'running', data_profile_started_at = $1
            WHERE analysis_id = $2 AND data_profile_status = 'pending'`,
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

export function loadDataProfileStatus(pool: Querier, analysisId: string): ResultAsync<DataProfileStatus | null, DbError> {
    return tryQuery("dataProfile.loadDataProfileStatus", async () => {
        const result = await pool.query<{
            data_profile_status: DataProfileStatus["status"];
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
        if (!row) return null;
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
