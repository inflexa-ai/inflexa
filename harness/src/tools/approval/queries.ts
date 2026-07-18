/**
 * Postgres data access for the tool-approval ledger (`cortex_asks`) and its
 * standing grants (`cortex_ask_grants`).
 *
 * Every operation returns `ResultAsync<T, DbError>` in the `state/` house style —
 * the `pg` throws are caught only inside `tryQuery`/`tryMutation`/`withTransaction`
 * (`lib/db-result.ts`); everything above flows `Result`. Absence rides the ok
 * channel (`ok(null)` / `ok(0)`), never an `err`. The gateway unwraps these at its
 * seam boundary.
 */

import { okAsync, type ResultAsync } from "neverthrow";
import type { Pool, PoolClient } from "pg";

import { tryMutation, tryQuery, withTransaction, type DbError } from "../../lib/db-result.js";
import type { AskReply } from "./contract.js";

type Querier = Pool | PoolClient;

/** The ask ledger's status machine — one `pending` state, four terminal ones. */
export type AskStatus = "pending" | "resolved" | "rejected" | "aborted" | "expired";

/** The discriminated outcome of an out-of-band `answer` against a ledger row. */
export type AnswerOutcome = "applied" | "not_found" | "already_terminal";

/** An unresolved ask, as enumerated by `pending()`. */
export interface PendingAsk {
    readonly id: string;
    readonly analysisId: string;
    readonly threadId: string | null;
    readonly title: string;
    readonly command: string;
    readonly detail: string | null;
    readonly createdAt: string;
}

/** The status + recorded reply a poll reads to observe a decision. */
export interface AskResolution {
    readonly status: AskStatus;
    readonly reply: AskReply | null;
}

/** Column payload shared by the pending insert and the grant short-circuit insert. */
export interface AskRow {
    readonly id: string;
    readonly analysisId: string;
    readonly threadId: string | null;
    readonly title: string;
    readonly command: string;
    readonly detail: string | null;
    readonly createdAt: string;
}

/** Insert a fresh `pending` ask before its decision is awaited. */
export function insertPendingAsk(querier: Querier, row: AskRow): ResultAsync<void, DbError> {
    return tryMutation("asks.insertPending", async () => {
        await querier.query({
            text: `INSERT INTO cortex_asks
              (id, analysis_id, thread_id, title, command, detail, status, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
            values: [row.id, row.analysisId, row.threadId, row.title, row.command, row.detail, row.createdAt],
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
              (id, analysis_id, thread_id, title, command, detail, status, reply, created_at, resolved_at)
              VALUES ($1, $2, $3, $4, $5, $6, 'resolved', $7::jsonb, $8, $9)`,
            values: [row.id, row.analysisId, row.threadId, row.title, row.command, row.detail, JSON.stringify({ kind: "always" }), row.createdAt, resolvedAt],
        });
    });
}

/** Does a standing grant cover `(analysisId, command)` in this analysis? */
export function selectGrant(querier: Querier, analysisId: string, command: string): ResultAsync<boolean, DbError> {
    return tryQuery("asks.selectGrant", async () => {
        const result = await querier.query({
            text: `SELECT 1 FROM cortex_ask_grants WHERE analysis_id = $1 AND command = $2`,
            values: [analysisId, command],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/** Read a row's current status + recorded reply. `null` when no such row exists. */
export function selectAskResolution(querier: Querier, id: string): ResultAsync<AskResolution | null, DbError> {
    return tryQuery("asks.selectResolution", async () => {
        const result = await querier.query({
            text: `SELECT status, reply FROM cortex_asks WHERE id = $1`,
            values: [id],
        });
        const row = result.rows[0] as { status: AskStatus; reply: AskReply | null } | undefined;
        if (!row) return null;
        return { status: row.status, reply: row.reply ?? null };
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
            text: `SELECT id, analysis_id, thread_id, title, command, detail, created_at
              FROM cortex_asks WHERE status = 'pending' ORDER BY created_at ASC`,
        });
        return result.rows.map((row: Record<string, unknown>) => ({
            id: row.id as string,
            analysisId: row.analysis_id as string,
            threadId: (row.thread_id as string | null) ?? null,
            title: row.title as string,
            command: row.command as string,
            detail: (row.detail as string | null) ?? null,
            createdAt: row.created_at as string,
        }));
    });
}

/** Sweep every `pending` row to `expired`, returning the count swept. */
export function sweepExpired(querier: Querier, expiredAt: string): ResultAsync<number, DbError> {
    return tryMutation("asks.sweepExpired", async () => {
        const result = await querier.query({
            text: `UPDATE cortex_asks SET status = 'expired', resolved_at = $1 WHERE status = 'pending'`,
            values: [expiredAt],
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
                  RETURNING analysis_id, command`,
                values: [status, JSON.stringify(reply), now, id],
            }),
        ).andThen((updated) => {
            if ((updated.rowCount ?? 0) === 0) return discriminateMiss(client, id);
            if (reply.kind !== "always") return okAsync<AnswerOutcome, DbError>("applied");
            const granted = updated.rows[0] as { analysis_id: string; command: string };
            return tryMutation("asks.answer:grant", async () => {
                await client.query({
                    text: `INSERT INTO cortex_ask_grants (analysis_id, command, created_at)
                      VALUES ($1, $2, $3) ON CONFLICT (analysis_id, command) DO NOTHING`,
                    values: [granted.analysis_id, granted.command, now],
                });
            }).map<AnswerOutcome>(() => "applied");
        }),
    );
}

/** A zero-row `UPDATE` means the id is absent or already terminal — tell them apart. */
function discriminateMiss(client: PoolClient, id: string): ResultAsync<AnswerOutcome, DbError> {
    return tryQuery<AnswerOutcome>("asks.answer:discriminate", async () => {
        const result = await client.query({ text: `SELECT 1 FROM cortex_asks WHERE id = $1`, values: [id] });
        return (result.rowCount ?? 0) > 0 ? "already_terminal" : "not_found";
    });
}
