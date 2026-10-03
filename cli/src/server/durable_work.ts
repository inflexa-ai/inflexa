import { StatusString, type Pool } from "@inflexa-ai/harness";
import { ResultAsync } from "neverthrow";

/** The count of the runs and of the data profiles whose durable workflow is live. */
export type LiveDurableWork = { runs: number; profiles: number };

/** The DBOS statuses of a workflow that runs, or that will run. The harness treats the same set as live. */
const LIVE_WORKFLOW_STATUSES: readonly string[] = [StatusString.PENDING, StatusString.ENQUEUED, StatusString.DELAYED];

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
                        WHERE r.status IN ('running', 'suspended_insufficient_funds')
                          AND ($1::text IS NULL OR r.analysis_id = $1::text)
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND (ws.workflow_uuid = r.run_id OR ws.workflow_uuid LIKE r.run_id || '-%'))) AS runs,
                     (SELECT COUNT(*) FROM cortex_analysis_state s
                        WHERE s.data_profile_status = 'running'
                          AND ($1::text IS NULL OR s.analysis_id = $1::text)
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status = ANY($2::text[])
                                         AND ws.workflow_uuid = s.data_profile_workflow_id)) AS profiles`,
            values: [analysisId ?? null, LIVE_WORKFLOW_STATUSES],
        }),
        (cause) => cause,
    ).map((result) => ({ runs: Number(result.rows[0]?.runs ?? 0), profiles: Number(result.rows[0]?.profiles ?? 0) }));
}
