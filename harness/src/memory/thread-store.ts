/**
 * Conversation thread metadata store — the harness's owned `ThreadStore`.
 *
 * The analysis-scope, ownership, listing, and title that the harness
 * `messages` table (`thread-history.ts`) deliberately lacks. One row per
 * conversation thread in `cortex_analysis_threads`, keyed by the
 * UI-generated `thread_id` (a random UUID — an analysis has many threads).
 *
 * Scope (see the harness-thread-store spec): conversation threads only. Like `thread-history.ts`,
 * the vocabulary is conversation-shaped on purpose — reaching for it inside
 * a workflow step feels immediately wrong.
 *
 * Three lifecycle verbs with distinct guarantees. `archiveThread` is
 * recoverable: it stamps `deleted_at`, and because `getThread`/`listThreads`
 * filter `deleted_at IS NULL` an archived thread is indistinguishable from an
 * absent one while its row and every one of its `messages` rows stay in
 * storage. `unarchiveThread` clears the stamp and the thread reads as it did.
 * `deleteThread` is not recoverable: it removes the `messages` rows and the
 * metadata row in one transaction, so a failure partway leaves both — never a
 * thread stripped of its transcript, nor a transcript with nothing naming it.
 *
 * A hard delete creates no orphan of its own, but it is NOT serialized against
 * a concurrent `appendTurn`: `messages` carries no foreign key to
 * `cortex_analysis_threads`, and the append deliberately tolerates a missing
 * metadata row. A turn committing after the delete therefore persists messages
 * under a `thread_id` that no longer resolves to an analysis, leaving them
 * unreachable by any later thread- or analysis-scoped reclamation. Stop writes
 * to a thread — unbind it from any live conversation — before deleting it; this
 * store cannot observe a host's in-flight turns, so it does not enforce that.
 */

import { type ResultAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";

/** One conversation thread's metadata, as returned by the store. */
export interface Thread {
    readonly threadId: string;
    readonly analysisId: string;
    readonly title: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export interface CreateThreadInput {
    readonly threadId: string;
    readonly analysisId: string;
    readonly title?: string | null;
}

export interface ListThreadsInput {
    readonly analysisId: string;
    readonly page?: number;
    readonly perPage?: number;
}

export interface ThreadPage {
    readonly threads: Thread[];
    readonly total: number;
    readonly page: number;
    readonly perPage: number;
    readonly hasMore: boolean;
}

export interface ThreadStore {
    /**
     * Create a thread row. Idempotent on `thread_id` — a second create for an
     * existing id is a no-op that preserves the existing row (including its
     * `created_at`). Returns the live row.
     */
    createThread(input: CreateThreadInput): ResultAsync<Thread, DbError>;
    /** The live thread by id, or `null` if absent or archived. */
    getThread(threadId: string): ResultAsync<Thread | null, DbError>;
    /**
     * Set only the title, bumping `updated_at` forward — never behind the stamp
     * the row already carries. No-op on a missing/archived row.
     */
    updateTitle(threadId: string, title: string): ResultAsync<Thread | null, DbError>;
    /**
     * Soft-delete: stamp `deleted_at` so the thread leaves `getThread` and
     * `listThreads`. The row and every one of its messages remain, and an
     * already-archived thread keeps the stamp it got the first time.
     */
    archiveThread(threadId: string): ResultAsync<void, DbError>;
    /**
     * Clear `deleted_at`, returning the thread and its messages to view exactly
     * as they read before the archive. No-op on a live or absent thread.
     */
    unarchiveThread(threadId: string): ResultAsync<void, DbError>;
    /**
     * Hard delete: remove the thread's `messages` rows and its
     * `cortex_analysis_threads` row in one transaction. Unrecoverable — nothing
     * of the thread survives. A `thread_id` with no row succeeds as a no-op.
     */
    deleteThread(threadId: string): ResultAsync<void, DbError>;
    /** Live threads for one analysis, newest-updated first, paginated. */
    listThreads(input: ListThreadsInput): ResultAsync<ThreadPage, DbError>;
}

interface ThreadRow {
    readonly thread_id: string;
    readonly analysis_id: string;
    readonly title: string | null;
    readonly created_at: Date;
    readonly updated_at: Date;
}

function toThread(row: ThreadRow): Thread {
    return {
        threadId: row.thread_id,
        analysisId: row.analysis_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 200;

/**
 * Create a `ThreadStore` bound to a Postgres pool — a factory closure
 * capturing `pool` (dependency injection per the harness-durable-runtime spec). The
 * `cortex_analysis_threads` table is provisioned by the state-init DDL.
 */
export function createThreadStore(pool: Pool): ThreadStore {
    function createThread(input: CreateThreadInput): ResultAsync<Thread, DbError> {
        return tryMutation("thread-store.createThread.insert", () =>
            pool.query<ThreadRow>(
                `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (thread_id) DO NOTHING
         RETURNING thread_id, analysis_id, title, created_at, updated_at`,
                [input.threadId, input.analysisId, input.title ?? null],
            ),
        ).andThen(({ rows }) => {
            if (rows[0]) return okAsync<Thread, DbError>(toThread(rows[0]));
            // Row already existed — ON CONFLICT DO NOTHING returns nothing. Read it
            // back (it may be archived; return it regardless so the caller sees
            // the existing row's identity).
            return tryQuery("thread-store.createThread.readback", () =>
                pool.query<ThreadRow>(
                    `SELECT thread_id, analysis_id, title, created_at, updated_at
           FROM cortex_analysis_threads WHERE thread_id = $1`,
                    [input.threadId],
                ),
            ).map(({ rows: existing }) => toThread(existing[0]!));
        });
    }

    function getThread(threadId: string): ResultAsync<Thread | null, DbError> {
        return tryQuery("thread-store.getThread", () =>
            pool.query<ThreadRow>(
                `SELECT thread_id, analysis_id, title, created_at, updated_at
         FROM cortex_analysis_threads
         WHERE thread_id = $1 AND deleted_at IS NULL`,
                [threadId],
            ),
        ).map(({ rows }) => (rows[0] ? toThread(rows[0]) : null));
    }

    function updateTitle(threadId: string, title: string): ResultAsync<Thread | null, DbError> {
        return tryMutation("thread-store.updateTitle", () =>
            pool.query<ThreadRow>(
                // `updated_at` is the listing's activity clock, and a rename is not its
                // only writer — a turn append touches the same column, and a rename that
                // starts before one can still reach the row after it. Taking the LATER of
                // the two makes the bump forward-only, so a rename can never pull the
                // column back behind a stamp the row already carries, no matter which
                // writer set it or how long this statement waited to run. `NOW()` cannot
                // give that: it reads this transaction's START time, not the moment the
                // row is actually written.
                `UPDATE cortex_analysis_threads
         SET title = $2, updated_at = GREATEST(updated_at, clock_timestamp())
         WHERE thread_id = $1 AND deleted_at IS NULL
         RETURNING thread_id, analysis_id, title, created_at, updated_at`,
                [threadId, title],
            ),
        ).map(({ rows }) => (rows[0] ? toThread(rows[0]) : null));
    }

    function archiveThread(threadId: string): ResultAsync<void, DbError> {
        return tryMutation("thread-store.archiveThread", () =>
            pool.query(
                // The tombstone guard is what makes a second archive change nothing:
                // the stamp records when the thread left view, and re-stamping it
                // would push that moment forward on every repeat.
                `UPDATE cortex_analysis_threads
         SET deleted_at = NOW()
         WHERE thread_id = $1 AND deleted_at IS NULL`,
                [threadId],
            ),
        ).map(() => undefined);
    }

    function unarchiveThread(threadId: string): ResultAsync<void, DbError> {
        return tryMutation("thread-store.unarchiveThread", () =>
            pool.query(
                // `updated_at` is untouched on purpose: it orders the listing by
                // conversation activity, and restoring a thread to view is not
                // activity — a restored thread lands back where its last turn left it.
                `UPDATE cortex_analysis_threads
         SET deleted_at = NULL
         WHERE thread_id = $1 AND deleted_at IS NOT NULL`,
                [threadId],
            ),
        ).map(() => undefined);
    }

    function deleteThread(threadId: string): ResultAsync<void, DbError> {
        // One transaction for both statements: `messages` is attributable to an
        // analysis only by joining through `cortex_analysis_threads`, so a metadata
        // row removed without its messages strands them beyond the reach of any
        // later reclamation. Either the pair goes or neither does.
        return withTransaction(pool, "thread-store.deleteThread", (client) =>
            tryMutation("thread-store.deleteThread.messages", () => client.query("DELETE FROM messages WHERE thread_id = $1", [threadId]))
                .andThen(() =>
                    tryMutation("thread-store.deleteThread.thread", () => client.query("DELETE FROM cortex_analysis_threads WHERE thread_id = $1", [threadId])),
                )
                .map(() => undefined),
        );
    }

    function listThreads(input: ListThreadsInput): ResultAsync<ThreadPage, DbError> {
        const perPage = Math.min(Math.max(input.perPage ?? DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
        const page = Math.max(input.page ?? 0, 0);
        const offset = page * perPage;

        return tryQuery("thread-store.listThreads.count", () =>
            pool.query<{ count: string }>(
                `SELECT COUNT(*)::text AS count
         FROM cortex_analysis_threads
         WHERE analysis_id = $1 AND deleted_at IS NULL`,
                [input.analysisId],
            ),
        ).andThen((totalResult) => {
            const total = Number(totalResult.rows[0]!.count);
            return tryQuery("thread-store.listThreads.page", () =>
                pool.query<ThreadRow>(
                    `SELECT thread_id, analysis_id, title, created_at, updated_at
           FROM cortex_analysis_threads
           WHERE analysis_id = $1 AND deleted_at IS NULL
           ORDER BY updated_at DESC, thread_id
           LIMIT $2 OFFSET $3`,
                    [input.analysisId, perPage, offset],
                ),
            ).map(({ rows }) => ({
                threads: rows.map(toThread),
                total,
                page,
                perPage,
                hasMore: offset + rows.length < total,
            }));
        });
    }

    return { createThread, getThread, updateTitle, archiveThread, unarchiveThread, deleteThread, listThreads };
}
