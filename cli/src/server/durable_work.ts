import { StatusString, type Pool } from "@inflexa-ai/harness";
import { okAsync, ResultAsync } from "neverthrow";

/** The count of the runs, of the data profiles, and of the chat turns whose durable workflow is live. */
export type LiveDurableWork = { runs: number; profiles: number; turns: number };

/** The DBOS statuses of a workflow that runs, or that will run. The harness treats the same set as live. */
const LIVE_WORKFLOW_STATUSES: readonly string[] = [StatusString.PENDING, StatusString.ENQUEUED, StatusString.DELAYED];

/**
 * The liveness rule, as three SQL predicates over `cortex_runs r`, `cortex_analysis_state s`, and
 * `cortex_analysis_threads t`. Parameter `$2` is {@link LIVE_WORKFLOW_STATUSES}. The one-analysis count, the grouped
 * count, and the list of live run ids share the text, thus the busy gate and the lists cannot disagree on what is
 * live.
 *
 * A run with a paused step stays `running`, and its paused workflows stay `PENDING`, thus it counts. A chat turn
 * holds the claim of its thread from its open to its end, and the workflow id of a turn is the turn id. Thus a turn
 * that runs or waits in a pause counts, also a turn that a recovery runs and the turn registry does not hold.
 */
const RUN_IS_LIVE = `r.status = 'running'
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND (ws.workflow_uuid = r.run_id OR ws.workflow_uuid LIKE r.run_id || '-%'))`;
const PROFILE_IS_LIVE = `s.data_profile_status = 'running'
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND ws.workflow_uuid = s.data_profile_workflow_id)`;
const TURN_IS_LIVE = `t.active_turn_id IS NOT NULL
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND ws.workflow_uuid = t.active_turn_id)`;

/**
 * The runs, the data profiles, and the chat turns whose durable workflow is live, in one read: of one analysis, or of
 * each analysis when `analysisId` is absent. The busy gate and the activity count of a stop both read it.
 *
 * A ledger row counts only while a live workflow stands behind it: a crashed host leaves a `running` row for
 * ever, while its workflow settles terminal. Thus the DBOS status table is the liveness record. The harness
 * exports no read of that table, thus this query reads it. The run status set is the one of
 * `queryActiveRunsByAnalysis` of the harness, and a run counts with its `<runId>-N` children. A profile row
 * whose workflow id is not recorded yet does not count: its profile drive counts instead.
 */
export function countLiveDurableWork(pool: Pool, analysisId?: string): ResultAsync<LiveDurableWork, unknown> {
    return ResultAsync.fromPromise(
        pool.query<{ runs: string; profiles: string; turns: string }>({
            text: `SELECT
                     (SELECT COUNT(*) FROM cortex_runs r
                        WHERE ($1::text IS NULL OR r.analysis_id = $1::text)
                          AND ${RUN_IS_LIVE}) AS runs,
                     (SELECT COUNT(*) FROM cortex_analysis_state s
                        WHERE ($1::text IS NULL OR s.analysis_id = $1::text)
                          AND ${PROFILE_IS_LIVE}) AS profiles,
                     (SELECT COUNT(*) FROM cortex_analysis_threads t
                        WHERE ($1::text IS NULL OR t.analysis_id = $1::text)
                          AND ${TURN_IS_LIVE}) AS turns`,
            values: [analysisId ?? null, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map((result) => ({
        runs: Number(result.rows[0]?.runs ?? 0),
        profiles: Number(result.rows[0]?.profiles ?? 0),
        turns: Number(result.rows[0]?.turns ?? 0),
    }));
}

/**
 * {@link countLiveDurableWork} for a list of analyses, in one statement: the count of each analysis, with the
 * liveness rule of the one-analysis form. Each id of `analysisIds` has an entry, with each count `0` when nothing
 * of it is live. An empty list sends no query.
 */
export function countLiveDurableWorkByAnalysis(pool: Pool, analysisIds: readonly string[]): ResultAsync<Map<string, LiveDurableWork>, unknown> {
    if (analysisIds.length === 0) return okAsync(new Map());
    return ResultAsync.fromPromise(
        pool.query<{ analysis_id: string; runs: string; profiles: string; turns: string }>({
            text: `SELECT ids.analysis_id,
                     (SELECT COUNT(*) FROM cortex_runs r
                        WHERE r.analysis_id = ids.analysis_id
                          AND ${RUN_IS_LIVE}) AS runs,
                     (SELECT COUNT(*) FROM cortex_analysis_state s
                        WHERE s.analysis_id = ids.analysis_id
                          AND ${PROFILE_IS_LIVE}) AS profiles,
                     (SELECT COUNT(*) FROM cortex_analysis_threads t
                        WHERE t.analysis_id = ids.analysis_id
                          AND ${TURN_IS_LIVE}) AS turns
                   FROM unnest($1::text[]) AS ids(analysis_id)`,
            values: [analysisIds, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map(
        (result) => new Map(result.rows.map((row) => [row.analysis_id, { runs: Number(row.runs), profiles: Number(row.profiles), turns: Number(row.turns) }])),
    );
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

/** A chat turn whose durable workflow is live, by the claim of its thread. `startedAt` is the start of the workflow. */
export type LiveTurn = { turnId: string; threadId: string; analysisId: string; startedAt: string };

/**
 * The turn of each thread of `threadIds` whose durable workflow is live, by {@link TURN_IS_LIVE}: a turn that runs or
 * waits in a pause, also a turn that a recovery runs and the turn registry does not hold. `$1` is the thread ids. An
 * empty list sends no query.
 */
export function listLiveTurns(pool: Pool, threadIds: readonly string[]): ResultAsync<LiveTurn[], unknown> {
    if (threadIds.length === 0) return okAsync([]);
    return ResultAsync.fromPromise(
        pool.query<{ thread_id: string; analysis_id: string; active_turn_id: string; created_at: string }>({
            text: `SELECT t.thread_id, t.analysis_id, t.active_turn_id,
                          (SELECT ws.created_at FROM dbos.workflow_status ws WHERE ws.workflow_uuid = t.active_turn_id) AS created_at
                     FROM cortex_analysis_threads t
                    WHERE t.thread_id = ANY($1::text[])
                      AND ${TURN_IS_LIVE}`,
            values: [threadIds, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map((result) =>
        result.rows.map((row) => ({
            turnId: row.active_turn_id,
            threadId: row.thread_id,
            analysisId: row.analysis_id,
            startedAt: new Date(Number(row.created_at)).toISOString(),
        })),
    );
}
