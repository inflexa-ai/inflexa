/**
 * Conversation message store — the harness's owned `ThreadHistory`.
 *
 * Conversation-scoped store with an explicit two-method interface and
 * nothing else bundled in (no semantic recall, no working memory, no title
 * generation). The read side, `loadRecent`, gives the view of the latest
 * compaction marker: the stored markers decide what a turn sends, and the store
 * deletes no row.
 *
 * Scope (see the harness-thread-store spec): conversation threads only. A `threadId` is the
 * UI-generated id of one conversation thread (a random UUID — an analysis
 * has many threads); it is opaque to this module. Workflow and sandbox
 * agent loops never call this; their message durability is the DBOS step
 * cache. The interface vocabulary (`appendTurn` / `loadRecent`) is
 * conversation-turn shaped on purpose, so reaching for it inside a
 * workflow step feels immediately wrong.
 *
 * The view is always a valid AI SDK model-message sequence: it begins on a
 * `user` message — never a `tool`-role continuation — and never splits a
 * tool-call/tool-result pair. A compaction starts only between two rounds, a
 * drop keeps whole turns, and each write of a group is atomic.
 */

import { randomUUID } from "node:crypto";

import type { ModelMessage } from "ai";
import { type Histogram, metrics } from "@opentelemetry/api";
import { ResultAsync, ok, okAsync } from "neverthrow";
import type { Pool, PoolClient } from "pg";

import type { TokenUsageRollup } from "../contracts/usage.js";
import { stripNulCharacters } from "../input-sanitization.js";
import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { hasReportedUsage } from "../loop/metrics.js";
import { countTokens } from "./count-tokens.js";
import { conversationView, groupTurns, isGenuineUserStart } from "./conversation-view.js";
import {
    HARNESS_PROVIDER_NAMESPACE,
    SYNTHETIC_MESSAGE_KEY,
    envelopeMessage,
    parseStoredMessageEnvelope,
    syntheticRecordMessage,
    type StoredMessageEnvelope,
} from "./ai-sdk-message-storage.js";
import { envelopeDisplayMessages, parseStoredDisplayEnvelope, type ConversationUIMessage, type StoredDisplayEnvelope } from "./conversation-display-storage.js";

/** A resolved `ok(undefined)` ResultAsync — the empty/seed transaction step. */
function okVoid<E = DbError>(): ResultAsync<void, E> {
    return new ResultAsync(Promise.resolve(ok<void, E>(undefined)));
}

interface MessageRow {
    readonly seq: string;
    readonly message_envelope: unknown;
    readonly tokens: number;
}

/** One stored message, as returned by the display read (`loadAll`). */
export interface StoredMessage {
    readonly seq: number;
    readonly envelope: StoredMessageEnvelope;
    readonly message: ModelMessage;
    /**
     * The display projection of the group this row OPENED — present on the first
     * row of each written group and absent on every other row. The opening of a
     * turn, a round, a failure note, and a host-appended record are all groups.
     */
    readonly displayEnvelope?: StoredDisplayEnvelope;
    /**
     * What providers reported for the whole TURN this row completed — present
     * only on the last assistant row of an older turn that stored a rollup on its
     * rows. A later turn keeps its rollup on its {@link StoredMessage.turn}. Not a
     * per-row figure, and unrelated to the `tokens` count of the row
     * (see the `reported_usage` column comment in the state-init DDL).
     */
    readonly usage?: TokenUsageRollup;
    /**
     * The time that the whole TURN this row completed took, in milliseconds —
     * present only beside {@link StoredMessage.usage}, on the row of an older turn.
     */
    readonly durationMs?: number;
    /** The record of the chat turn that this user row opens. Present only on that row. */
    readonly turn?: StoredTurnRecord;
    /**
     * Who sent the user message of the append this row OPENED — present only on a
     * genuine-user-start row of a turn appended with one. A row written before the
     * column existed carries none, because no sender was ever recorded for it.
     */
    readonly author?: string;
    /**
     * When the store wrote this row: the START time of the append transaction,
     * thus every row of one append holds the same value, and `seq` alone orders
     * rows. The read sets it on every row, because the column is `NOT NULL`. It is
     * optional because a fake or a fixture builds a `StoredMessage` with no row
     * behind it.
     */
    readonly createdAt?: Date;
}

/**
 * One atomic group of rows: the exact provider-facing history, and the display
 * projection of what the user was shown.
 *
 * The two message projections are independent by design. `modelMessages` is what
 * the provider sees and the only input to token accounting; `displayMessages` is
 * what the transcript replays. Neither is derived from the other, and a failed
 * write commits neither.
 */
export interface ConversationTurn {
    /** Exact provider-facing history; token accounting and model reads use only this projection. */
    readonly modelMessages: readonly ModelMessage[];
    /** Complete ordered AI SDK UI messages recorded from the live display event stream. */
    readonly displayMessages: readonly ConversationUIMessage[];
    /**
     * Who sent the user message of this turn — the identity the host holds at the
     * append site. Stored on the FIRST row of the append, and only when that row
     * is a genuine user start: that row also carries the display projection, thus
     * the write and the transcript replay read one row under one rule. A record
     * append opens on a synthetic row, so it stores no author however a caller
     * spreads one in. The value is NUL-stripped on the way in, the same as the
     * envelope, because a `text` parameter carrying 0x00 fails the statement.
     */
    readonly author?: string;
}

/**
 * The append a host uses to record out-of-band work in a thread — an analysis
 * run's outcome, typically.
 *
 * Both projections are built here because a record has no live turn behind it:
 * no recorder observed it, so nothing else would produce its display projection,
 * and a record appended without one would be stored, read by the model, and
 * never shown. The harness owns the record-to-`system` mapping for the same
 * reason it owns the marker — a host that hand-assembled either could produce a
 * message the turn-boundary predicates fail to recognise.
 */
export function conversationRecordTurn(text: string): ConversationTurn {
    return {
        modelMessages: [syntheticRecordMessage(text)],
        displayMessages: [{ id: randomUUID(), role: "system", parts: [{ type: "text", text, state: "done" }] }],
    };
}

/** The status of a chat turn: `open` while it runs, then its outcome. */
export type TurnStatus = "open" | "done" | "aborted" | "failed";

/** The close of a chat turn. It sets the outcome on the turn record, one time. */
export interface TurnClose {
    readonly status: Exclude<TurnStatus, "open">;
    /** The reason of a failure. */
    readonly reason?: string;
    /** A rollup that reports no quantity is stored as absent. */
    readonly turnUsage?: TokenUsageRollup;
    readonly turnDurationMs?: number;
    /** The failure note, stored after the rounds. */
    readonly note?: ConversationTurn;
}

/**
 * One write of a chat turn. The opening adds the turn record, and a later write names the turn by
 * `startSeq`. The `never` members make a write with both keys fail to compile.
 */
export type TurnWrite =
    | { readonly opening: ConversationTurn; readonly startSeq?: never; readonly rounds: readonly ConversationTurn[]; readonly close?: TurnClose }
    | { readonly startSeq: number; readonly opening?: never; readonly rounds: readonly ConversationTurn[]; readonly close?: TurnClose };

export interface TurnWriteResult {
    /** The `seq` of the user row that opens the turn, which keys its turn record. */
    readonly startSeq: number;
}

/** The turn record of a chat turn, as the display read gives it. */
export interface StoredTurnRecord {
    readonly status: TurnStatus;
    readonly reason?: string;
    readonly usage?: TokenUsageRollup;
    readonly durationMs?: number;
}

/**
 * The result of `retractLastTurn`. `retracted` carries `messages` — the number
 * of rows removed — so a caller can assert exactly what came off the tail. The
 * other two variants delete nothing and are distinct on purpose: `empty-thread`
 * had no rows at all, while `no-user-turn` had rows but none opening a turn —
 * anomalous data refused rather than silently emptied.
 */
export type RetractOutcome = { kind: "retracted"; messages: number } | { kind: "empty-thread" } | { kind: "no-user-turn" };

/** The read options of {@link ThreadHistory.loadRecent}. */
export interface LoadRecentOptions {
    /** Keep the first turn of the thread, the seed of a report thread, in front of the latest summary. */
    readonly keepFirstTurn?: boolean;
}

/**
 * The conversation message store. Two methods, by design — no generic row
 * insert (see the harness-thread-store spec). `threadId` is the conversation scope — one UI thread.
 */
export interface ThreadHistory {
    /**
     * Append one group, for example a record of a host — every message written in a
     * single transaction with a `seq` monotonically increasing per thread.
     */
    appendTurn(threadId: string, turn: ConversationTurn): ResultAsync<void, DbError>;
    /**
     * Write the groups of one chat turn in one transaction, after the rows that the thread holds.
     * A write with the opening adds the turn record, and a close changes only an `open` record.
     */
    writeTurn(threadId: string, write: TurnWrite): ResultAsync<TurnWriteResult, DbError>;
    /**
     * The view of the thread: the stored markers decide which rows a turn sends, and a thread with no
     * marker gives each row. The loop computes each request with the same rule.
     */
    loadRecent(threadId: string, options?: LoadRecentOptions): ResultAsync<ModelMessage[], DbError>;
    /**
     * Return a thread's messages oldest-first for UI display, grouped into turns.
     * It gives each row, and the view of the agent loop is `loadRecent`'s job.
     *
     * There is no paginated form, because a page could never cost less: the read
     * selects and parses every row of the thread and would slice only afterwards,
     * so a page saves no query and no parse. It would only truncate the answer,
     * which is a way to lose turns and not a way to save work. A reader wanting a
     * window takes one here, where it knows what it is bounding.
     *
     * Grouped rather than flat because the grouping is what the read computes and
     * what a turn count means, and `.flat()` recovers the rows in `seq` order for
     * a display replay. The reverse does not hold: a flat return would make a
     * caller that wants the tail turn, or the newest N turns, re-find boundaries
     * this read already found.
     */
    loadAll(threadId: string): ResultAsync<StoredMessage[][], DbError>;
    /**
     * Remove the thread's most recent turn — every row from the last
     * genuine-user-start `seq` onward, and its turn record — in a single transaction.
     *
     * When the last turn goes, each earlier prefix stays byte-identical. A later
     * request never sees a changed earlier record, and only the last turn can go.
     *
     * Callers are assumed single-writer per thread (the host serializes turns);
     * the outcome's `messages` count lets a caller assert exactly what was
     * removed. A thread that has rows but no genuine-user-start row is anomalous
     * data — refused as `no-user-turn` with nothing deleted, never emptied. An
     * empty thread reports `empty-thread`.
     */
    retractLastTurn(threadId: string): ResultAsync<RetractOutcome, DbError>;
    /**
     * The greatest `messages.seq` in the thread, or `null` when the thread holds
     * no messages. The read takes no lock: it reports the tail at the read
     * moment, and a concurrent append can move the tail one row later.
     *
     * `appendTurn` computes the same value under its lock to place the next row.
     * This read shares the table, not that statement. A lock here buys a caller
     * no guarantee, because the tail can move one append later without it.
     */
    latestSeq(threadId: string): ResultAsync<number | null, DbError>;
    /**
     * When the thread last moved — `MAX(messages.created_at)`, or `null` for a
     * thread with no rows. The thread's ACTIVITY clock, and deliberately not
     * `cortex_analysis_threads.updated_at`: a title rename bumps that column
     * too, so it cannot answer "has a turn settled since <time>".
     */
    latestTurnAt(threadId: string): ResultAsync<Date | null, DbError>;
    /**
     * The count of the thread turns that a person opened past `seq`. A caller
     * reads it as the new work of the thread past an anchor.
     *
     * The unit is a turn, not a row. One turn writes a user row, an assistant
     * row for each step, and a tool row for each result. Thus a row count of one
     * span reports the shape of a turn, not the count of the asks.
     *
     * A seq comparison alone reports even less. An anchor taken during a turn
     * sits below the rows of that same turn, thus the difference never reads as
     * zero again.
     *
     * The count reads {@link GENUINE_USER_START_SQL}, the one predicate the turn
     * grouping and the tail retraction already cut on. Thus the count and the
     * grouping cannot drift. A synthetic nudge of the loop and a record of the
     * host both carry the `user` role, and neither one is new work. Thus neither
     * one adds to the count.
     */
    countUserTurnsAfter(threadId: string, seq: number): ResultAsync<number, DbError>;
}

/**
 * {@link isGenuineUserStart} (`conversation-view.ts`) expressed over a stored
 * `message_envelope` — the boundary predicate `retractLastTurn` cuts on.
 *
 * Interpolating here, and only here, is safe: both interpolated values are
 * module constants shared with the TypeScript predicate, never caller input, so
 * there is no injection surface — and a bound parameter cannot express a JSON
 * path anyway. `IS DISTINCT FROM` (not `<> 'true'`) because `->>` yields NULL on
 * every message that carries no `providerOptions` at all, which is nearly all of
 * them; a plain inequality would discard them.
 */
const GENUINE_USER_START_SQL = `message_envelope->'message'->>'role' = 'user'
                         AND message_envelope->'message'->'providerOptions'->'${HARNESS_PROVIDER_NAMESPACE}'->>'${SYNTHETIC_MESSAGE_KEY}' IS DISTINCT FROM 'true'`;

/**
 * Serialize a message's storage envelope, dropping NUL from every string it
 * carries ({@link stripNulCharacters}).
 *
 * A stored NUL does not break the insert on a `json` column, nor the whole-row
 * reads — it breaks {@link GENUINE_USER_START_SQL}, whose JSON operators refuse
 * to walk a document containing one, so a single poisoned row would make the
 * thread's tail unretractable. The loop already strips NUL where it builds a
 * tool result, so this scrubs nothing on the harness's own path; it holds the
 * invariant for every other writer.
 *
 * The replacer sees values, not keys — the same accepted limit as the loop's.
 */
function serializeEnvelope(message: ModelMessage): string {
    return JSON.stringify(envelopeMessage(message), (_key, value: unknown) => (typeof value === "string" ? stripNulCharacters(value) : value));
}

interface ThreadInstruments {
    readonly totalTokens: Histogram;
    readonly turnsEvicted: Histogram;
}

let instruments: ThreadInstruments | undefined;

function getInstruments(): ThreadInstruments {
    if (instruments === undefined) {
        const meter = metrics.getMeter("cortex.harness.memory");
        instruments = {
            totalTokens: meter.createHistogram("cortex.harness.thread.total_tokens", {
                description: "Total estimated token count of the rows of a conversation thread, sampled on every loadRecent",
                unit: "{token}",
            }),
            turnsEvicted: meter.createHistogram("cortex.harness.thread.turns_evicted", {
                description: "Conversation turns of which the view of loadRecent holds no message",
                unit: "{turn}",
            }),
        };
    }
    return instruments;
}

/**
 * Drop the memoized instruments so the next `loadRecent` rebinds to a
 * freshly-registered `MeterProvider`. Test-only.
 */
export function __resetThreadHistoryMetricsForTest(): void {
    instruments = undefined;
}

/**
 * Serialize the writes of one thread — without the lock, two transactions can
 * both read the same MAX(seq) and collide on the (thread_id, seq) primary key.
 * Released automatically at COMMIT/ROLLBACK.
 */
function lockThread(client: PoolClient, threadId: string, op: string): ResultAsync<void, DbError> {
    return tryQuery(`${op}.lock`, () => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [threadId])).map(() => undefined);
}

/** The `seq` of the next row of the thread. Read it under {@link lockThread}. */
function nextSeq(client: PoolClient, threadId: string, op: string): ResultAsync<number, DbError> {
    return tryQuery(`${op}.maxSeq`, async () => {
        const { rows } = await client.query<{ max_seq: string }>("SELECT COALESCE(MAX(seq), -1)::text AS max_seq FROM messages WHERE thread_id = $1", [
            threadId,
        ]);
        return Number(rows[0]!.max_seq) + 1;
    });
}

/** Insert the rows of one group, from `startSeq` on. */
function insertGroup(client: PoolClient, threadId: string, startSeq: number, group: ConversationTurn, op: string): ResultAsync<void, DbError> {
    const { modelMessages: messages, displayMessages, author } = group;
    // The display projection rides the group's FIRST row, so one SELECT of a
    // thread's rows yields every envelope in order with no join and no grouping.
    // Whichever row that is — a genuine user message opening a turn, or the lone
    // record row of an out-of-band append — is the row a tail retraction removes
    // the envelope with, because it is the row the projection describes.
    const displayEnvelope = displayMessages.length > 0 ? JSON.stringify(envelopeDisplayMessages(displayMessages)) : null;
    // The author rides the row the display projection rides, and only when that
    // row is a message a person actually sent — an assistant row, a tool row,
    // and the synthetic opening row of a record append are not. NUL is dropped
    // rather than refused: a 0x00 byte in a `text` parameter fails the
    // statement, and one byte in a label would roll the whole turn back.
    const turnAuthor = author === undefined ? null : stripNulCharacters(author);
    const authorRow = messages[0] !== undefined && isGenuineUserStart(messages[0]) ? 0 : -1;
    // Insert the group's messages in order. Each insert chains off the
    // prior so the first `err` short-circuits — and `withTransaction`
    // re-throws it to force ROLLBACK (a returned `err` that does not
    // reach `withTransaction` would COMMIT silently).
    return messages.reduce(
        (chain, message, i) =>
            chain.andThen(() =>
                tryMutation(`${op}.insert`, () =>
                    client.query(
                        // `message_envelope::json`, never `::jsonb`; `display_envelope::jsonb`,
                        // never `::json` — see the column comments in the state-init DDL.
                        `INSERT INTO messages (thread_id, seq, message_envelope, display_envelope, tokens, author)
                     VALUES ($1, $2, $3::json, $4::jsonb, $5, $6)
                     ON CONFLICT (thread_id, seq) DO UPDATE
                       SET message_envelope = EXCLUDED.message_envelope,
                           display_envelope = EXCLUDED.display_envelope,
                           tokens = EXCLUDED.tokens,
                           author = EXCLUDED.author`,
                        [
                            threadId,
                            startSeq + i,
                            serializeEnvelope(message),
                            i === 0 ? displayEnvelope : null,
                            countTokens(message.content),
                            i === authorRow ? turnAuthor : null,
                        ],
                    ),
                ).map(() => undefined),
            ),
        okVoid<DbError>(),
    );
}

/** Move `cortex_analysis_threads.updated_at` forward inside the write transaction. */
function touchThread(client: PoolClient, threadId: string, op: string): ResultAsync<void, DbError> {
    // Thread listings sort on `cortex_analysis_threads.updated_at`, and
    // the only other writer of it is the title update — so without this
    // touch "most recently updated" degrades to "most recently created
    // or renamed" and an actively-used older thread sorts last. Writing
    // it from here (a row the thread store otherwise owns) buys the
    // guarantee for every host with no wiring, and inside the turn's own
    // transaction there is no window where the rows exist but the thread
    // reads stale.
    //
    // The breadcrumb is never worth the turn: the touch may fail without
    // failing the append, and affecting zero rows is equally normal — a
    // thread with no metadata row, or a soft-deleted one this leaves
    // alone rather than reviving (every other writer of the table filters
    // the tombstone too). Tolerating the failure takes the savepoint, not
    // just the swallowed `err`: Postgres poisons a transaction at its
    // first failed statement and downgrades the eventual COMMIT to a
    // ROLLBACK — without a rewind point the turn's inserts would go with
    // it, and silently, since that COMMIT still reports success.
    //
    // `GREATEST(updated_at, clock_timestamp())` because `NOW()` is
    // transaction-START time while this transaction has since waited on
    // the advisory lock and spent a round trip per message: a title update
    // that began later can already have stamped a newer `updated_at`, and
    // a plain assignment would rewind it. Activity only ever moves the
    // timestamp forward.
    return tryMutation(`${op}.touchThread.savepoint`, () => client.query("SAVEPOINT touch_thread"))
        .andThen(() =>
            tryMutation(`${op}.touchThread`, () =>
                client.query(
                    `UPDATE cortex_analysis_threads
                        SET updated_at = GREATEST(updated_at, clock_timestamp())
                      WHERE thread_id = $1 AND deleted_at IS NULL`,
                    [threadId],
                ),
            ),
        )
        .map(() => undefined)
        .orElse(() =>
            // Rewind to before the touch so the transaction is usable again
            // and the write commits. Nothing follows in the chain of a caller,
            // so COMMIT releases the savepoint on the success path.
            tryMutation(`${op}.touchThread.rewind`, () => client.query("ROLLBACK TO SAVEPOINT touch_thread"))
                .map(() => undefined)
                .orElse(() => okVoid<DbError>()),
        );
}

/** Add the `open` record of a turn. The upsert replaces a record whose rows are gone, because the opening row holds its key now. */
function openTurnRecord(client: PoolClient, threadId: string, startSeq: number): ResultAsync<void, DbError> {
    return tryMutation("thread-history.writeTurn.openRecord", () =>
        client.query(
            `INSERT INTO cortex_thread_turns (thread_id, start_seq, status)
             VALUES ($1, $2, 'open')
             ON CONFLICT (thread_id, start_seq) DO UPDATE
               SET status = 'open', reason = NULL, reported_usage = NULL, turn_duration_ms = NULL, opened_at = NOW(), closed_at = NULL`,
            [threadId, startSeq],
        ),
    ).map(() => undefined);
}

/** Set the outcome of a turn record that is still `open`, thus a second close changes nothing. */
function closeTurnRecord(client: PoolClient, threadId: string, startSeq: number, close: TurnClose): ResultAsync<void, DbError> {
    // The predicate of the loop decides whether a rollup reported a quantity, thus the two cannot drift.
    const rollup = hasReportedUsage(close.turnUsage) ? JSON.stringify(close.turnUsage) : null;
    return tryMutation("thread-history.writeTurn.closeRecord", () =>
        client.query(
            `UPDATE cortex_thread_turns
                SET status = $3, reason = $4, reported_usage = $5::jsonb, turn_duration_ms = $6, closed_at = NOW()
              WHERE thread_id = $1 AND start_seq = $2 AND status = 'open'`,
            [threadId, startSeq, close.status, close.reason === undefined ? null : stripNulCharacters(close.reason), rollup, close.turnDurationMs ?? null],
        ),
    ).map(() => undefined);
}

/**
 * Create a `ThreadHistory` bound to a Postgres pool — a factory closure
 * capturing `pool` (dependency injection per the harness-durable-runtime spec). The `messages` table is
 * provisioned by the project's state-init DDL.
 *
 * `logger` serves exactly one purpose: reporting a stored display part the
 * current vocabulary had to drop. It is optional because the read returns the
 * same messages either way — the drop reports a deploy, not a failed read — and
 * requiring it would break every call site over a diagnostic.
 */
export function createThreadHistory(pool: Pool, logger?: Logger): ThreadHistory {
    function appendTurn(threadId: string, turn: ConversationTurn): ResultAsync<void, DbError> {
        if (turn.modelMessages.length === 0) return okVoid();
        return withTransaction(pool, "thread-history.appendTurn", (client) =>
            lockThread(client, threadId, "thread-history.appendTurn")
                .andThen(() => nextSeq(client, threadId, "thread-history.appendTurn"))
                .andThen((startSeq) => insertGroup(client, threadId, startSeq, turn, "thread-history.appendTurn"))
                .andThen(() => touchThread(client, threadId, "thread-history.appendTurn")),
        );
    }

    function writeTurn(threadId: string, write: TurnWrite): ResultAsync<TurnWriteResult, DbError> {
        const { close } = write;
        const groups = [...(write.opening === undefined ? [] : [write.opening]), ...write.rounds, ...(close?.note === undefined ? [] : [close.note])];
        return withTransaction(pool, "thread-history.writeTurn", (client) =>
            lockThread(client, threadId, "thread-history.writeTurn")
                .andThen(() => nextSeq(client, threadId, "thread-history.writeTurn"))
                .andThen((firstSeq) => {
                    const startSeq = write.opening === undefined ? write.startSeq : firstSeq;
                    const steps: (() => ResultAsync<void, DbError>)[] = [];
                    let seq = firstSeq;
                    for (const [index, group] of groups.entries()) {
                        const groupSeq = seq;
                        seq += group.modelMessages.length;
                        steps.push(() => insertGroup(client, threadId, groupSeq, group, "thread-history.writeTurn"));
                        if (index === 0 && write.opening !== undefined) steps.push(() => openTurnRecord(client, threadId, startSeq));
                    }
                    if (close !== undefined) steps.push(() => closeTurnRecord(client, threadId, startSeq, close));
                    steps.push(() => touchThread(client, threadId, "thread-history.writeTurn"));
                    return steps.reduce((chain, step) => chain.andThen(step), okVoid<DbError>()).map(() => ({ startSeq }));
                }),
        );
    }

    function loadRecent(threadId: string, options?: LoadRecentOptions): ResultAsync<ModelMessage[], DbError> {
        return tryQuery("thread-history.loadRecent", async () => {
            const { rows } = await pool.query<MessageRow>(
                // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
                // `seq::text AS seq` output alias (Postgres resolves an unqualified
                // ORDER BY name to the output column), sorting the bigint as text:
                // "10" before "2". Scrambled order splits a tool-call/tool-result pair
                // across an intervening turn. The qualified name forces the bigint column.
                //
                // `reported_usage` is deliberately NOT selected. The metric reads the
                // `tokens` estimate that every row carries, and a turn that reported
                // nothing has no rollup at all. The two are different measurements
                // sharing a unit; see the column comments.
                `SELECT seq::text AS seq, message_envelope, tokens
         FROM messages WHERE thread_id = $1 ORDER BY messages.seq ASC`,
                [threadId],
            );
            const parsed = rows.map((row, index) => ({
                index,
                message: parseStoredMessageEnvelope(row.message_envelope, `${threadId}/${row.seq}`).message,
                tokens: row.tokens,
            }));

            const view = conversationView(
                parsed.map((row) => row.message),
                options ?? {},
            );
            const held = new Set(view.sources);
            const turns = groupTurns(parsed, (row) => isGenuineUserStart(row.message));
            const turnsLeftOut = turns.filter((turn) => !turn.some((row) => held.has(row.index))).length;

            const { totalTokens, turnsEvicted } = getInstruments();
            const attributes = { eviction: turnsLeftOut > 0 };
            totalTokens.record(
                parsed.reduce((sum, row) => sum + row.tokens, 0),
                attributes,
            );
            turnsEvicted.record(turnsLeftOut, attributes);

            return view.messages;
        });
    }

    // Display reads are turn-bounded, not row-bounded. A serial-tool assistant
    // turn is persisted as one row per step (plus its tool_result `user` rows),
    // so a row-windowed page could split a turn — truncating the trailing
    // report card/text out of the page the UI fetches. Read the thread and group
    // into turns, so a turn always reloads intact. Threads are conversation-scoped
    // and bounded, so reading every row here matches `loadRecent`'s existing
    async function readTurns(threadId: string): Promise<StoredMessage[][]> {
        const { rows } = await pool.query<{
            seq: string;
            message_envelope: unknown;
            display_envelope: unknown;
            // pg parses a `jsonb` column into a JS value. The cast on the way out is
            // sound because each writer of the two usage columns stores a
            // `TokenUsageRollup`, and null is preserved as null by the spread below
            // rather than read as a rollup.
            reported_usage: TokenUsageRollup | null;
            // The driver hands a bigint back as text, and the `::text` cast below
            // says so. `Number` makes the crossing in one place — the way every
            // other read of a bigint column in this module does.
            turn_duration_ms: string | null;
            author: string | null;
            // The driver hands a `TIMESTAMPTZ` back as a `Date`, and the column is
            // NOT NULL, thus every row of this read holds a time.
            created_at: Date;
            // The CHECK constraint of the column holds the value to the four statuses.
            turn_status: TurnStatus | null;
            turn_reason: string | null;
            turn_usage: TokenUsageRollup | null;
            turn_record_duration_ms: string | null;
        }>(
            // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
            // `seq::text AS seq` output alias (Postgres resolves an unqualified
            // ORDER BY name to the output column), sorting the bigint as text:
            // "10" before "2". The qualified name forces the bigint column.
            `SELECT messages.seq::text AS seq, messages.message_envelope, messages.display_envelope, messages.reported_usage,
                messages.turn_duration_ms::text AS turn_duration_ms, messages.author, messages.created_at,
                turns.status AS turn_status, turns.reason AS turn_reason, turns.reported_usage AS turn_usage,
                turns.turn_duration_ms::text AS turn_record_duration_ms
         FROM messages
         LEFT JOIN cortex_thread_turns turns ON turns.thread_id = messages.thread_id AND turns.start_seq = messages.seq
         WHERE messages.thread_id = $1
         ORDER BY messages.seq ASC`,
            [threadId],
        );

        // Spread rather than `usage: r.reported_usage ?? undefined`, so a row with
        // no rollup carries no `usage` KEY at all — absent, not present-and-undefined.
        // The duration and the author obey the same rule, each from its own column.
        // The creation time is unconditional: its column is NOT NULL, thus it has no
        // absence to represent.
        const stored: StoredMessage[] = await Promise.all(
            rows.map(async (r) => {
                const envelope = parseStoredMessageEnvelope(r.message_envelope, `${threadId}/${r.seq}`);
                const displayEnvelope =
                    r.display_envelope == null ? undefined : await parseStoredDisplayEnvelope(r.display_envelope, `${threadId}/${r.seq}/display`, logger);
                const turn: StoredTurnRecord | undefined =
                    r.turn_status === null
                        ? undefined
                        : {
                              status: r.turn_status,
                              ...(r.turn_reason === null ? {} : { reason: r.turn_reason }),
                              ...(r.turn_usage === null ? {} : { usage: r.turn_usage }),
                              ...(r.turn_record_duration_ms === null ? {} : { durationMs: Number(r.turn_record_duration_ms) }),
                          };
                return {
                    seq: Number(r.seq),
                    envelope,
                    message: envelope.message,
                    ...(displayEnvelope ? { displayEnvelope } : {}),
                    ...(r.reported_usage === null ? {} : { usage: r.reported_usage }),
                    ...(r.turn_duration_ms === null ? {} : { durationMs: Number(r.turn_duration_ms) }),
                    ...(turn === undefined ? {} : { turn }),
                    ...(r.author === null ? {} : { author: r.author }),
                    createdAt: r.created_at,
                };
            }),
        );

        return groupTurns(stored, (row) => isGenuineUserStart(row.message));
    }

    function loadAll(threadId: string): ResultAsync<StoredMessage[][], DbError> {
        return tryQuery("thread-history.loadAll", () => readTurns(threadId));
    }

    function retractLastTurn(threadId: string): ResultAsync<RetractOutcome, DbError> {
        return withTransaction(pool, "thread-history.retractLastTurn", (client) =>
            // Take the SAME per-thread advisory lock `appendTurn` takes, and take it
            // FIRST — a retract and an append on one thread must never interleave, or
            // the retract could read a boundary mid-append and delete only part of a
            // turn still being written. Serialized on this lock it always sees a whole
            // turn or none of one. Released automatically at COMMIT/ROLLBACK.
            tryQuery("thread-history.retractLastTurn.lock", () => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [threadId]))
                .andThen(() =>
                    // Locate the tail turn's opening row and, in the same read, learn
                    // whether the thread has any rows at all. The boundary is the greatest
                    // `seq` matching `GENUINE_USER_START_SQL` — the stored-envelope twin of
                    // `isGenuineUserStart`, so a `tool`-role continuation and a
                    // loop-synthesized nudge are both excluded and the cut lands on a real
                    // turn head. The coupling is test-guarded: an append-then-retract
                    // round-trip fails loudly (the just-appended turn reads back as
                    // `no-user-turn` instead of `retracted`) the moment this envelope path
                    // drifts from what `isGenuineUserStart` reads on the live message.
                    // `has_rows` separates the two nothing-to-delete cases: an empty thread
                    // (`empty-thread`) from one holding no turn-opening row at all
                    // (`no-user-turn`, anomalous data we refuse rather than empty).
                    // `MAX(seq)` aggregates the bigint column; the `::text` cast is
                    // transport only, so no comparison ever runs against a text projection —
                    // and the boundary rides back as text so a seq beyond 2^53 survives
                    // without float rounding.
                    tryQuery("thread-history.retractLastTurn.boundary", async () => {
                        const { rows } = await client.query<{ has_rows: boolean; boundary: string | null }>(
                            `SELECT EXISTS(SELECT 1 FROM messages WHERE thread_id = $1) AS has_rows,
                    (SELECT MAX(seq)::text FROM messages
                       WHERE thread_id = $1
                         AND ${GENUINE_USER_START_SQL}) AS boundary`,
                            [threadId],
                        );
                        return rows[0]!;
                    }),
                )
                .andThen(({ has_rows, boundary }) => {
                    if (!has_rows) return okAsync<RetractOutcome, DbError>({ kind: "empty-thread" });
                    if (boundary === null) return okAsync<RetractOutcome, DbError>({ kind: "no-user-turn" });
                    // Delete the whole tail turn: every row at or past the boundary seq.
                    // `$2::bigint` compares the bigint column against a bigint, never a
                    // text projection, keeping the comparison exact for large seqs.
                    return tryMutation("thread-history.retractLastTurn.delete", () =>
                        client.query("DELETE FROM messages WHERE thread_id = $1 AND seq >= $2::bigint", [threadId, boundary]),
                    ).andThen((res) =>
                        tryMutation("thread-history.retractLastTurn.deleteTurnRecords", () =>
                            client.query("DELETE FROM cortex_thread_turns WHERE thread_id = $1 AND start_seq >= $2::bigint", [threadId, boundary]),
                        ).map<RetractOutcome>(() => ({ kind: "retracted", messages: res.rowCount ?? 0 })),
                    );
                }),
        );
    }

    function latestSeq(threadId: string): ResultAsync<number | null, DbError> {
        // `MAX(seq)` over no rows is SQL NULL, so a thread with no messages reads
        // as `null`, not as a seq — the absence a caller reads before it treats
        // the value as an anchor. The `::text` cast carries a seq past 2^53 across
        // the driver intact, the way every other read of this bigint column does,
        // and `Number` makes the crossing in one place.
        return tryQuery("thread-history.latestSeq", () =>
            pool.query<{ max_seq: string | null }>("SELECT MAX(seq)::text AS max_seq FROM messages WHERE thread_id = $1", [threadId]),
        ).map(({ rows }) => {
            const maxSeq = rows[0]?.max_seq ?? null;
            return maxSeq === null ? null : Number(maxSeq);
        });
    }

    function latestTurnAt(threadId: string): ResultAsync<Date | null, DbError> {
        // `MAX(created_at)` over no rows is SQL NULL, so a thread with no messages
        // reads as `null` rather than as a time. This is the thread's ACTIVITY
        // clock — distinct from `cortex_analysis_threads.updated_at`, which a
        // rename also bumps, and so cannot answer "did a turn settle after X".
        return tryQuery("thread-history.latestTurnAt", () =>
            pool.query<{ latest_at: Date | null }>("SELECT MAX(created_at) AS latest_at FROM messages WHERE thread_id = $1", [threadId]),
        ).map(({ rows }) => rows[0]?.latest_at ?? null);
    }

    function countUserTurnsAfter(threadId: string, seq: number): ResultAsync<number, DbError> {
        // `GENUINE_USER_START_SQL` is the stored-envelope twin of
        // `isGenuineUserStart`, and the tail retraction cuts on the same text.
        // Thus one row matches for each turn that a person opened, and a
        // synthetic nudge of the loop or a record of the host matches none.
        //
        // `$2::bigint` compares the bigint column against a bigint, never against
        // a text projection, thus an anchor past 2^53 still compares exactly.
        // `COUNT(*)` is a bigint as well, and the driver hands a bigint back as
        // text. The explicit cast says so, and `Number` makes the crossing in one
        // place — the way every other read of this column does.
        return tryQuery("thread-history.countUserTurnsAfter", () =>
            pool.query<{ turns: string }>(
                `SELECT COUNT(*)::text AS turns FROM messages
              WHERE thread_id = $1
                AND seq > $2::bigint
                AND ${GENUINE_USER_START_SQL}`,
                [threadId, seq],
            ),
        ).map(({ rows }) => Number(rows[0]!.turns));
    }

    return { appendTurn, writeTurn, loadRecent, loadAll, retractLastTurn, latestSeq, latestTurnAt, countUserTurnsAfter };
}
