/**
 * The rows of `cortex_paused_work`: one row for each workflow that waits in a pause. The workflow writes its row
 * before it waits and deletes it when the wait ends. A stop of the work deletes the rows of the work.
 */

import type { ResultAsync } from "neverthrow";
import type { QueryConfig } from "pg";
import { z } from "zod";

import type { RunSession } from "../auth/types.js";
import type { PauseCause, PausedWorkKind } from "../contracts/chat-parts.js";
import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

/** One waiting workflow, as its row records it. */
export type PauseRecord = {
    readonly workflowId: string;
    readonly workId: string;
    readonly workKind: PausedWorkKind;
    readonly analysisId: string;
    readonly threadId?: string;
    readonly state: "retrying" | "paused";
    readonly cause: PauseCause;
    /** The count of timer retries before this wait. */
    readonly attempt: number;
    /** ISO 8601. Present for the state `retrying` only. */
    readonly retryAt?: string;
    /** The topic that the message of a resume goes to. */
    readonly topic: string;
    /** ISO 8601. */
    readonly pausedAt: string;
    /** The run session of the workflow, for a run and a profile. A resume renews the run credential from it. */
    readonly runSession?: RunSession;
};

const PauseCauseSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("outage") }),
    z.object({ kind: z.literal("credential") }),
    z.object({ kind: z.literal("host"), reason: z.string() }),
]);

const PauseRowSchema = z.object({
    workflow_id: z.string(),
    work_id: z.string(),
    work_kind: z.enum(["turn", "run", "profile"]),
    analysis_id: z.string(),
    thread_id: z.string().nullable(),
    state: z.enum(["retrying", "paused"]),
    cause: PauseCauseSchema,
    attempt: z.number(),
    retry_at: z.date().nullable(),
    topic: z.string(),
    paused_at: z.date(),
    run_session: z
        .object({
            identity: z.object({ user: z.string() }),
            scope: z.object({ kind: z.literal("analysis"), analysisId: z.string(), threadId: z.string().optional() }),
            provenance: z.object({ agentId: z.string(), callPath: z.array(z.string()) }),
            runFrame: z.object({ runId: z.string(), stepId: z.string().optional() }),
            // The harness never reads the opaque `auth`: the row holds the JSON that the workflow wrote from its own
            // `RunSession`, and the realization of the host downcasts it.
            auth: z.record(z.string(), z.json()),
        })
        .nullable(),
});

/**
 * The row-reading surface of the reads: one query whose rows the row schema types. A computed test fake satisfies
 * it directly, where the row-generic of `Querier` cannot be implemented by a fake that computes its rows.
 */
export type PauseRowQuerier = {
    query(queryTextOrConfig: string | QueryConfig, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

const COLUMNS = "workflow_id, work_id, work_kind, analysis_id, thread_id, state, cause, attempt, retry_at, topic, paused_at, run_session";

function recordOf(row: unknown): PauseRecord {
    const parsed = PauseRowSchema.parse(row);
    return {
        workflowId: parsed.workflow_id,
        workId: parsed.work_id,
        workKind: parsed.work_kind,
        analysisId: parsed.analysis_id,
        threadId: parsed.thread_id ?? undefined,
        state: parsed.state,
        cause: parsed.cause,
        attempt: parsed.attempt,
        retryAt: parsed.retry_at?.toISOString(),
        topic: parsed.topic,
        pausedAt: parsed.paused_at.toISOString(),
        runSession: parsed.run_session ?? undefined,
    };
}

/** Write the row of a waiting workflow. A workflow waits in one pause at a time, thus a new pause replaces its row. */
export function recordPause(pool: Querier, record: PauseRecord): ResultAsync<void, DbError> {
    return tryMutation("pausedWork.record", () =>
        pool.query(
            `INSERT INTO cortex_paused_work (${COLUMNS})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (workflow_id) DO UPDATE SET
               work_id = EXCLUDED.work_id, work_kind = EXCLUDED.work_kind, analysis_id = EXCLUDED.analysis_id,
               thread_id = EXCLUDED.thread_id, state = EXCLUDED.state, cause = EXCLUDED.cause, attempt = EXCLUDED.attempt,
               retry_at = EXCLUDED.retry_at, topic = EXCLUDED.topic, paused_at = EXCLUDED.paused_at,
               run_session = EXCLUDED.run_session`,
            [
                record.workflowId,
                record.workId,
                record.workKind,
                record.analysisId,
                record.threadId ?? null,
                record.state,
                JSON.stringify(record.cause),
                record.attempt,
                record.retryAt ?? null,
                record.topic,
                record.pausedAt,
                record.runSession === undefined ? null : JSON.stringify(record.runSession),
            ],
        ),
    ).map(() => undefined);
}

/** Delete the row of a workflow whose wait ended. A second delete changes nothing. */
export function clearPause(pool: Querier, workflowId: string): ResultAsync<void, DbError> {
    return tryMutation("pausedWork.clear", () => pool.query("DELETE FROM cortex_paused_work WHERE workflow_id = $1", [workflowId])).map(() => undefined);
}

/** Delete the rows of workflows that no longer wait, in one statement. */
export function clearPauses(pool: Querier, workflowIds: readonly string[]): ResultAsync<void, DbError> {
    return tryMutation("pausedWork.clearMany", () => pool.query("DELETE FROM cortex_paused_work WHERE workflow_id = ANY($1)", [workflowIds])).map(
        () => undefined,
    );
}

/** Delete the rows of each workflow of the work, for a stop of the work. */
export function clearPausesOfWork(pool: Querier, workId: string): ResultAsync<void, DbError> {
    return tryMutation("pausedWork.clearWork", () => pool.query("DELETE FROM cortex_paused_work WHERE work_id = $1", [workId])).map(() => undefined);
}

/** The rows of the paused work of an analysis, the oldest pause first. */
export function queryPausesOfAnalysis(pool: PauseRowQuerier, analysisId: string): ResultAsync<PauseRecord[], DbError> {
    return tryQuery("pausedWork.ofAnalysis", async () => {
        const { rows } = await pool.query(`SELECT ${COLUMNS} FROM cortex_paused_work WHERE analysis_id = $1 ORDER BY paused_at, workflow_id`, [analysisId]);
        return rows.map(recordOf);
    });
}

/** The rows of the waiting workflows of one work in an analysis. */
export function queryPausesOfWork(pool: PauseRowQuerier, analysisId: string, workId: string): ResultAsync<PauseRecord[], DbError> {
    return tryQuery("pausedWork.ofWork", async () => {
        const { rows } = await pool.query(`SELECT ${COLUMNS} FROM cortex_paused_work WHERE analysis_id = $1 AND work_id = $2 ORDER BY workflow_id`, [
            analysisId,
            workId,
        ]);
        return rows.map(recordOf);
    });
}
