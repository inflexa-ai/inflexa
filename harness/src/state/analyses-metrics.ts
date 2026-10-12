/**
 * Cross-entity aggregate reads for a list of analyses. Each read takes the ids
 * of a page and sends one statement, whatever the length of the list: an
 * embedder builds the per-analysis summary of a list from these reads, never
 * from one read for each analysis.
 */

import { okAsync, type ResultAsync } from "neverthrow";

import type { DataProfileCoverage, DataProfileKind, DataProfileLifecycleStatus, DataProfilePartition } from "../contracts/data-profile.js";
import { profileDatasetFileCount } from "../app/data-profile-view.js";
import { tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import type { RunStatus } from "./schema.js";

/** The newest run of one analysis, with the title of its plan and the counts of its step rows. */
export interface LatestRunSummary {
    readonly analysisId: string;
    readonly runId: string;
    readonly status: RunStatus;
    readonly planTitle: string | null;
    readonly doneSteps: number;
    readonly totalSteps: number;
    readonly startedAt: string;
    readonly completedAt: string | null;
}

/** The data profile state of one analysis that has a profile status. */
export interface DataProfileSummary {
    readonly analysisId: string;
    readonly status: DataProfileLifecycleStatus;
    readonly completedAt: string | null;
    readonly profiledFiles: number | null;
}

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

/** A plan title as text: trimmed with `trim()`, and `null` when it is blank. The SQL gives the title only when it is a string. */
function titleOf(title: string | null): string | null {
    const trimmed = title?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
}

/**
 * The newest run of each analysis of a list, in one statement. An analysis with
 * no run has no entry. The newest run has the latest `started_at`, and `run_id`
 * breaks a tie in descending order. The `LATERAL` subquery reads
 * `idx_cortex_runs_analysis_started`, thus one index entry for each analysis
 * and not a sort of the run history.
 *
 * The plan joins on `plan_id` and `analysis_id`: a plan of a different analysis
 * gives no title, the scope rule of `loadPlan`. The statement gives the title
 * only when it is a string, and the row mapping trims it with `trim()`, the
 * rule of the cli `planTitleOf`. A blank title or a title that is not a string
 * reads as `null`. The step counts
 * cover the ledger rows of the selected run only, the reserved synthesis row
 * included.
 */
export function queryLatestRunsByAnalyses(pool: Querier, analysisIds: string[]): ResultAsync<LatestRunSummary[], DbError> {
    if (analysisIds.length === 0) return okAsync([]);
    return tryQuery("analysesMetrics.queryLatestRunsByAnalyses", async () => {
        const result = await pool.query<{
            analysis_id: string;
            run_id: string;
            status: RunStatus;
            started_at: string;
            completed_at: string | null;
            plan_title: string | null;
            done_steps: number;
            total_steps: number;
        }>({
            text: `SELECT a.id AS analysis_id, r.run_id, r.status, r.started_at, r.completed_at,
                    CASE WHEN jsonb_typeof(p.plan->'title') = 'string' THEN p.plan->>'title' END AS plan_title,
                    s.done_steps, s.total_steps
             FROM unnest($1::text[]) AS a(id)
             CROSS JOIN LATERAL (
                 SELECT run_id, status, started_at, completed_at, plan_id
                 FROM cortex_runs
                 WHERE analysis_id = a.id
                 ORDER BY started_at DESC, run_id DESC
                 LIMIT 1
             ) r
             LEFT JOIN cortex_plans p ON p.plan_id = r.plan_id AND p.analysis_id = a.id
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::int AS total_steps,
                        (COUNT(*) FILTER (WHERE status = 'completed'))::int AS done_steps
                 FROM cortex_step_executions
                 WHERE run_id = r.run_id
             ) s`,
            values: [analysisIds],
        });
        return result.rows.map((r) => ({
            analysisId: r.analysis_id,
            runId: r.run_id,
            status: r.status,
            planTitle: titleOf(r.plan_title),
            doneSteps: r.done_steps,
            totalSteps: r.total_steps,
            startedAt: r.started_at,
            completedAt: r.completed_at,
        }));
    });
}

/**
 * The profile state of each analysis of a list, in one statement. An analysis
 * with no ledger row, or with a cleared row whose status is null, has no entry:
 * the same collapsed absence as `loadDataProfileStatus`. The statement selects
 * only the three parts of the stored result that the file count reads, and the
 * count itself is `profileDatasetFileCount`.
 */
export function queryDataProfileStatusByAnalyses(pool: Querier, analysisIds: string[]): ResultAsync<DataProfileSummary[], DbError> {
    if (analysisIds.length === 0) return okAsync([]);
    return tryQuery("analysesMetrics.queryDataProfileStatusByAnalyses", async () => {
        const result = await pool.query<{
            analysis_id: string;
            data_profile_status: DataProfileLifecycleStatus;
            data_profile_completed_at: string | null;
            partition: DataProfilePartition | null;
            coverage: DataProfileCoverage | null;
            kinds: DataProfileKind[] | null;
        }>({
            text: `SELECT analysis_id, data_profile_status, data_profile_completed_at,
                    data_profile_result->'partition' AS partition,
                    data_profile_result->'coverage' AS coverage,
                    data_profile_result->'kinds' AS kinds
             FROM cortex_analysis_state
             WHERE analysis_id = ANY($1::text[]) AND data_profile_status IS NOT NULL`,
            values: [analysisIds],
        });
        return result.rows.map((r) => ({
            analysisId: r.analysis_id,
            status: r.data_profile_status,
            completedAt: r.data_profile_completed_at ?? null,
            profiledFiles: profileDatasetFileCount({
                ...(r.partition === null ? {} : { partition: r.partition }),
                ...(r.coverage === null ? {} : { coverage: r.coverage }),
                ...(r.kinds === null ? {} : { kinds: r.kinds }),
            }),
        }));
    });
}
