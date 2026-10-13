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
import type { RunStatus, TerminalRunStatus } from "./schema.js";

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

/** A run of a list of run ids, with the fields of the newest-run read and the thread of the run. */
export interface RunProgressSummary extends LatestRunSummary {
    /** The thread of the run as the ledger stores it, or `null`. */
    readonly threadId: string | null;
}

/** A terminal run that ended at or after a time. */
export interface EndedRunSummary {
    readonly analysisId: string;
    readonly runId: string;
    readonly status: TerminalRunStatus;
    readonly completedAt: string;
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

interface RunProgressRow {
    analysis_id: string;
    run_id: string;
    status: RunStatus;
    started_at: string;
    completed_at: string | null;
    plan_title: string | null;
    done_steps: number;
    total_steps: number;
}

/**
 * The columns of a run summary over a run alias `r`, and the plan alias `p` and
 * the step count alias `s` of `RUN_PROGRESS_JOINS`. The two reads of a run
 * summary put these after their own selection of `r`, thus the title rule and
 * the step count rule have one text.
 */
const RUN_PROGRESS_COLUMNS = `r.analysis_id, r.run_id, r.status, r.started_at, r.completed_at,
                    CASE WHEN jsonb_typeof(p.plan->'title') = 'string' THEN p.plan->>'title' END AS plan_title,
                    s.done_steps, s.total_steps`;

/** The plan join and the step count subquery for a run alias `r` that selects `analysis_id`, `run_id`, and `plan_id`. */
const RUN_PROGRESS_JOINS = `LEFT JOIN cortex_plans p ON p.plan_id = r.plan_id AND p.analysis_id = r.analysis_id
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::int AS total_steps,
                        (COUNT(*) FILTER (WHERE status = 'completed'))::int AS done_steps
                 FROM cortex_step_executions
                 WHERE run_id = r.run_id
             ) s`;

function toRunSummary(row: RunProgressRow): LatestRunSummary {
    return {
        analysisId: row.analysis_id,
        runId: row.run_id,
        status: row.status,
        planTitle: titleOf(row.plan_title),
        doneSteps: row.done_steps,
        totalSteps: row.total_steps,
        startedAt: row.started_at,
        completedAt: row.completed_at,
    };
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
        const result = await pool.query<RunProgressRow>({
            text: `SELECT ${RUN_PROGRESS_COLUMNS}
             FROM unnest($1::text[]) AS a(id)
             CROSS JOIN LATERAL (
                 SELECT analysis_id, run_id, status, started_at, completed_at, plan_id
                 FROM cortex_runs
                 WHERE analysis_id = a.id
                 ORDER BY started_at DESC, run_id DESC
                 LIMIT 1
             ) r
             ${RUN_PROGRESS_JOINS}`,
            values: [analysisIds],
        });
        return result.rows.map(toRunSummary);
    });
}

/**
 * The progress of each run of a list of run ids, in one statement. An id with
 * no run row has no entry. The entries come newest first by `started_at`, and
 * `run_id` breaks a tie in descending order. The plan title and the step counts
 * follow the rules of `queryLatestRunsByAnalyses`, and each entry adds the
 * thread of the run.
 */
export function queryRunProgressByRuns(pool: Querier, runIds: string[]): ResultAsync<RunProgressSummary[], DbError> {
    if (runIds.length === 0) return okAsync([]);
    return tryQuery("analysesMetrics.queryRunProgressByRuns", async () => {
        const result = await pool.query<RunProgressRow & { thread_id: string | null }>({
            text: `SELECT ${RUN_PROGRESS_COLUMNS}, r.thread_id
             FROM cortex_runs r
             ${RUN_PROGRESS_JOINS}
             WHERE r.run_id = ANY($1::text[])
             ORDER BY r.started_at DESC, r.run_id DESC`,
            values: [runIds],
        });
        return result.rows.map((row) => ({ ...toRunSummary(row), threadId: row.thread_id }));
    });
}

/**
 * The newest `limit` terminal runs of every analysis that ended at or after
 * `since`, newest completion first, with `run_id` breaking a tie in descending
 * order. `since` is in the form of `toISOString()`, the form of each
 * `completed_at` stamp, thus the text comparison is the time comparison. The
 * statement walks `idx_cortex_runs_completed`.
 */
export function queryRunsEndedSince(pool: Querier, input: { since: string; limit: number }): ResultAsync<EndedRunSummary[], DbError> {
    return tryQuery("analysesMetrics.queryRunsEndedSince", async () => {
        const result = await pool.query<{ analysis_id: string; run_id: string; status: TerminalRunStatus; completed_at: string }>({
            text: `SELECT analysis_id, run_id, status, completed_at
             FROM cortex_runs
             WHERE status IN ('completed', 'partial', 'failed', 'canceled')
               AND completed_at >= $1
             ORDER BY completed_at DESC, run_id DESC
             LIMIT $2`,
            values: [input.since, input.limit],
        });
        return result.rows.map((row) => ({
            analysisId: row.analysis_id,
            runId: row.run_id,
            status: row.status,
            completedAt: row.completed_at,
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
