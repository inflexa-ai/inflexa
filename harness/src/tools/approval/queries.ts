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
    readonly title: string;
    readonly command: string;
    readonly detail: string | null;
    readonly createdAt: string;
};

/** The status + recorded reply a poll reads to observe a decision. */
export type AskResolution = {
    readonly status: AskStatus;
    readonly reply: AskReply | null;
};

/** The reply column of `cortex_asks`: the JSONB the answer write stored. */
const AskReplySchema: z.ZodType<AskReply> = z.union([
    z.object({ kind: z.literal("once") }),
    z.object({ kind: z.literal("always") }),
    z.object({ kind: z.literal("reject"), feedback: z.string().optional() }),
]);

const AskResolutionRowSchema = z.object({ status: z.enum(["pending", "resolved", "rejected", "aborted", "expired"]), reply: AskReplySchema.nullable() });

/** The columns of the pending enumeration, as the SELECT spells them. */
const PendingAskRowSchema = z.object({
    id: z.string(),
    analysis_id: z.string(),
    user_id: z.string(),
    thread_id: z.string().nullable(),
    title: z.string(),
    command: z.string(),
    detail: z.string().nullable(),
    created_at: z.string(),
});

/** The columns the guarded UPDATE returns for the standing-grant insert. */
const GrantedRowSchema = z.object({ analysis_id: z.string(), user_id: z.string(), grant_key: z.string() });

function mapAskResolutionRow(row: unknown): AskResolution | null {
    if (row === null || row === undefined) return null;
    const parsed = AskResolutionRowSchema.parse(row);
    return { status: parsed.status, reply: parsed.reply ?? null };
}

/** Column payload shared by the pending insert and the grant short-circuit insert. */
export type AskRow = {
    readonly id: string;
    readonly analysisId: string;
    readonly userId: string;
    readonly threadId: string | null;
    readonly title: string;
    readonly command: string;
    readonly detail: string | null;
    /** Grant key an `always` keys its standing grant under; `null` falls back to `command`. */
    readonly grantKey: string | null;
    readonly createdAt: string;
};

/** Insert a fresh `pending` ask before its decision is awaited. */
export function insertPendingAsk(querier: Querier, row: AskRow): ResultAsync<void, DbError> {
    return tryMutation("asks.insertPending", async () => {
        await querier.query({
            text: `INSERT INTO cortex_asks
              (id, analysis_id, user_id, thread_id, title, command, detail, grant_key, status, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
            values: [row.id, row.analysisId, row.userId, row.threadId, row.title, row.command, row.detail, row.grantKey ?? row.command, row.createdAt],
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
              (id, analysis_id, user_id, thread_id, title, command, detail, grant_key, status, reply, created_at, resolved_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'resolved', $9::jsonb, $10, $11)`,
            values: [
                row.id,
                row.analysisId,
                row.userId,
                row.threadId,
                row.title,
                row.command,
                row.detail,
                row.grantKey ?? row.command,
                JSON.stringify({ kind: "always" }),
                row.createdAt,
                resolvedAt,
            ],
        });
    });
}

/** Does a standing grant cover `(analysisId, userId, grantKey)` for this person? */
export function selectGrant(querier: Querier, analysisId: string, userId: string, grantKey: string): ResultAsync<boolean, DbError> {
    return tryQuery("asks.selectGrant", async () => {
        const result = await querier.query({
            text: `SELECT 1 FROM cortex_ask_grants WHERE analysis_id = $1 AND user_id = $2 AND grant_key = $3`,
            values: [analysisId, userId, grantKey],
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
        const row = mapAskResolutionRow(result.rows[0]);
        if (!row) return null;
        return row;
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
            text: `SELECT id, analysis_id, COALESCE(user_id, '') AS user_id, thread_id, title, command, detail, created_at
              FROM cortex_asks WHERE status = 'pending' ORDER BY created_at ASC`,
        });
        return result.rows.map((row: unknown) => {
            const parsed = PendingAskRowSchema.parse(row);
            return {
                id: parsed.id,
                analysisId: parsed.analysis_id,
                userId: parsed.user_id,
                threadId: parsed.thread_id ?? null,
                title: parsed.title,
                command: parsed.command,
                detail: parsed.detail ?? null,
                createdAt: parsed.created_at,
            };
        });
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
            text: `UPDATE cortex_asks SET status = 'expired', resolved_at = $1
              WHERE status = 'pending' AND created_at < $2`,
            values: [expiredAt, olderThan],
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
                  RETURNING analysis_id, COALESCE(user_id, '') AS user_id, COALESCE(grant_key, command) AS grant_key`,
                values: [status, JSON.stringify(reply), now, id],
            }),
        ).andThen((updated) => {
            if ((updated.rowCount ?? 0) === 0) return discriminateMiss(client, id);
            if (reply.kind !== "always") return okAsync<AnswerOutcome, DbError>("applied");
            // The COALESCEs make every returned field non-null: each insert writes
            // grant_key (command when the tool supplied none) and user_id (empty
            // string when the row predates the column), so the row schema below can
            // demand all three strings; a row that misses one is refused through the
            // transaction's `DbError` channel.
            return tryMutation("asks.answer:grant", async () => {
                const granted = GrantedRowSchema.parse(updated.rows[0]);
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
