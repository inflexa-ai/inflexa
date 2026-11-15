/**
 * The statements of `cortex_message_ids`, the table that maps `(thread_id, message_id)` to the `seq` of the first row
 * that holds the display message with that id. A read finds the row of one message through its primary key, and does
 * not scan the envelopes of the thread.
 */

import { ResultAsync, err, errAsync, ok, okAsync } from "neverthrow";

import { type Connectable, type DbError, type Querier, type TransactionQuerier, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";

/**
 * The ids of the display messages of one envelope, one row each. The write path and the backfill extract the ids
 * with this one rule. A `messages` value that is not an array gives no id, so a malformed older envelope cannot
 * fail a statement. An element with no string id gives `NULL`, and the filter drops it.
 */
export function messageIdsOfEnvelopeSql(envelope: string): string {
    return `SELECT element ->> 'id'
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${envelope} -> 'messages') = 'array' THEN ${envelope} -> 'messages' ELSE '[]'::jsonb END) AS element
             WHERE element ->> 'id' IS NOT NULL`;
}

/**
 * Record the ids of the display messages of one group, at the `seq` of its first row. `displayEnvelope` is the
 * serialized envelope that the row insert sends. A record that exists keeps its `seq`: the rounds of one message are
 * groups of one turn, and the first group is the one that the read starts from. `DO NOTHING` also covers an id that
 * the envelope repeats.
 */
export function recordMessageIds(client: TransactionQuerier, threadId: string, seq: number, displayEnvelope: string, op: string): ResultAsync<void, DbError> {
    return tryMutation(`${op}.recordMessageIds`, () =>
        client.query(
            `INSERT INTO cortex_message_ids (thread_id, message_id, seq)
             SELECT $1::text, ids.message_id, $2::bigint FROM (${messageIdsOfEnvelopeSql("$3::jsonb")}) AS ids(message_id)
             ON CONFLICT (thread_id, message_id) DO NOTHING`,
            [threadId, seq, displayEnvelope],
        ),
    ).map(() => undefined);
}

/**
 * Wait for a backfill batch that runs. A batch locks the state row `FOR UPDATE`, and this takes `FOR SHARE`, so a
 * delete of `messages` rows and a batch never overlap. Without the wait, a batch that read a row before the delete
 * can commit a record of the deleted row after the delete removed its records. Call it as the first statement of the
 * transaction of each delete site, after the advisory lock of a thread when the site takes one. The order of the
 * deletes of the `messages` rows and of the records is then free. After the backfill completes, the `WHERE` matches
 * no row and no lock is taken.
 */
export function waitForMessageIdBackfill(client: TransactionQuerier, op: string): ResultAsync<void, DbError> {
    return tryQuery(`${op}.waitForMessageIdBackfill`, () => client.query("SELECT 1 FROM cortex_message_id_backfill WHERE completed_at IS NULL FOR SHARE")).map(
        () => undefined,
    );
}

export type MessageIdBackfillOptions = {
    /** The most `messages` rows that one batch reads. A value that is not a positive integer reads as the default of 1,000. */
    readonly batchSize?: number;
};

export type MessageIdBackfillOutcome = {
    /** The count of the `messages` rows that the call read. */
    readonly rows: number;
    /** The count of the ids that the call recorded. An id that was recorded already is not counted. */
    readonly ids: number;
};

const DEFAULT_BATCH_SIZE = 1000;

/** The smallest `bigint`, below every `seq`. */
const MIN_SEQ = "'-9223372036854775808'::bigint";

/**
 * One batch: the rows after the cursor in the order of `(thread_id, seq)`, the records of their ids, and the key of the
 * last row. The row comparison is an index condition on `messages_pkey`. The ids of one batch are inserted in the order
 * of the rows, so the first row that holds an id gives its record. `$1` and `$2` are the cursor, and `$3` is the batch size.
 */
const BATCH_SQL = `WITH batch AS (
           SELECT messages.thread_id, messages.seq, messages.display_envelope FROM messages
            WHERE (messages.thread_id, messages.seq) > (COALESCE($1::text, ''), COALESCE($2::bigint, ${MIN_SEQ}))
            ORDER BY messages.thread_id, messages.seq
            LIMIT $3::bigint
         ),
         recorded AS (
           INSERT INTO cortex_message_ids (thread_id, message_id, seq)
           SELECT batch.thread_id, ids.message_id, batch.seq
             FROM batch CROSS JOIN LATERAL (${messageIdsOfEnvelopeSql("batch.display_envelope")}) AS ids(message_id)
            ORDER BY batch.thread_id, batch.seq
           ON CONFLICT (thread_id, message_id) DO NOTHING
           RETURNING 1
         )
         SELECT (SELECT count(*) FROM batch)::int AS rows,
                (SELECT count(*) FROM recorded)::int AS ids,
                (SELECT batch.thread_id FROM batch ORDER BY batch.thread_id DESC, batch.seq DESC LIMIT 1) AS last_thread_id,
                (SELECT batch.seq::text FROM batch ORDER BY batch.thread_id DESC, batch.seq DESC LIMIT 1) AS last_seq`;

type BatchRow = { rows: number; ids: number; last_thread_id: string | null; last_seq: string | null };

type BatchOutcome = MessageIdBackfillOutcome & { readonly done: boolean };

const NOTHING_LEFT: BatchOutcome = { rows: 0, ids: 0, done: true };

function readBatch(pool: Connectable, batchSize: number): ResultAsync<BatchOutcome, DbError> {
    const op = "message-ids.backfill";
    return withTransaction(pool, op, (client) =>
        // The row lock serializes two concurrent calls, and a delete of `messages` rows waits for it (see waitForMessageIdBackfill).
        tryQuery(`${op}.readState`, () =>
            client.query<{ after_thread_id: string | null; after_seq: string | null; completed: boolean }>(
                "SELECT after_thread_id, after_seq::text AS after_seq, (completed_at IS NOT NULL) AS completed FROM cortex_message_id_backfill FOR UPDATE",
            ),
        ).andThen(({ rows: [state] }) => {
            if (state === undefined) {
                return errAsync<BatchOutcome, DbError>({ type: "query_failed", op, cause: new Error("cortex_message_id_backfill holds no state row") });
            }
            if (state.completed) return okAsync<BatchOutcome, DbError>(NOTHING_LEFT);
            return tryMutation(`${op}.readBatch`, () => client.query<BatchRow>(BATCH_SQL, [state.after_thread_id, state.after_seq, batchSize])).andThen(
                ({ rows: [batch] }) => {
                    if (batch === undefined)
                        return errAsync<BatchOutcome, DbError>({ type: "mutation_failed", op, cause: new Error("the batch statement gave no row") });
                    const done = batch.rows < batchSize;
                    return tryMutation(`${op}.storeCursor`, () =>
                        client.query(
                            `UPDATE cortex_message_id_backfill
                                SET after_thread_id = COALESCE($1::text, after_thread_id),
                                    after_seq = COALESCE($2::bigint, after_seq),
                                    completed_at = CASE WHEN $3::boolean THEN now() ELSE completed_at END`,
                            [batch.last_thread_id, batch.last_seq, done],
                        ),
                    ).map((): BatchOutcome => ({ rows: batch.rows, ids: batch.ids, done }));
                },
            );
        }),
    );
}

/**
 * Record the ids of the display messages that a version before `cortex_message_ids` stored. It reads `messages` in the
 * order of `(thread_id, seq)` in batches of one transaction each, and it stores the cursor in the same transaction as
 * the records of the batch. A stop between two batches loses no committed batch, and the next call continues after the
 * cursor. A batch shorter than `batchSize` stores the completion time, and from then a call reads nothing.
 *
 * A row that a writer of an earlier version stores behind the cursor gets no record. Run it only after each writer of
 * the database records the ids.
 */
export function backfillMessageIds(pool: Querier & Connectable, options?: MessageIdBackfillOptions): ResultAsync<MessageIdBackfillOutcome, DbError> {
    const requested = options?.batchSize;
    const batchSize = requested !== undefined && Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_BATCH_SIZE;
    return new ResultAsync(
        (async () => {
            let rows = 0;
            let ids = 0;
            for (;;) {
                const batch = await readBatch(pool, batchSize);
                if (batch.isErr()) return err(batch.error);
                rows += batch.value.rows;
                ids += batch.value.ids;
                if (batch.value.done) return ok({ rows, ids });
            }
        })(),
    );
}
