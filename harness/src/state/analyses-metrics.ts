/**
 * Cross-entity aggregate reads used by `routes/analyses-metrics.ts` to build
 * the per-analysis metrics view. Each query touches one table; the view is
 * the batch shape callers want.
 */

import { okAsync, type ResultAsync } from "neverthrow";

import { tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

export function queryRunCountsByAnalyses(
    pool: Querier,
    analysisIds: string[],
): ResultAsync<Array<{ analysisId: string; status: string; count: number }>, DbError> {
    if (analysisIds.length === 0) return okAsync([]);
    return tryQuery("analysesMetrics.queryRunCountsByAnalyses", async () => {
        const result = await pool.query<{
            analysis_id: string;
            status: string;
            count: number;
        }>({
            text: `SELECT analysis_id, status, COUNT(*)::int AS count
             FROM cortex_runs
             WHERE analysis_id = ANY($1::text[])
             GROUP BY analysis_id, status`,
            values: [analysisIds],
        });
        return result.rows.map((r) => ({
            analysisId: r.analysis_id,
            status: r.status,
            count: r.count,
        }));
    });
}

export function queryThreadCountsByAnalyses(pool: Querier, analysisIds: string[]): ResultAsync<Array<{ analysisId: string; count: number }>, DbError> {
    if (analysisIds.length === 0) return okAsync([]);
    return tryQuery("analysesMetrics.queryThreadCountsByAnalyses", async () => {
        const result = await pool.query<{
            analysis_id: string;
            count: number;
        }>({
            text: `SELECT analysis_id, COUNT(*)::int AS count
             FROM cortex_analysis_threads
             WHERE analysis_id = ANY($1::text[])
               AND deleted_at IS NULL
             GROUP BY analysis_id`,
            values: [analysisIds],
        });
        return result.rows.map((r) => ({
            analysisId: r.analysis_id,
            count: r.count,
        }));
    });
}

export function queryDataProfileStatusByAnalyses(
    pool: Querier,
    analysisIds: string[],
): ResultAsync<Array<{ analysisId: string; status: string | null }>, DbError> {
    if (analysisIds.length === 0) return okAsync([]);
    return tryQuery("analysesMetrics.queryDataProfileStatusByAnalyses", async () => {
        const result = await pool.query<{
            analysis_id: string;
            data_profile_status: string | null;
        }>({
            text: `SELECT analysis_id, data_profile_status
             FROM cortex_analysis_state
             WHERE analysis_id = ANY($1::text[])`,
            values: [analysisIds],
        });
        return result.rows.map((r) => ({
            analysisId: r.analysis_id,
            status: r.data_profile_status ?? null,
        }));
    });
}
