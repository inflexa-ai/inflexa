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
 * A thread may name another as its parent, so the rows under one analysis form
 * a forest rather than a flat list. The three lifecycle verbs each answer that
 * edge differently, and the differences are the substance of this module.
 *
 * `archiveThread` is recoverable: it stamps `deleted_at` on the named thread
 * and on every descendant, and because `getThread` and the default
 * `listThreads` filter `deleted_at IS NULL` an archived thread is
 * indistinguishable from an absent one while its row and every one of its
 * `messages` rows stay in storage. `unarchiveThread` clears the stamp on ONE
 * row and the thread reads as it did; a listing widened with `includeArchived`
 * is the only way to obtain the id it takes, so the recovery is reachable by a
 * host that holds no thread ids it obtained elsewhere.
 * `purgeThread` is not recoverable: it removes the `messages` rows, the report
 * session-state rows, and the metadata rows of the whole subtree in one
 * transaction, so a failure partway leaves them all — never a thread stripped of
 * its transcript, nor a transcript with nothing naming it. It is the thread-scoped member of this package's
 * reclamation vocabulary — `purgeAnalysis` reclaims an analysis's whole
 * persisted footprint, `purgeThread` one subtree's.
 *
 * The directory of a report session takes the name of its thread id. Thus
 * `purgeThread` gives back the ids that it erased, because a host that reclaims
 * those directories has no other source for the set.
 *
 * A purge creates no orphan of its own, but it is NOT serialized against a
 * concurrent `appendTurn`: `messages` carries no foreign key to
 * `cortex_analysis_threads`, and the append deliberately tolerates a missing
 * metadata row. A turn committing after the purge therefore persists messages
 * under a `thread_id` that no longer resolves to an analysis, leaving them
 * unreachable by any later thread- or analysis-scoped reclamation. Stop writes
 * to every thread in the subtree — unbind each from any live conversation —
 * before purging its root; this store cannot observe a host's in-flight turns,
 * so it does not enforce that.
 */

import { type ResultAsync, errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";
import type { DomainError } from "../lib/result.js";

/**
 * The kind of session a thread holds. `conversation` is the analysis
 * conversation the product has always had; `report` is a report session spawned
 * from one.
 *
 * The set is closed rather than free-form because a thread's type is what
 * selects the agent that runs it. That resolution is a separate capability, and
 * it can only be exhaustive over a membership something can enumerate — a
 * free-form column pushes an unmatched value into a fallback no reader has the
 * list to write.
 *
 * The array is the single declaration and the union is derived from it, so the
 * run-time check `createThread` needs — for a value that reached the store from
 * outside the compiler's reach — cannot drift from the type callers program
 * against.
 */
const THREAD_TYPES = ["conversation", "report"] as const;

export type ThreadType = (typeof THREAD_TYPES)[number];

function isThreadType(value: string): value is ThreadType {
    return THREAD_TYPES.some((known) => known === value);
}

/** One conversation thread's metadata, as returned by the store. */
export interface Thread {
    readonly threadId: string;
    readonly analysisId: string;
    readonly title: string | null;
    /** Which kind of session this row holds. A thread created without one is a `conversation`. */
    readonly threadType: ThreadType;
    /** The thread this one was spawned from — `null` on a thread that stands on its own. */
    readonly parentThreadId: string | null;
    /**
     * The parent's `messages.seq` at the moment of the spawn: the frozen point
     * in the parent's transcript this thread was built on. `null` exactly when
     * `parentThreadId` is — half the pair names nothing a consumer can resolve.
     *
     * It records the spawn point, not a promise that the prefix still reads the
     * same: `retractLastTurn` can cut the parent's tail behind an anchor, so a
     * reader must treat an anchor past the parent's current end as a normal
     * state rather than a corruption.
     */
    readonly parentSeq: number | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    /**
     * The archive tombstone — `null` on a live thread, the moment it left view
     * on an archived one. Required rather than optional: a row is always one or
     * the other, so a caller listing archived threads has no `undefined` case to
     * fall through and render a tombstoned conversation as live.
     */
    readonly deletedAt: Date | null;
}

export interface CreateThreadInput {
    readonly threadId: string;
    readonly analysisId: string;
    readonly title?: string | null;
    /** Omitted is `conversation` — what a thread is when nothing says otherwise. */
    readonly type?: ThreadType;
    /**
     * The thread this one is spawned from. It must belong to the same analysis
     * as the child; whether it exists at all is the foreign key's verdict, not
     * this store's.
     */
    readonly parentThreadId?: string;
    /**
     * The parent's `messages.seq` at the spawn. Supply it with `parentThreadId`
     * or neither: the two are one fact — which transcript, and how much of it —
     * and either half alone describes no place.
     */
    readonly parentSeq?: number;
}

/**
 * A create the store refuses on its own, before any row is written. Distinct
 * from `DbError`: nothing failed at the driver — the request described a thread
 * the store will not write, and each variant carries the identifiers that say
 * which values disagreed.
 *
 * Only the rules the store enforces itself live here. A `parentThreadId` naming
 * no row is not one of them: the foreign key refuses that insert and
 * `tryMutation` classifies the refusal as the `constraint_violation` variant of
 * `DbError`.
 */
export type ThreadInputError =
    | {
          readonly type: "parent_analysis_mismatch";
          readonly op: string;
          readonly threadId: string;
          readonly analysisId: string;
          readonly parentThreadId: string;
          readonly parentAnalysisId: string;
      }
    | {
          readonly type: "parent_anchor_unpaired";
          readonly op: string;
          readonly threadId: string;
          readonly parentThreadId: string | null;
          readonly parentSeq: number | null;
      }
    | {
          readonly type: "unknown_thread_type";
          readonly op: string;
          readonly threadId: string;
          readonly threadType: string;
      };

// ThreadInputError is a `DomainError` (string `type`) — the compile-time check
// keeps it inside the cross-subsystem error vocabulary.
type _AssertDomainError = ThreadInputError extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

export interface ListThreadsInput {
    readonly analysisId: string;
    readonly page?: number;
    readonly perPage?: number;
    /**
     * Widen the listing to archived threads alongside live ones. It widens, it
     * does not switch: a caller wanting only the archived rows filters the
     * result on `deletedAt`, which an archived-only listing could not be
     * widened back out of.
     */
    readonly includeArchived?: boolean;
    /**
     * Narrow to one kind of session, exact match. Omitting it narrows NOTHING —
     * a caller that supplies no filter receives every type, which is what a
     * session picker wants: a user browsing an analysis expects to reach a
     * report session directly.
     *
     * That is the opposite polarity to `includeArchived`, which widens a listing
     * that is narrow by default, and the difference is deliberate. An archived
     * thread is hidden state — showing it takes an explicit ask. A report
     * session is not hidden state, so nothing has to ask for it.
     */
    readonly type?: ThreadType;
    /** Narrow to one thread's direct children, exact match. Same polarity as `type`: omitting it narrows nothing. */
    readonly parentThreadId?: string;
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
     * `created_at`) and reads none of the supplied type, parent, or anchor. A
     * caller that needs those persisted compares them against the returned row.
     * Returns the live row.
     *
     * Refused with a `ThreadInputError`, no row written: a parent belonging to
     * another analysis, a parent supplied without its anchor or an anchor
     * without its parent, and a type outside the closed set. A parent naming no
     * row is the foreign key's refusal and arrives as a `DbError`.
     */
    createThread(input: CreateThreadInput): ResultAsync<Thread, DbError | ThreadInputError>;
    /** The live thread by id, or `null` if absent or archived. */
    getThread(threadId: string): ResultAsync<Thread | null, DbError>;
    /**
     * Set only the title, bumping `updated_at` forward — never behind the stamp
     * the row already carries. No-op on a missing/archived row.
     */
    updateTitle(threadId: string, title: string): ResultAsync<Thread | null, DbError>;
    /**
     * Soft-delete the subtree: stamp `deleted_at` on the named thread and on
     * every descendant reachable through `parent_thread_id`, at any depth, so a
     * hidden thread never leaves a visible child behind. Every row and every one
     * of their messages remain, and any thread in the subtree that was already
     * archived keeps the stamp it got the first time.
     */
    archiveThread(threadId: string): ResultAsync<void, DbError>;
    /**
     * Clear `deleted_at` on the named thread ALONE, returning it and its
     * messages to view exactly as they read before the archive; every descendant
     * is left as it was found. No-op on a live or absent thread.
     *
     * The asymmetry against `archiveThread` is what keeps the schema honest. A
     * symmetric cascade would restore a child the user had archived on its own
     * beforehand, so a row would have to record whether a cascade or a
     * deliberate action set its tombstone — a fourth column carrying nothing
     * else. With the asymmetry no row needs that distinction, and every archived
     * thread is recovered the same way: by naming it, which a listing widened
     * with `includeArchived` supplies.
     */
    unarchiveThread(threadId: string): ResultAsync<void, DbError>;
    /**
     * Reclaim the subtree's whole footprint: the named thread, every descendant
     * reachable through `parent_thread_id` at any depth, and the `messages` rows
     * of every one of them, removed together in one transaction. Unrecoverable —
     * nothing survives, and no tombstone marks that any of it existed. A
     * `thread_id` with no row succeeds as a no-op.
     *
     * The value holds the id of each thread that the purge erased, the named one
     * and every descendant, in no promised order. A purge that erases nothing
     * gives back an empty array. The directory of a report session takes the
     * name of its thread id, thus a host that reclaims those directories has no
     * other source for the set that went.
     */
    purgeThread(threadId: string): ResultAsync<readonly string[], DbError>;
    /**
     * Threads for one analysis, newest-updated first, paginated. Live threads
     * only unless `includeArchived` widens the set, and every type under every
     * parent unless `type` / `parentThreadId` narrow it; `total` and `hasMore`
     * always describe whichever set the page was drawn from.
     */
    listThreads(input: ListThreadsInput): ResultAsync<ThreadPage, DbError>;
}

interface ThreadRow {
    readonly thread_id: string;
    readonly analysis_id: string;
    readonly title: string | null;
    /**
     * The column is plain text with a default; the narrower type here is honest
     * for every row this store wrote, because `createThread` checks the value
     * against the closed set before the insert.
     */
    readonly thread_type: ThreadType;
    readonly parent_thread_id: string | null;
    /**
     * Text, not a number: the anchor is a bigint, which the driver hands back as
     * a string so a value past 2^53 crosses the wire intact. Every read projects
     * it `::text`, so the shape here does not depend on how the pool's type
     * parsers happen to be configured, and `toThread` is the single place it
     * becomes the `number` the public value carries.
     */
    readonly parent_seq: string | null;
    readonly created_at: Date;
    readonly updated_at: Date;
    readonly deleted_at: Date | null;
}

/**
 * The projection every read of a thread row shares. Fixed text, never caller
 * input, and written once so no statement can return a row that is short a
 * column `toThread` reads — a gap that would surface as an `undefined` field on
 * a `Thread`, not as a failure.
 */
const THREAD_COLUMNS = "thread_id, analysis_id, title, thread_type, parent_thread_id, parent_seq::text AS parent_seq, created_at, updated_at, deleted_at";

/**
 * The named thread plus every descendant reachable through `parent_thread_id`,
 * at any depth. Fixed text taking the thread id as `$1`, and the single
 * definition the subtree statements share, so archive and purge cannot come to
 * walk to different depths.
 *
 * `UNION`, not `UNION ALL`: deduplicating against the rows already collected
 * makes the walk terminate even if a row ever came to name an ancestor as its
 * parent — a shape no write path here produces, and one the column does not
 * forbid either.
 */
const SUBTREE_CTE = `WITH RECURSIVE subtree(thread_id) AS (
     SELECT thread_id FROM cortex_analysis_threads WHERE thread_id = $1
     UNION
     SELECT child.thread_id
       FROM cortex_analysis_threads child
       JOIN subtree ON child.parent_thread_id = subtree.thread_id
   )`;

function toThread(row: ThreadRow): Thread {
    return {
        threadId: row.thread_id,
        analysisId: row.analysis_id,
        title: row.title,
        threadType: row.thread_type,
        parentThreadId: row.parent_thread_id,
        parentSeq: row.parent_seq === null ? null : Number(row.parent_seq),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
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
    /**
     * The parent's own analysis scope, or `null` when no such row exists.
     *
     * Absence is deliberately not a verdict here: a `parentThreadId` naming no
     * row falls through to the insert, where the foreign key refuses it and
     * `tryMutation` classifies that refusal as the `constraint_violation`
     * variant of `DbError`. Pre-empting the constraint with an existence query
     * would buy a round trip and a window between the check and the insert in
     * which the parent could vanish, for a verdict the constraint already
     * reaches on its own.
     *
     * The lookup does not filter `deleted_at IS NULL`: an archived parent is a
     * real row holding a real transcript, so a child anchored into it is
     * describing something that exists.
     */
    function parentAnalysisOf(parentThreadId: string): ResultAsync<string | null, DbError> {
        return tryQuery("thread-store.createThread.parentScope", () =>
            pool.query<{ analysis_id: string }>("SELECT analysis_id FROM cortex_analysis_threads WHERE thread_id = $1", [parentThreadId]),
        ).map(({ rows }) => rows[0]?.analysis_id ?? null);
    }

    /**
     * The write itself, past the rules the store enforces before it.
     *
     * Idempotency wins over everything the caller supplied: `ON CONFLICT
     * (thread_id) DO NOTHING` short-circuits before any constraint is evaluated
     * and reads no supplied parent, so a repeat create returns the existing row
     * unchanged — even one naming a parent that does not exist. A caller that
     * needs its type, parent, or anchor persisted compares them against the
     * returned row.
     */
    function insertThread(input: CreateThreadInput): ResultAsync<Thread, DbError> {
        return tryMutation("thread-store.createThread.insert", () =>
            pool.query<ThreadRow>(
                `INSERT INTO cortex_analysis_threads (thread_id, analysis_id, title, thread_type, parent_thread_id, parent_seq)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (thread_id) DO NOTHING
         RETURNING ${THREAD_COLUMNS}`,
                [input.threadId, input.analysisId, input.title ?? null, input.type ?? "conversation", input.parentThreadId ?? null, input.parentSeq ?? null],
            ),
        ).andThen(({ rows }) => {
            if (rows[0]) return okAsync<Thread, DbError>(toThread(rows[0]));
            // Row already existed — ON CONFLICT DO NOTHING returns nothing. Read it
            // back (it may be archived; return it regardless so the caller sees
            // the existing row's identity).
            return tryQuery("thread-store.createThread.readback", () =>
                pool.query<ThreadRow>(`SELECT ${THREAD_COLUMNS} FROM cortex_analysis_threads WHERE thread_id = $1`, [input.threadId]),
            ).map(({ rows: existing }) => toThread(existing[0]!));
        });
    }

    function createThread(input: CreateThreadInput): ResultAsync<Thread, DbError | ThreadInputError> {
        // Widened on purpose: the compile-time union covers a caller inside this
        // package's type graph, and this check is for the value that reached the
        // store from outside it — across a package boundary, out of a JSON body,
        // off a row some other writer put there.
        const requestedType: string | undefined = input.type;
        if (requestedType !== undefined && !isThreadType(requestedType)) {
            return errAsync({
                type: "unknown_thread_type",
                op: "thread-store.createThread",
                threadId: input.threadId,
                threadType: requestedType,
            });
        }

        const parentThreadId = input.parentThreadId ?? null;
        const parentSeq = input.parentSeq ?? null;
        // Both halves of the edge or neither: the anchor is the point in the
        // parent's transcript this thread was spawned from, and an edge without
        // one leaves a consumer no way to tell which prefix of the parent the
        // child stands on. Every rule below is gated on a value being supplied,
        // so a create that names neither reaches none of them and takes the same
        // path a first-turn conversation has always taken.
        if ((parentThreadId === null) !== (parentSeq === null)) {
            return errAsync({
                type: "parent_anchor_unpaired",
                op: "thread-store.createThread",
                threadId: input.threadId,
                parentThreadId,
                parentSeq,
            });
        }

        if (parentThreadId === null) return insertThread(input);

        // A data-integrity rule, not an authorization one: it keeps a parent edge
        // inside a single analysis, so a subtree walk can never cross into
        // another analysis's rows. The store never compares a caller's request
        // scope against a row.
        return parentAnalysisOf(parentThreadId).andThen((parentAnalysisId): ResultAsync<Thread, DbError | ThreadInputError> => {
            if (parentAnalysisId !== null && parentAnalysisId !== input.analysisId) {
                return errAsync({
                    type: "parent_analysis_mismatch",
                    op: "thread-store.createThread",
                    threadId: input.threadId,
                    analysisId: input.analysisId,
                    parentThreadId,
                    parentAnalysisId,
                });
            }
            return insertThread(input);
        });
    }

    function getThread(threadId: string): ResultAsync<Thread | null, DbError> {
        return tryQuery("thread-store.getThread", () =>
            pool.query<ThreadRow>(
                `SELECT ${THREAD_COLUMNS}
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
         RETURNING ${THREAD_COLUMNS}`,
                [threadId, title],
            ),
        ).map(({ rows }) => (rows[0] ? toThread(rows[0]) : null));
    }

    function archiveThread(threadId: string): ResultAsync<void, DbError> {
        return tryMutation("thread-store.archiveThread", () =>
            pool.query(
                // The stamp reaches the whole subtree because a hidden thread must
                // not leave a visible child behind — and to any depth, since the
                // column permits a grandchild and a one-level sweep would leave one
                // listed under a parent the user can no longer see.
                //
                // The tombstone guard is what makes a second archive change nothing:
                // the stamp records when a thread left view, and re-stamping it would
                // push that moment forward on every repeat. It sits on the UPDATE and
                // not on the walk, because a walk that stopped at an already-archived
                // child would never reach the live grandchild underneath it.
                //
                // `NOW()` is the transaction's clock, so every row this sweep reaches
                // carries the same stamp — one archive action reads back as one moment.
                //
                // `updated_at` is untouched, for the reason `unarchiveThread` carries:
                // it orders the listing by conversation activity, and moving a thread
                // out of view is not activity.
                `${SUBTREE_CTE}
         UPDATE cortex_analysis_threads
         SET deleted_at = NOW()
         WHERE thread_id IN (SELECT thread_id FROM subtree) AND deleted_at IS NULL`,
                [threadId],
            ),
        ).map(() => undefined);
    }

    function unarchiveThread(threadId: string): ResultAsync<void, DbError> {
        return tryMutation("thread-store.unarchiveThread", () =>
            pool.query(
                // One row, against an archive that sweeps the subtree. The asymmetry
                // is what keeps the schema honest: a symmetric cascade would restore
                // a child the user had archived on its own before the parent was, so
                // a row would have to record whether a cascade or a deliberate action
                // set its tombstone — a fourth column carrying nothing else. With the
                // asymmetry no row carries that distinction, and every archived
                // thread is recovered the same way, by naming it.
                //
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

    function purgeThread(threadId: string): ResultAsync<readonly string[], DbError> {
        // One transaction for every statement: `messages` is attributable to an
        // analysis only by joining through `cortex_analysis_threads`, so a metadata
        // row removed without its messages strands them beyond the reach of any
        // later reclamation. Either the whole set goes or none of it does.
        //
        // The explicit message delete must reach the same depth the database
        // cascade reaches. The cascade on `parent_thread_id` removes a
        // descendant's row recursively, but it cannot touch that descendant's
        // `messages` — no foreign key connects them — so a one-level delete here
        // would strand a grandchild's transcript exactly as a bare cascade strands
        // a child's.
        //
        // The session state of a report thread goes the same way, and for the same
        // reason: `cortex_report_session_state` carries no foreign key to
        // `cortex_analysis_threads` either, so the cascade cannot reach it. Its row
        // holds a whole draft document, and a purged thread can never be composed
        // again, so a row left behind is dead weight until the analysis purge runs.
        //
        // Messages go first, and the thread rows go last: the walk every statement
        // shares reads the very rows the last one removes. Thus a thread delete before
        // the others leaves the subtree unresolvable before a later statement names its
        // transcripts and its drafts.
        //
        // The last statement names the exact set of erased threads through the
        // same walk, thus `RETURNING` is the whole source of the ids. A separate
        // read cannot supply them: before the delete it costs a round trip on a
        // set that can still change, and after it the rows are gone.
        return withTransaction(pool, "thread-store.purgeThread", (client) =>
            tryMutation("thread-store.purgeThread.messages", () =>
                client.query(
                    `${SUBTREE_CTE}
         DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM subtree)`,
                    [threadId],
                ),
            )
                .andThen(() =>
                    tryMutation("thread-store.purgeThread.reportSessionState", () =>
                        client.query(
                            `${SUBTREE_CTE}
         DELETE FROM cortex_report_session_state WHERE thread_id IN (SELECT thread_id FROM subtree)`,
                            [threadId],
                        ),
                    ),
                )
                .andThen(() =>
                    tryMutation("thread-store.purgeThread.thread", () =>
                        client.query<{ thread_id: string }>(
                            `${SUBTREE_CTE}
         DELETE FROM cortex_analysis_threads WHERE thread_id IN (SELECT thread_id FROM subtree)
         RETURNING thread_id`,
                            [threadId],
                        ),
                    ),
                )
                .map(({ rows }) => rows.map((row) => row.thread_id)),
        );
    }

    function listThreads(input: ListThreadsInput): ResultAsync<ThreadPage, DbError> {
        const perPage = Math.min(Math.max(input.perPage ?? DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
        const page = Math.max(input.page ?? 0, 0);
        const offset = page * perPage;
        // The count and the page are two statements over what has to be one set:
        // a total drawn from a different predicate than the page's would report a
        // size the caller can never page to. Building the row scope once — the
        // fragment AND the values it binds — makes them unable to disagree. Every
        // predicate is fixed text and every value rides as a bound parameter, so
        // no caller string ever reaches the SQL.
        //
        // The widened scope is the one that cannot use the `analysis_id` index,
        // which is partial on `deleted_at IS NULL`: dropping the predicate drops
        // the index with it, so an archived-inclusive listing scans. Deliberate —
        // the live listing is the hot path and keeps its index, while widening is a
        // rare, user-initiated recovery. A deployment that made it routine would
        // want a plain `analysis_id` index beside the partial one, not this listing
        // changed. A listing narrowed by parent is indexed either way: the
        // `parent_thread_id` index carries no predicate, for the subtree walk's sake.
        const scopeValues: unknown[] = [input.analysisId];
        const predicates = ["analysis_id = $1"];
        if (!input.includeArchived) predicates.push("deleted_at IS NULL");
        if (input.type !== undefined) {
            scopeValues.push(input.type);
            predicates.push(`thread_type = $${scopeValues.length}`);
        }
        if (input.parentThreadId !== undefined) {
            scopeValues.push(input.parentThreadId);
            predicates.push(`parent_thread_id = $${scopeValues.length}`);
        }
        const scope = predicates.join(" AND ");
        // The page's two extra placeholders sit past the scope's, so a filter
        // added to the scope shifts them rather than colliding with them.
        const limitPlaceholder = scopeValues.length + 1;
        const offsetPlaceholder = scopeValues.length + 2;

        return tryQuery("thread-store.listThreads.count", () =>
            pool.query<{ count: string }>(
                `SELECT COUNT(*)::text AS count
         FROM cortex_analysis_threads
         WHERE ${scope}`,
                scopeValues,
            ),
        ).andThen((totalResult) => {
            const total = Number(totalResult.rows[0]!.count);
            return tryQuery("thread-store.listThreads.page", () =>
                pool.query<ThreadRow>(
                    `SELECT ${THREAD_COLUMNS}
           FROM cortex_analysis_threads
           WHERE ${scope}
           ORDER BY updated_at DESC, thread_id
           LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`,
                    [...scopeValues, perPage, offset],
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

    return { createThread, getThread, updateTitle, archiveThread, unarchiveThread, purgeThread, listThreads };
}
