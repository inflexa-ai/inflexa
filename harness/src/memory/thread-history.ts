/**
 * Conversation message store — the harness's owned `ThreadHistory`.
 *
 * Conversation-scoped store with an explicit two-method interface and
 * nothing else bundled in (no semantic recall, no working memory, no title
 * generation). It is also the home of context-window management — the read
 * side, `loadRecent`, returns a token-bounded window.
 *
 * Scope (see the harness-thread-store spec): conversation threads only. A `threadId` is the
 * UI-generated id of one conversation thread (a random UUID — an analysis
 * has many threads); it is opaque to this module. Workflow and sandbox
 * agent loops never call this; their message durability is the DBOS step
 * cache. The interface vocabulary (`appendTurn` / `loadRecent`) is
 * conversation-turn shaped on purpose, so reaching for it inside a
 * workflow step feels immediately wrong.
 *
 * The window is always a valid AI SDK model-message sequence: it begins on a
 * `user` message that is genuine user input — never a `tool`-role
 * continuation — and never splits a tool-call/tool-result pair. The turn
 * is the atomic unit; `appendTurn` writes one atomically and `loadRecent`
 * rounds the budget walk to turn boundaries.
 */

import { randomUUID } from "node:crypto";

import type { ModelMessage } from "ai";
import { type Histogram, metrics } from "@opentelemetry/api";
import { ResultAsync, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { TokenUsageRollup } from "../contracts/usage.js";
import { stripNulCharacters } from "../input-sanitization.js";
import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";
import { hasReportedUsage } from "../loop/metrics.js";
import { countTokens } from "./count-tokens.js";
import {
    HARNESS_PROVIDER_NAMESPACE,
    SYNTHETIC_MESSAGE_KEY,
    envelopeMessage,
    isSyntheticUserMessage,
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
     * The display projection of the append this row OPENED — present on the first
     * row of each `appendTurn` and absent on every other row. A conversation turn
     * and a host-appended record are both appends, so both carry one.
     */
    readonly displayEnvelope?: StoredDisplayEnvelope;
    /**
     * What providers reported for the whole TURN this row completed — present
     * only on the last assistant row of a turn appended with a rollup, absent
     * everywhere else. Not a per-row figure, and unrelated to the `tokens` count
     * `loadRecent` windows by: that is an offline estimate stamped on every row,
     * this is a provider's own report (see the `reported_usage` column comment in
     * the state-init DDL).
     */
    readonly usage?: TokenUsageRollup;
    /**
     * The time that the whole TURN this row completed took, in milliseconds —
     * present only on the last assistant row of a turn appended with a duration,
     * absent everywhere else. It has a column of its own, thus a turn that
     * reported no quantity still reads back with the duration that it took.
     */
    readonly durationMs?: number;
}

/**
 * One atomic append: the exact provider-facing history, the display projection of
 * what the user was shown, and what the turn reported spending.
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
     * The turn's reported rollup, as `AgentFinish.turnUsage` carries it out of the
     * loop. Stored on the LAST assistant message of the turn — the row a reader
     * associates with the reply. Omitting it, and supplying one that reports no
     * quantity at all, both leave the row without one: a turn that reported nothing
     * must not read back as a turn that cost zero.
     */
    readonly turnUsage?: TokenUsageRollup;
    /**
     * The time that the turn took, in milliseconds, as the live header measured
     * it. Stored beside the rollup, on the same last assistant message. A caller
     * that supplies none leaves the row without one, and nothing reconstructs a
     * value later. The duration keeps a column of its own, thus a turn that
     * reported no quantity still keeps the duration that it took.
     */
    readonly turnDurationMs?: number;
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

/**
 * The result of `retractLastTurn`. `retracted` carries `messages` — the number
 * of rows removed — so a caller can assert exactly what came off the tail. The
 * other two variants delete nothing and are distinct on purpose: `empty-thread`
 * had no rows at all, while `no-user-turn` had rows but none opening a turn —
 * anomalous data refused rather than silently emptied.
 */
export type RetractOutcome = { kind: "retracted"; messages: number } | { kind: "empty-thread" } | { kind: "no-user-turn" };

/**
 * The read options of {@link ThreadHistory.loadRecent}. An absent option gives
 * the default window.
 */
export interface LoadRecentOptions {
    /**
     * Keep the first turn of the thread in the window, past the eviction. The
     * default is `false`, and the eviction then drops the first turn with the
     * rest of the oldest block.
     */
    readonly keepFirstTurn?: boolean;
}

/**
 * The conversation message store. Two methods, by design — no generic row
 * insert (see the harness-thread-store spec). `threadId` is the conversation scope — one UI thread.
 */
export interface ThreadHistory {
    /**
     * Append one {@link ConversationTurn} — every message written in a single
     * transaction with a `seq` monotonically increasing per thread.
     *
     * A turn writing no assistant message stores neither the rollup nor the
     * duration and still succeeds: there is no row on which the two figures
     * would mean anything.
     */
    appendTurn(threadId: string, turn: ConversationTurn): ResultAsync<void, DbError>;
    /**
     * Return a recent-turns window that fits `tokenBudget`, oldest-first,
     * snapped to a valid AI SDK model-message sequence. The window START advances
     * in whole `EVICTION_BLOCK_TURNS` blocks (see the constant) so the prompt-cache
     * prefix stays byte-stable across appends; the window may therefore carry a
     * little less than the budget would strictly allow, but never more.
     *
     * `keepFirstTurn` keeps the first turn of the thread. The eviction then drops
     * the oldest turns after it, and the window holds the first turn and that
     * retained suffix. The first turn appears one time only.
     *
     * The retained turn can carry the window past `tokenBudget`. The cost is
     * bounded. A report session seeds one turn, its brief carries a length bound,
     * and its copy of the working-memory render is one row. The retained head also
     * holds `messages[0]` byte-identical for the life of the thread, thus the
     * prompt-cache prefix of the provider stays still.
     */
    loadRecent(threadId: string, tokenBudget: number, options?: LoadRecentOptions): ResultAsync<ModelMessage[], DbError>;
    /**
     * Return a thread's messages oldest-first for UI display, grouped into turns.
     * NOT token-windowed — that is `loadRecent`'s job for the agent loop — and no
     * eviction.
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
     * genuine-user-start `seq` onward — in a single transaction.
     *
     * Tail-only by design: removal cuts at the last genuine-user-start `seq` —
     * a turn boundary, not the last append. Because every conversation turn
     * opens with the user's message, that boundary starts the most recent turn,
     * so removing it restores the row set the thread held before that turn and
     * leaves `loadRecent`'s byte-stable prompt-cache prefix untouched; an
     * out-of-contract assistant-only follow-up append carries no user-start row
     * and so folds into the removed tail, exactly as the read side's turn
     * grouping folds it. Deleting mid-history would shift the window head and
     * rewrite that prefix, so it is deliberately not offered — only the tail
     * can come off.
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
 * A turn starts on a `user` message that a human actually sent. Two kinds of
 * message carry the `user` role without opening a turn, and both are excluded
 * here:
 *
 * - a tool result, which in AI SDK terms is a `tool`-role message, so a mid-turn
 *   tool continuation never matches in the first place;
 * - a message the LOOP or the HOST synthesized (`syntheticUserMessage`) — the
 *   truncated-reply nudge the loop inserts mid-turn, and the record an embedder
 *   appends between turns for work that happened outside the conversation, such as
 *   an analysis run's outcome. Both carry the `user` role for the wire format and
 *   neither is user input. Reading one as a boundary would split one turn into
 *   two: the token window would evict half a turn, and `retractLastTurn` would cut
 *   its tail in the middle of a turn rather than at its head.
 *
 *   A host-appended record therefore belongs to the turn preceding it, so a tail
 *   retraction that removes that turn removes the record with it. That is the
 *   accepted consequence of the exclusion, not a defect — the alternative, letting
 *   it open a turn, is the exact failure the marker exists to prevent.
 *
 * {@link GENUINE_USER_START_SQL} is the twin of this predicate over stored
 * envelopes; the two are built from the same constants so they cannot drift.
 */
function isGenuineUserStart(message: ModelMessage): boolean {
    return message.role === "user" && !isSyntheticUserMessage(message);
}

/**
 * {@link isGenuineUserStart} expressed over a stored `message_envelope` — the
 * boundary predicate `retractLastTurn` cuts on.
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

/**
 * Group rows (oldest-first) into turns at genuine-user-start boundaries.
 * Generic over the row shape so the token-windowed read (`loadRecent`) and
 * the display read (`loadAll`) share it, each supplying its own start
 * predicate.
 */
function groupTurns<T>(rows: readonly T[], isStart: (row: T) => boolean): T[][] {
    const turns: T[][] = [];
    for (const row of rows) {
        if (turns.length === 0 || isStart(row)) {
            turns.push([row]);
        } else {
            turns[turns.length - 1]!.push(row);
        }
    }
    return turns;
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
                description: "Total token count of a conversation thread, sampled on every loadRecent",
                unit: "{token}",
            }),
            turnsEvicted: meter.createHistogram("cortex.harness.thread.turns_evicted", {
                description: "Conversation turns dropped by loadRecent's token-budget window",
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
 * Chunked-eviction block size, in whole turns — the granularity at which
 * `loadRecent`'s retained window may advance its START turn.
 *
 * `loadRecent` snaps its eviction count UP to a multiple of this block, so the
 * window's first turn — hence `messages[0]` and the whole tools+system+history
 * prompt-cache prefix — stays byte-identical across a run of appends and shifts
 * only once per block instead of once per turn. That single shift is the only
 * message-cache miss the block costs.
 *
 * The block is at once (a) the cache-miss cadence — one prefix shift per
 * `EVICTION_BLOCK_TURNS` appends once a thread is over budget — and (b) the most
 * extra context ever sacrificed: snapping up drops up to `EVICTION_BLOCK_TURNS -
 * 1` oldest turns the budget alone would have kept, trading a little history for
 * a still prefix. 4 holds the prefix for ~4 turns at a cost of at most 3 turns of
 * headroom — negligible against a ~120k-token budget that spans far more turns,
 * while cutting cache misses on a long thread roughly fourfold. A turn-count
 * block (not a token block) is deliberate: a cache miss is triggered by the START
 * turn moving, a per-turn event, so counting in turns makes the miss cadence
 * exact and independent of how large any individual turn is.
 */
export const EVICTION_BLOCK_TURNS = 4;

/**
 * Create a `ThreadHistory` bound to a Postgres pool — a factory closure
 * capturing `pool` (dependency injection per the harness-durable-runtime spec). The `messages` table is
 * provisioned by the project's state-init DDL.
 */
export function createThreadHistory(pool: Pool): ThreadHistory {
    function appendTurn(threadId: string, turn: ConversationTurn): ResultAsync<void, DbError> {
        const { modelMessages: messages, displayMessages, turnUsage, turnDurationMs } = turn;
        if (messages.length === 0) return okVoid();
        // The display projection rides the append's FIRST row, so one SELECT of a
        // thread's rows yields every envelope in order with no join and no grouping.
        // Whichever row that is — a genuine user message opening a turn, or the lone
        // record row of an out-of-band append — is the row a tail retraction removes
        // the envelope with, because it is the row the projection describes.
        const displayEnvelope = displayMessages.length > 0 ? JSON.stringify(envelopeDisplayMessages(displayMessages)) : null;
        // A rollup that reports no quantity is stored as absent, not as a rollup of
        // absences, so "no figure" has exactly one representation in storage.
        // `hasReportedUsage` is the loop's own predicate for the same question,
        // reused rather than restated so the write and the loop cannot drift.
        const rollup = hasReportedUsage(turnUsage) ? JSON.stringify(turnUsage) : null;
        // The duration takes no predicate of its own, and it keeps its own column.
        // A measured zero is a figure, thus only an absent value means that nobody
        // measured the turn. The rollup goes absent under its own predicate above,
        // and the duration does not go with it.
        const duration = turnDurationMs ?? null;
        // The two figures describe the turn, and the assistant reply is the row a
        // reader associates with the answer. The LAST assistant row, not any of them: a
        // serial-tool turn writes one assistant row per step and only the last ends
        // the turn. -1 (a turn that persisted no reply — an abort before any output)
        // matches no index below, so nothing is written and the append still succeeds.
        const lastAssistantRow = messages.reduce((last, m, i) => (m.role === "assistant" ? i : last), -1);
        return withTransaction(pool, "thread-history.appendTurn", (client) =>
            // Serialize concurrent appends on this thread — without the lock, two
            // transactions can both read the same MAX(seq) and collide on the
            // (thread_id, seq) primary key. Released automatically at COMMIT/ROLLBACK.
            tryQuery("thread-history.appendTurn.lock", () => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [threadId]))
                .andThen(() =>
                    tryQuery("thread-history.appendTurn.maxSeq", async () => {
                        const { rows } = await client.query<{ max_seq: string }>(
                            "SELECT COALESCE(MAX(seq), -1)::text AS max_seq FROM messages WHERE thread_id = $1",
                            [threadId],
                        );
                        return Number(rows[0]!.max_seq) + 1;
                    }),
                )
                .andThen((startSeq) =>
                    // Insert the turn's messages in order. Each insert chains off the
                    // prior so the first `err` short-circuits — and `withTransaction`
                    // re-throws it to force ROLLBACK (a returned `err` that does not
                    // reach `withTransaction` would COMMIT silently).
                    messages.reduce(
                        (chain, message, i) =>
                            chain.andThen(() =>
                                tryMutation("thread-history.appendTurn.insert", () =>
                                    client.query(
                                        // `message_envelope::json`, never `::jsonb`; `display_envelope` and
                                        // `reported_usage::jsonb`, never `::json` — see the column comments
                                        // in the state-init DDL.
                                        `INSERT INTO messages (thread_id, seq, message_envelope, display_envelope, tokens, reported_usage, turn_duration_ms)
                     VALUES ($1, $2, $3::json, $4::jsonb, $5, $6::jsonb, $7)
                     ON CONFLICT (thread_id, seq) DO UPDATE
                       SET message_envelope = EXCLUDED.message_envelope,
                           display_envelope = EXCLUDED.display_envelope,
                           tokens = EXCLUDED.tokens,
                           reported_usage = EXCLUDED.reported_usage,
                           turn_duration_ms = EXCLUDED.turn_duration_ms`,
                                        [
                                            threadId,
                                            startSeq + i,
                                            serializeEnvelope(message),
                                            i === 0 ? displayEnvelope : null,
                                            countTokens(message.content),
                                            i === lastAssistantRow ? rollup : null,
                                            i === lastAssistantRow ? duration : null,
                                        ],
                                    ),
                                ).map(() => undefined),
                            ),
                        okVoid<DbError>(),
                    ),
                )
                .andThen(() =>
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
                    tryMutation("thread-history.appendTurn.touchThread.savepoint", () => client.query("SAVEPOINT touch_thread"))
                        .andThen(() =>
                            tryMutation("thread-history.appendTurn.touchThread", () =>
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
                            // and the turn commits. Nothing follows in this chain, so COMMIT
                            // releases the savepoint on the success path.
                            tryMutation("thread-history.appendTurn.touchThread.rewind", () => client.query("ROLLBACK TO SAVEPOINT touch_thread"))
                                .map(() => undefined)
                                .orElse(() => okVoid<DbError>()),
                        ),
                ),
        );
    }

    function loadRecent(threadId: string, tokenBudget: number, options?: LoadRecentOptions): ResultAsync<ModelMessage[], DbError> {
        return tryQuery("thread-history.loadRecent", async () => {
            const { rows } = await pool.query<MessageRow>(
                // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
                // `seq::text AS seq` output alias (Postgres resolves an unqualified
                // ORDER BY name to the output column), sorting the bigint as text:
                // "10" before "2". Scrambled order splits a tool-call/tool-result pair
                // across an intervening turn. The qualified name forces the bigint column.
                //
                // `reported_usage` is deliberately NOT selected. Windowing budgets on
                // `tokens` — an offline estimate every row carries — and a turn that
                // reported nothing has no rollup at all, so budgeting on the rollup
                // would silently stop evicting on exactly those threads. The two are
                // different measurements sharing a unit; see the column comments.
                `SELECT seq::text AS seq, message_envelope, tokens
         FROM messages WHERE thread_id = $1 ORDER BY messages.seq ASC`,
                [threadId],
            );
            const parsed = rows.map((row) => ({
                message: parseStoredMessageEnvelope(row.message_envelope, `${threadId}/${row.seq}`).message,
                tokens: row.tokens,
            }));

            const turns = groupTurns(parsed, (row) => isGenuineUserStart(row.message));
            const turnTokens = turns.map((turn) => turn.reduce((sum, row) => sum + row.tokens, 0));
            const threadTotal = turnTokens.reduce((sum, n) => sum + n, 0);

            // Chunked eviction holds the prompt-cache prefix still. The budget alone
            // evicts the OLDEST turns newest-first, so the window START — the stable
            // head of the tools+system+history cache prefix — advances by ~one turn
            // per appended turn; every turn then ships a shifted `messages[0]` and
            // rewrites the whole message cache instead of reading it back (watch
            // `cortex.harness.agent.cache_read_tokens` collapse on long threads).
            // Instead, take the budget-minimal eviction and snap it UP to a whole
            // `EVICTION_BLOCK_TURNS` block: `evicted` stays constant while the minimum
            // sits inside a block and jumps by a block when it crosses, so
            // `messages[0]` is byte-identical for a block of appends (the cache reads
            // survive) and shifts only once per block. Snapping UP retains a subset of
            // the budget-minimal window, so the kept tokens never exceed `tokenBudget`.
            //
            // Budget-minimal fill: walk newest-first, always keeping the most recent
            // turn (a valid over-budget single turn beats an under-budget cut), then
            // add older turns while they fit.
            let included = 0;
            let cumulative = 0;
            for (let t = turns.length - 1; t >= 0; t--) {
                if (included > 0 && cumulative + turnTokens[t]! > tokenBudget) break;
                cumulative += turnTokens[t]!;
                included++;
            }
            const minimalEvicted = turns.length - included;
            // Snap the eviction count up to a block boundary, clamped below the last
            // turn so the most recent turn always ships. Both terms of the min are
            // >= `minimalEvicted`, so `turnsEvicted >= minimalEvicted`: the retained
            // suffix is a subset of the budget-minimal one and stays within budget.
            const turnsEvicted = turns.length === 0 ? 0 : Math.min(Math.ceil(minimalEvicted / EVICTION_BLOCK_TURNS) * EVICTION_BLOCK_TURNS, turns.length - 1);

            // The retained head. The first turn of a report session carries the
            // brief and the copy of the working-memory render, and no tail message
            // replaces them. Thus `keepFirstTurn` puts that turn in front of the
            // retained suffix, and `messages[0]` never moves again. An eviction of
            // zero already holds the first turn at the head, thus the option adds
            // nothing there and the window never carries the turn two times.
            const keepsFirstTurn = options?.keepFirstTurn === true && turnsEvicted > 0;

            const { totalTokens, turnsEvicted: turnsEvictedHist } = getInstruments();
            // A retained head gives one evicted turn back to the window, thus the
            // histogram reports one turn less than the budget walk cut.
            const turnsDropped = keepsFirstTurn ? turnsEvicted - 1 : turnsEvicted;
            // The flag reads the cut of the budget walk, and never the count that
            // the retained head reduced. The two answer different questions: the
            // flag says that the window lost a turn, and the histogram says how
            // many. A walk that cut one block, under a block size of one, drops
            // its whole cut back into the window. The flag must still report the
            // eviction, because the thread crossed its budget.
            const attributes = { eviction: turnsEvicted > 0 };
            totalTokens.record(threadTotal, attributes);
            turnsEvictedHist.record(turnsDropped, attributes);

            const retained = turns.slice(turnsEvicted);
            return (keepsFirstTurn ? [turns[0]!, ...retained] : retained).flat().map((row) => row.message);
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
            // sound because this column has exactly one writer — `appendTurn` above,
            // from a `TokenUsageRollup` — and null is preserved as null by the
            // spread below rather than read as a rollup.
            reported_usage: TokenUsageRollup | null;
            // The driver hands a bigint back as text, and the `::text` cast below
            // says so. `Number` makes the crossing in one place — the way every
            // other read of a bigint column in this module does.
            turn_duration_ms: string | null;
        }>(
            // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
            // `seq::text AS seq` output alias (Postgres resolves an unqualified
            // ORDER BY name to the output column), sorting the bigint as text:
            // "10" before "2". The qualified name forces the bigint column.
            `SELECT seq::text AS seq, message_envelope, display_envelope, reported_usage, turn_duration_ms::text AS turn_duration_ms
         FROM messages WHERE thread_id = $1
         ORDER BY messages.seq ASC`,
            [threadId],
        );

        // Spread rather than `usage: r.reported_usage ?? undefined`, so a row with
        // no rollup carries no `usage` KEY at all — absent, not present-and-undefined.
        // The duration obeys the same rule, and it reads from its own column.
        const stored: StoredMessage[] = await Promise.all(
            rows.map(async (r) => {
                const envelope = parseStoredMessageEnvelope(r.message_envelope, `${threadId}/${r.seq}`);
                const displayEnvelope =
                    r.display_envelope == null ? undefined : await parseStoredDisplayEnvelope(r.display_envelope, `${threadId}/${r.seq}/display`);
                return {
                    seq: Number(r.seq),
                    envelope,
                    message: envelope.message,
                    ...(displayEnvelope ? { displayEnvelope } : {}),
                    ...(r.reported_usage === null ? {} : { usage: r.reported_usage }),
                    ...(r.turn_duration_ms === null ? {} : { durationMs: Number(r.turn_duration_ms) }),
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
                    ).map<RetractOutcome>((res) => ({ kind: "retracted", messages: res.rowCount ?? 0 }));
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

    return { appendTurn, loadRecent, loadAll, retractLastTurn, latestSeq, latestTurnAt, countUserTurnsAfter };
}
