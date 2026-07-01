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
 * Delete is soft: `deleteThread` sets `deleted_at`; `getThread` and
 * `listThreads` filter `deleted_at IS NULL`, so the row (and its messages)
 * survive a delete and a tombstoned thread is indistinguishable from absent.
 */

import { type ResultAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { type DbError, tryMutation, tryQuery } from "../lib/db-result.js";

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
    /** The live thread by id, or `null` if absent or soft-deleted. */
    getThread(threadId: string): ResultAsync<Thread | null, DbError>;
    /** Set only the title (and bump `updated_at`). No-op on a missing/deleted row. */
    updateTitle(threadId: string, title: string): ResultAsync<Thread | null, DbError>;
    /** Soft-delete: set `deleted_at`. The row and its messages remain. */
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
            // back (it may be soft-deleted; return it regardless so the caller sees
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
                `UPDATE cortex_analysis_threads
         SET title = $2, updated_at = NOW()
         WHERE thread_id = $1 AND deleted_at IS NULL
         RETURNING thread_id, analysis_id, title, created_at, updated_at`,
                [threadId, title],
            ),
        ).map(({ rows }) => (rows[0] ? toThread(rows[0]) : null));
    }

    function deleteThread(threadId: string): ResultAsync<void, DbError> {
        return tryMutation("thread-store.deleteThread", () =>
            pool.query(
                `UPDATE cortex_analysis_threads
         SET deleted_at = NOW()
         WHERE thread_id = $1 AND deleted_at IS NULL`,
                [threadId],
            ),
        ).map(() => undefined);
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

    return { createThread, getThread, updateTitle, deleteThread, listThreads };
}
