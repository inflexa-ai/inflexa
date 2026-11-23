/**
 * Postgres data access for the tool-approval ledger (`cortex_asks`) and its
 * standing grants (`cortex_ask_grants` for one analysis, `cortex_user_grants` for each analysis of a user).
 *
 * Every operation returns `ResultAsync<T, DbError>` in the `state/` house style —
 * the `pg` throws are caught only inside `tryQuery`/`tryMutation`/`withTransaction`
 * (`lib/db-result.ts`); everything above flows `Result`. Absence rides the ok
 * channel (`ok(null)` / `ok(0)`), never an `err`. The gateway unwraps these at its
 * seam boundary.
 */

import { okAsync, type ResultAsync } from "neverthrow";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { tryMutation, tryQuery, withTransaction, type DbError, type TransactionQuerier } from "../../lib/db-result.js";
import type { AskReply } from "./contract.js";

type Querier = Pool | PoolClient;

/** The ask ledger's status machine — one `pending` state, four terminal ones. */
export type AskStatus = "pending" | "resolved" | "rejected" | "aborted" | "expired";

/** The discriminated outcome of an out-of-band `answer` against a ledger row. */
export type AnswerOutcome = "applied" | "not_found" | "already_terminal";

/** An unresolved ask, as enumerated by `pending()`. */
export type PendingAsk = {
    readonly id: string;
    readonly analysisId: string;
    readonly userId: string;
    readonly threadId: string | null;
    /** The run and the step of an ask that a sandbox step raised, else `null`. */
    readonly runId: string | null;
    readonly stepId: string | null;
    readonly title: string;
    readonly command: string;
    readonly detail: string | null;
    readonly createdAt: string;
};

/** The columns of the pending enumeration, as the SELECT spells them. */
const PendingAskRowSchema = z.object({
    id: z.string(),
    analysis_id: z.string(),
    user_id: z.string(),
    thread_id: z.string().nullable(),
    run_id: z.string().nullable(),
    step_id: z.string().nullable(),
    title: z.string(),
    command: z.string(),
    detail: z.string().nullable(),
    created_at: z.string(),
});

/** The analysis and the person of one ask. `userId` is `null` for a row with no user. */
export type AskScopeOfRow = {
    readonly analysisId: string;
    readonly userId: string | null;
};

/** The input of the pending read over a list of analyses. */
export type PendingByAnalysesInput = {
    readonly analysisIds: readonly string[];
    /** Narrow to the asks raised for one person. An ask with no user never matches. Omitting it narrows nothing. */
    readonly userId?: string;
    /** The most asks to give. It clamps to 1 to 200, the bounds of `listRecentThreads`. */
    readonly limit: number;
};

const MAX_PENDING_BY_ANALYSES = 200;

const AskScopeRowSchema = z.object({ analysis_id: z.string(), user_id: z.string().nullable() });

/** The columns the guarded UPDATE returns for the standing-grant insert. */
const GrantedRowSchema = z.object({ analysis_id: z.string(), user_id: z.string(), grant_key: z.string(), grant_scope: z.string().nullable() });

const AskWorkflowRowSchema = z.object({ workflow_id: z.string().nullable() });

/** Column payload shared by the pending insert and the grant short-circuit insert. */
export type AskRow = {
    readonly id: string;
    readonly analysisId: string;
    readonly userId: string;
    readonly threadId: string | null;
    readonly runId: string | null;
    readonly stepId: string | null;
    readonly title: string;
    readonly command: string;
    readonly detail: string | null;
    /** Grant key an `always` keys its standing grant under; `null` falls back to `command`. */
    readonly grantKey: string | null;
    readonly grantScope: "analysis" | "user" | null;
    /** The workflow that waits for the answer. */
    readonly workflowId: string | null;
    readonly createdAt: string;
};

/** Insert a fresh `pending` ask before its decision is awaited. */
export function insertPendingAsk(querier: Querier, row: AskRow): ResultAsync<void, DbError> {
    return tryMutation("asks.insertPending", async () => {
        await querier.query({
            text: `INSERT INTO cortex_asks
              (id, analysis_id, user_id, thread_id, run_id, step_id, title, command, detail, grant_key, grant_scope, workflow_id, status, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13)
              ON CONFLICT (id) DO NOTHING`,
            values: [
                row.id,
                row.analysisId,
                row.userId,
                row.threadId,
                row.runId,
                row.stepId,
                row.title,
                row.command,
                row.detail,
                row.grantKey ?? row.command,
                row.grantScope,
                row.workflowId,
                row.createdAt,
            ],
        });
    });
}

/**
 * Insert an already-`resolved` ask recording an auto-approval a standing grant
 * short-circuited: no prompt was shown, but the ledger stays a complete audit of
 * every approval-gated action. The recorded reply is `{ kind: "always" }`.
 */
export function insertGrantedAsk(querier: Querier, row: AskRow, resolvedAt: string): ResultAsync<void, DbError> {
    return tryMutation("asks.insertGranted", async () => {
        await querier.query({
            text: `INSERT INTO cortex_asks
              (id, analysis_id, user_id, thread_id, run_id, step_id, title, command, detail, grant_key, grant_scope, workflow_id, status, reply, created_at, resolved_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'resolved', $13::jsonb, $14, $15)
              ON CONFLICT (id) DO NOTHING`,
            values: [
                row.id,
                row.analysisId,
                row.userId,
                row.threadId,
                row.runId,
                row.stepId,
                row.title,
                row.command,
                row.detail,
                row.grantKey ?? row.command,
                row.grantScope,
                row.workflowId,
                JSON.stringify({ kind: "always" }),
                row.createdAt,
                resolvedAt,
            ],
        });
    });
}

/** Does a standing grant of this person cover `grantKey`, in the analysis or in each analysis of the person? */
export function selectGrant(querier: Querier, analysisId: string, userId: string, grantKey: string): ResultAsync<boolean, DbError> {
    return tryQuery("asks.selectGrant", async () => {
        const result = await querier.query({
            text: `SELECT 1 FROM cortex_ask_grants WHERE analysis_id = $1 AND user_id = $2 AND grant_key = $3
              UNION ALL
              SELECT 1 FROM cortex_user_grants WHERE user_id = $2 AND grant_key = $3
              LIMIT 1`,
            values: [analysisId, userId, grantKey],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/** Mark a still-`pending` row `expired`. A row that an answer settled does not change. */
export function markExpired(querier: Querier, id: string, resolvedAt: string): ResultAsync<void, DbError> {
    return tryMutation("asks.markExpired", async () => {
        await querier.query({
            text: `UPDATE cortex_asks SET status = 'expired', resolved_at = $2 WHERE id = $1 AND status = 'pending'`,
            values: [id, resolvedAt],
        });
    });
}

/**
 * Mark a still-`pending` row `aborted`. Guarded by `WHERE status = 'pending'`, so
 * a row already answered out of band is left untouched.
 */
export function markAborted(querier: Querier, id: string, resolvedAt: string): ResultAsync<void, DbError> {
    return tryMutation("asks.markAborted", async () => {
        await querier.query({
            text: `UPDATE cortex_asks SET status = 'aborted', resolved_at = $2 WHERE id = $1 AND status = 'pending'`,
            values: [id, resolvedAt],
        });
    });
}

/** Enumerate every unresolved ask, oldest first. */
export function selectPending(querier: Querier): ResultAsync<PendingAsk[], DbError> {
    return tryQuery("asks.selectPending", async () => {
        const result = await querier.query({
            text: `SELECT id, analysis_id, COALESCE(user_id, '') AS user_id, thread_id, run_id, step_id, title, command, detail, created_at
              FROM cortex_asks WHERE status = 'pending' ORDER BY created_at ASC`,
        });
        return result.rows.map(pendingAskOf);
    });
}

function pendingAskOf(row: unknown): PendingAsk {
    const parsed = PendingAskRowSchema.parse(row);
    return {
        id: parsed.id,
        analysisId: parsed.analysis_id,
        userId: parsed.user_id,
        threadId: parsed.thread_id ?? null,
        runId: parsed.run_id,
        stepId: parsed.step_id,
        title: parsed.title,
        command: parsed.command,
        detail: parsed.detail ?? null,
        createdAt: parsed.created_at,
    };
}

/**
 * Enumerate the unresolved asks of a list of analyses, oldest first, with the id breaking a tie in ascending order,
 * in one statement. An empty list gives an empty result and sends no query.
 */
export function selectPendingByAnalyses(querier: Querier, input: PendingByAnalysesInput): ResultAsync<PendingAsk[], DbError> {
    if (input.analysisIds.length === 0) return okAsync([]);
    return tryQuery("asks.selectPendingByAnalyses", async () => {
        const result = await querier.query({
            text: `SELECT id, analysis_id, COALESCE(user_id, '') AS user_id, thread_id, run_id, step_id, title, command, detail, created_at
              FROM cortex_asks
              WHERE status = 'pending' AND analysis_id = ANY($1::text[]) AND ($2::text IS NULL OR user_id = $2)
              ORDER BY created_at ASC, id ASC
              LIMIT $3`,
            values: [input.analysisIds, input.userId ?? null, Math.min(Math.max(input.limit, 1), MAX_PENDING_BY_ANALYSES)],
        });
        return result.rows.map(pendingAskOf);
    });
}

/**
 * The workflow that waits for the ask with this id. `null` for an unknown id or a row with no workflow.
 *
 * A row with no `workflow_id` comes from a process of an earlier release, for example an old pod in a rolling deploy.
 * Only a chat turn raised asks then, thus the active turn of the thread of the row is the workflow that waits.
 */
export function selectAskWorkflow(querier: Querier, id: string): ResultAsync<string | null, DbError> {
    return tryQuery("asks.selectAskWorkflow", async () => {
        const result = await querier.query({
            text: `SELECT COALESCE(asks.workflow_id, threads.active_turn_id) AS workflow_id
                     FROM cortex_asks asks
                     LEFT JOIN cortex_analysis_threads threads ON threads.thread_id = asks.thread_id
                    WHERE asks.id = $1`,
            values: [id],
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : AskWorkflowRowSchema.parse(row).workflow_id;
    });
}

/** The analysis and the person of the ask with this id, in each status. `null` for an unknown id. */
export function selectAskScope(querier: Querier, id: string): ResultAsync<AskScopeOfRow | null, DbError> {
    return tryQuery("asks.selectAskScope", async () => {
        const result = await querier.query({ text: `SELECT analysis_id, user_id FROM cortex_asks WHERE id = $1`, values: [id] });
        const row: unknown = result.rows[0];
        if (row === undefined) return null;
        const parsed = AskScopeRowSchema.parse(row);
        return { analysisId: parsed.analysis_id, userId: parsed.user_id };
    });
}

/**
 * Sweep `pending` rows created before `olderThan` to `expired`, returning the
 * count swept. The age predicate is what keeps a boot sweep from expiring an ask
 * another live pod is still polling — only rows old enough to be orphans of a
 * dead process are touched. Both bounds compare as text: every `created_at` is a
 * fixed-width UTC ISO string, so lexicographic order is chronological (the same
 * property `selectPending`'s ORDER BY relies on).
 */
export function sweepExpired(querier: Querier, expiredAt: string, olderThan: string): ResultAsync<number, DbError> {
    return tryMutation("asks.sweepExpired", async () => {
        const result = await querier.query({
            // The ask of a sandbox step waits until an answer comes, and the cancel of its run aborts it, thus no sweep expires it.
            text: `UPDATE cortex_asks SET status = 'expired', resolved_at = $1
              WHERE status = 'pending' AND created_at < $2 AND run_id IS NULL`,
            values: [expiredAt, olderThan],
        });
        return result.rowCount ?? 0;
    });
}

/** Mark each `pending` ask of the steps of a run `aborted`. The cancel of the run ended the waits of its steps. */
export function abortPendingAsksOfRun(querier: Querier, runId: string, resolvedAt: string): ResultAsync<number, DbError> {
    return tryMutation("asks.abortPendingOfRun", async () => {
        const result = await querier.query({
            text: `UPDATE cortex_asks SET status = 'aborted', resolved_at = $2 WHERE run_id = $1 AND status = 'pending'`,
            values: [runId, resolvedAt],
        });
        return result.rowCount ?? 0;
    });
}

/**
 * Record a decision against a still-`pending` row and, for an `always` reply,
 * write the standing grant — both in one transaction, so a crash between them can
 * never record an approval without the grant it promised.
 *
 * The guarded `UPDATE ... WHERE status = 'pending'` makes a duplicate/stale answer
 * a reported no-op: one row updated → `applied`; zero rows → a follow-up read
 * discriminates `already_terminal` (the row exists but left `pending`) from
 * `not_found` (no such id).
 */
export function answerAsk(pool: Pool, id: string, reply: AskReply, now: string): ResultAsync<AnswerOutcome, DbError> {
    const status: AskStatus = reply.kind === "reject" ? "rejected" : "resolved";
    return withTransaction(pool, "asks.answer", (client) =>
        tryMutation("asks.answer:update", () =>
            client.query({
                text: `UPDATE cortex_asks SET status = $1, reply = $2::jsonb, resolved_at = $3
                  WHERE id = $4 AND status = 'pending'
                  RETURNING analysis_id, COALESCE(user_id, '') AS user_id, COALESCE(grant_key, command) AS grant_key, grant_scope`,
                values: [status, JSON.stringify(reply), now, id],
            }),
        ).andThen((updated) => {
            if ((updated.rowCount ?? 0) === 0) return discriminateMiss(client, id);
            if (reply.kind !== "always") return okAsync<AnswerOutcome, DbError>("applied");
            // The COALESCEs make each key field non-null: each insert writes
            // grant_key (command when the tool supplied none) and user_id (empty
            // string when the row predates the column), so the row schema below can
            // demand the three key strings; a row that misses one is refused through the
            // transaction's `DbError` channel. A NULL grant_scope grants in the analysis.
            return tryMutation("asks.answer:grant", async () => {
                const granted = GrantedRowSchema.parse(updated.rows[0]);
                if (granted.grant_scope === "user") {
                    await client.query({
                        text: `INSERT INTO cortex_user_grants (user_id, grant_key, created_at)
                          VALUES ($1, $2, $3) ON CONFLICT (user_id, grant_key) DO NOTHING`,
                        values: [granted.user_id, granted.grant_key, now],
                    });
                    return;
                }
                await client.query({
                    text: `INSERT INTO cortex_ask_grants (analysis_id, user_id, grant_key, created_at)
                      VALUES ($1, $2, $3, $4) ON CONFLICT (analysis_id, user_id, grant_key) DO NOTHING`,
                    values: [granted.analysis_id, granted.user_id, granted.grant_key, now],
                });
            }).map<AnswerOutcome>(() => "applied");
        }),
    );
}

/** A zero-row `UPDATE` means the id is absent or already terminal — tell them apart. */
function discriminateMiss(client: TransactionQuerier, id: string): ResultAsync<AnswerOutcome, DbError> {
    return tryQuery<AnswerOutcome>("asks.answer:discriminate", async () => {
        const result = await client.query({ text: `SELECT 1 FROM cortex_asks WHERE id = $1`, values: [id] });
        return (result.rowCount ?? 0) > 0 ? "already_terminal" : "not_found";
    });
}
