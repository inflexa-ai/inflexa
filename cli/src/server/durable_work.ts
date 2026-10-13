import { StatusString, type Pool } from "@inflexa-ai/harness";
import { okAsync, ResultAsync } from "neverthrow";

/** The count of the runs and of the data profiles whose durable workflow is live. */
export type LiveDurableWork = { runs: number; profiles: number };

/** The DBOS statuses of a workflow that runs, or that will run. The harness treats the same set as live. */
const LIVE_WORKFLOW_STATUSES: readonly string[] = [StatusString.PENDING, StatusString.ENQUEUED, StatusString.DELAYED];

/**
 * The liveness rule, as two SQL predicates over `cortex_runs r` and `cortex_analysis_state s`. Parameter `$2` is
 * {@link LIVE_WORKFLOW_STATUSES}. The one-analysis count, the grouped count, and the list of live run ids share
 * the text, thus the busy gate and the lists cannot disagree on what is live.
 */
const RUN_IS_LIVE = `r.status IN ('running', 'suspended_insufficient_funds')
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND (ws.workflow_uuid = r.run_id OR ws.workflow_uuid LIKE r.run_id || '-%'))`;
const PROFILE_IS_LIVE = `s.data_profile_status = 'running'
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND ws.workflow_uuid = s.data_profile_workflow_id)`;

/**
 * The runs and the data profiles whose durable workflow is live, in one read: of one analysis, or of each
 * analysis when `analysisId` is absent. The busy gate and the activity count of a stop both read it.
 *
 * A ledger row counts only while a live workflow stands behind it: a crashed host leaves a `running` row for
 * ever, while its workflow settles terminal. Thus the DBOS status table is the liveness record. The harness
 * exports no read of that table, thus this query reads it. The run status set is the one of
 * `queryActiveRunsByAnalysis` of the harness, and a run counts with its `<runId>-N` children. A profile row
 * whose workflow id is not recorded yet does not count: its profile drive counts instead.
 */
export function countLiveDurableWork(pool: Pool, analysisId?: string): ResultAsync<LiveDurableWork, unknown> {
    return ResultAsync.fromPromise(
        pool.query<{ runs: string; profiles: string }>({
            text: `SELECT
                     (SELECT COUNT(*) FROM cortex_runs r
                        WHERE ($1::text IS NULL OR r.analysis_id = $1::text)
                          AND ${RUN_IS_LIVE}) AS runs,
                     (SELECT COUNT(*) FROM cortex_analysis_state s
                        WHERE ($1::text IS NULL OR s.analysis_id = $1::text)
                          AND ${PROFILE_IS_LIVE}) AS profiles`,
            values: [analysisId ?? null, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map((result) => ({ runs: Number(result.rows[0]?.runs ?? 0), profiles: Number(result.rows[0]?.profiles ?? 0) }));
}

/**
 * {@link countLiveDurableWork} for a list of analyses, in one statement: the count of each analysis, with the
 * liveness rule of the one-analysis form. Each id of `analysisIds` has an entry, `0` and `0` when nothing of it
 * is live. An empty list sends no query.
 */
export function countLiveDurableWorkByAnalysis(pool: Pool, analysisIds: readonly string[]): ResultAsync<Map<string, LiveDurableWork>, unknown> {
    if (analysisIds.length === 0) return okAsync(new Map());
    return ResultAsync.fromPromise(
        pool.query<{ analysis_id: string; runs: string; profiles: string }>({
            text: `SELECT ids.analysis_id,
                     (SELECT COUNT(*) FROM cortex_runs r
                        WHERE r.analysis_id = ids.analysis_id
                          AND ${RUN_IS_LIVE}) AS runs,
                     (SELECT COUNT(*) FROM cortex_analysis_state s
                        WHERE s.analysis_id = ids.analysis_id
                          AND ${PROFILE_IS_LIVE}) AS profiles
                   FROM unnest($1::text[]) AS ids(analysis_id)`,
            values: [analysisIds, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map((result) => new Map(result.rows.map((row) => [row.analysis_id, { runs: Number(row.runs), profiles: Number(row.profiles) }])));
}

/**
 * The id of each run whose durable workflow is live, over each analysis, the newest start first, with at most
 * `limit` ids. It reads {@link RUN_IS_LIVE} as it stands: `$1` is the limit and `$2` stays the live workflow
 * statuses.
 */
export function listLiveRunIds(pool: Pool, limit: number): ResultAsync<string[], unknown> {
    return ResultAsync.fromPromise(
        pool.query<{ run_id: string }>({
            text: `SELECT r.run_id FROM cortex_runs r
                    WHERE ${RUN_IS_LIVE}
                    ORDER BY r.started_at DESC, r.run_id DESC
                    LIMIT $1`,
            values: [limit, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map((result) => result.rows.map((row) => row.run_id));
}
