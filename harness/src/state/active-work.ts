/**
 * The read of the active work of a list of analyses, in one statement over the four sources of work: the claims of
 * the turns, the `running` runs, the `running` profiles, and the rows of the paused work. The rows carry no active
 * test, because only DBOS knows which workflow still runs. The caller applies that test.
 */

import { okAsync, type ResultAsync } from "neverthrow";
import { z } from "zod";

import type { WorkKind } from "../contracts/chat-parts.js";
import { PauseWaiterSchema } from "../contracts/schemas/chat-parts.js";
import { tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import { PauseCauseSchema, type PauseRecord } from "./paused-work.js";

/** The source row that names a work. A work that no claim, run, or profile row names has `pause` as its source. */
export type WorkSource = "turn" | "run" | "profile" | "pause";

/** One work of the read, with each pause row of the work. */
export type WorkCandidate = {
    readonly workId: string;
    readonly kind: WorkKind;
    readonly source: WorkSource;
    readonly analysisId: string;
    readonly threadId: string | null;
    /** The user of the source row. A work that only its pause rows name takes the user of its first row. */
    readonly userId: string | null;
    /** The ISO 8601 start of a run. Null for a work that is not a run. */
    readonly startedAt: string | null;
    /** The rows of the pauses of the work, the oldest first. The run session is not read. */
    readonly pauses: readonly Omit<PauseRecord, "runSession">[];
};

export type WorkByAnalysesInput = {
    readonly analysisIds: readonly string[];
    /** Narrow to the work of one person. A work with no user never matches. Omitting it narrows nothing. */
    readonly userId?: string;
    /** The most works to give. It clamps to 1 to 200, the bounds of `listRecentThreads`. */
    readonly limit: number;
};

const MAX_WORK_BY_ANALYSES = 200;

const SOURCE_OF_RANK: readonly WorkSource[] = ["turn", "run", "profile", "pause"];

const WorkRowSchema = z.object({
    work_id: z.string(),
    kind: z.enum(["turn", "run", "profile"]),
    source_rank: z.number().int().min(1).max(4),
    analysis_id: z.string(),
    thread_id: z.string().nullable(),
    user_id: z.string().nullable(),
    started_at: z.string().nullable(),
    p_workflow_id: z.string().nullable(),
    p_work_kind: z.enum(["turn", "run", "profile"]).nullable(),
    p_waiter: PauseWaiterSchema.nullable(),
    p_analysis_id: z.string().nullable(),
    p_thread_id: z.string().nullable(),
    p_user_id: z.string().nullable(),
    p_state: z.enum(["retrying", "paused"]).nullable(),
    p_cause: PauseCauseSchema.nullable(),
    p_attempt: z.number().nullable(),
    p_retry_at: z.date().nullable(),
    p_topic: z.string().nullable(),
    p_paused_at: z.date().nullable(),
});

/*
 * The order has three groups. A work that waits comes first, the oldest pause first and the work id as the tie
 * break. A run that does not wait comes next, the newest start first and the run id, descending, as the tie break.
 * A turn or a profile that does not wait comes last, by work id. The group is a total order, thus a limit cuts it at
 * the same place on each call.
 */
const WORK_ORDER = `CASE WHEN first_paused_at IS NOT NULL THEN 0 WHEN source_rank = 2 THEN 1 ELSE 2 END,
                first_paused_at ASC NULLS LAST,
                (CASE WHEN first_paused_at IS NULL AND source_rank = 2 THEN started_at END) DESC NULLS LAST,
                (CASE WHEN first_paused_at IS NOT NULL OR source_rank <> 2 THEN work_id END) ASC NULLS LAST,
                work_id DESC`;

/**
 * The active work of a list of analyses, with each pause row of each work, in one statement. An empty list gives an
 * empty result and sends no query. One source row names each work: the claim of a turn, a `running` run, or a
 * `running` profile, in that order of preference, and else its first pause row.
 */
export function queryWorkByAnalyses(pool: Querier, input: WorkByAnalysesInput): ResultAsync<WorkCandidate[], DbError> {
    if (input.analysisIds.length === 0) return okAsync([]);
    return tryQuery("activeWork.queryWorkByAnalyses", async () => {
        const { rows } = await pool.query(
            `WITH pause_first AS (
                 SELECT DISTINCT ON (work_id) work_id, work_kind, analysis_id, thread_id, user_id, paused_at
                 FROM cortex_paused_work
                 WHERE analysis_id = ANY($1::text[])
                 ORDER BY work_id, paused_at, workflow_id
             ),
             named AS (
                 SELECT DISTINCT ON (work_id) work_id, kind, source_rank, analysis_id, thread_id, user_id, started_at
                 FROM (
                     SELECT active_turn_id AS work_id, 'turn' AS kind, 1 AS source_rank, analysis_id, thread_id,
                            active_turn_user_id AS user_id, NULL::text AS started_at
                     FROM cortex_analysis_threads
                     WHERE analysis_id = ANY($1::text[]) AND active_turn_id IS NOT NULL AND deleted_at IS NULL
                     UNION ALL
                     SELECT run_id, 'run', 2, analysis_id, thread_id, user_id, started_at
                     FROM cortex_runs
                     WHERE analysis_id = ANY($1::text[]) AND status = 'running'
                     UNION ALL
                     SELECT data_profile_workflow_id, 'profile', 3, analysis_id, NULL::text, data_profile_user_id, NULL::text
                     FROM cortex_analysis_state
                     WHERE analysis_id = ANY($1::text[]) AND data_profile_status = 'running' AND data_profile_workflow_id IS NOT NULL
                     UNION ALL
                     SELECT work_id, work_kind, 4, analysis_id, thread_id, user_id, NULL::text
                     FROM pause_first
                 ) candidates
                 ORDER BY work_id, source_rank
             ),
             ranked AS (
                 SELECT n.work_id, n.kind, n.source_rank, n.analysis_id, n.thread_id, n.user_id, n.started_at,
                        pf.paused_at AS first_paused_at
                 FROM named n
                 LEFT JOIN pause_first pf ON pf.work_id = n.work_id
                 WHERE ($2::text IS NULL OR n.user_id = $2)
             ),
             page AS (
                 SELECT ranked.*, ROW_NUMBER() OVER (ORDER BY ${WORK_ORDER}) AS ord
                 FROM ranked
                 ORDER BY ord
                 LIMIT $3
             )
             SELECT page.work_id, page.kind, page.source_rank, page.analysis_id, page.thread_id, page.user_id, page.started_at,
                    pw.workflow_id AS p_workflow_id, pw.work_kind AS p_work_kind, pw.waiter AS p_waiter,
                    pw.analysis_id AS p_analysis_id, pw.thread_id AS p_thread_id, pw.user_id AS p_user_id,
                    pw.state AS p_state, pw.cause AS p_cause, pw.attempt AS p_attempt, pw.retry_at AS p_retry_at,
                    pw.topic AS p_topic, pw.paused_at AS p_paused_at
             FROM page
             LEFT JOIN cortex_paused_work pw ON pw.work_id = page.work_id
             ORDER BY page.ord, pw.paused_at, pw.workflow_id`,
            [input.analysisIds, input.userId ?? null, Math.min(Math.max(input.limit, 1), MAX_WORK_BY_ANALYSES)],
        );

        // The rows come grouped by work, in the order of the work. A map by work id gathers the pause rows of each.
        const works = new Map<string, { candidate: Omit<WorkCandidate, "pauses">; pauses: Omit<PauseRecord, "runSession">[] }>();
        for (const row of rows) {
            const parsed = WorkRowSchema.parse(row);
            let entry = works.get(parsed.work_id);
            if (entry === undefined) {
                entry = {
                    candidate: {
                        workId: parsed.work_id,
                        kind: parsed.kind,
                        source: SOURCE_OF_RANK[parsed.source_rank - 1] ?? "pause",
                        analysisId: parsed.analysis_id,
                        threadId: parsed.thread_id,
                        userId: parsed.user_id,
                        startedAt: parsed.started_at,
                    },
                    pauses: [],
                };
                works.set(parsed.work_id, entry);
            }
            if (parsed.p_workflow_id === null) continue;
            // The pause columns of one row are null together or set together, thus the checks below only narrow the types.
            if (parsed.p_work_kind === null || parsed.p_analysis_id === null || parsed.p_state === null || parsed.p_cause === null) continue;
            if (parsed.p_attempt === null || parsed.p_topic === null || parsed.p_paused_at === null) continue;
            entry.pauses.push({
                workflowId: parsed.p_workflow_id,
                workId: parsed.work_id,
                workKind: parsed.p_work_kind,
                waiter: parsed.p_waiter ?? undefined,
                analysisId: parsed.p_analysis_id,
                threadId: parsed.p_thread_id ?? undefined,
                userId: parsed.p_user_id,
                state: parsed.p_state,
                cause: parsed.p_cause,
                attempt: parsed.p_attempt,
                retryAt: parsed.p_retry_at?.toISOString(),
                topic: parsed.p_topic,
                pausedAt: parsed.p_paused_at.toISOString(),
            });
        }
        return [...works.values()].map(({ candidate, pauses }) => ({ ...candidate, pauses }));
    });
}
