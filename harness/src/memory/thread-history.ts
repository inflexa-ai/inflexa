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

import type { ModelMessage } from "ai";
import { type Histogram, metrics } from "@opentelemetry/api";
import { ResultAsync, ok } from "neverthrow";
import type { Pool } from "pg";

import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";
import { countTokens } from "./count-tokens.js";
import { envelopeMessage, parseStoredMessageEnvelope, type StoredMessageEnvelope } from "./ai-sdk-message-storage.js";

/** A resolved `ok(undefined)` ResultAsync — the empty/seed transaction step. */
function okVoid<E = DbError>(): ResultAsync<void, E> {
    return new ResultAsync(Promise.resolve(ok<void, E>(undefined)));
}

interface MessageRow {
    readonly seq: string;
    readonly message_envelope: unknown;
    readonly tokens: number;
}

/** One stored message, as returned by the display read (`loadPage`). */
export interface StoredMessage {
    readonly seq: number;
    readonly envelope: StoredMessageEnvelope;
    readonly message: ModelMessage;
}

/**
 * A page of stored messages plus pagination metadata. Pagination is
 * turn-based: `total` is the thread's turn count and `page`/`perPage` index
 * turns, while `messages` is the flattened rows of the page's turns.
 */
export interface MessagePage {
    readonly messages: StoredMessage[];
    readonly total: number;
    readonly page: number;
    readonly perPage: number;
    readonly hasMore: boolean;
}

/**
 * The conversation message store. Two methods, by design — no generic row
 * insert (see the harness-thread-store spec). `threadId` is the conversation scope — one UI thread.
 */
export interface ThreadHistory {
    /**
     * Append one conversation turn — every message written in a single
     * transaction with a `seq` monotonically increasing per thread.
     */
    appendTurn(threadId: string, messages: readonly ModelMessage[]): ResultAsync<void, DbError>;
    /**
     * Return a recent-turns window that fits `tokenBudget`, oldest-first,
     * snapped to a valid AI SDK model-message sequence. The window START advances
     * in whole `EVICTION_BLOCK_TURNS` blocks (see the constant) so the prompt-cache
     * prefix stays byte-stable across appends; the window may therefore carry a
     * little less than the budget would strictly allow, but never more.
     */
    loadRecent(threadId: string, tokenBudget: number): ResultAsync<ModelMessage[], DbError>;
    /**
     * Return one page of a thread's messages oldest-first for UI display —
     * NOT token-windowed (that is `loadRecent`'s job for the agent loop). No
     * eviction. Paginated by whole turns: `page`, `perPage`, and `total` count
     * turns, not rows, so a multi-row turn always reloads intact. `messages`
     * holds the flattened rows of the selected turns.
     */
    loadPage(threadId: string, page: number, perPage: number): ResultAsync<MessagePage, DbError>;
}

/**
 * A turn starts on a `user` message. In AI SDK message terms tool results
 * are `tool`-role messages, so a mid-turn tool continuation never carries
 * the `user` role and cannot open a turn.
 */
function isGenuineUserStart(message: ModelMessage): boolean {
    return message.role === "user";
}

/**
 * Group rows (oldest-first) into turns at genuine-user-start boundaries.
 * Generic over the row shape so the token-windowed read (`loadRecent`) and
 * the display read (`loadPage`) share it, each supplying its own start
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
    function appendTurn(threadId: string, messages: readonly ModelMessage[]): ResultAsync<void, DbError> {
        if (messages.length === 0) return okVoid();
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
                                        `INSERT INTO messages (thread_id, seq, message_envelope, tokens)
                     VALUES ($1, $2, $3::jsonb, $4)
                     ON CONFLICT (thread_id, seq) DO UPDATE
                       SET message_envelope = EXCLUDED.message_envelope,
                           tokens = EXCLUDED.tokens`,
                                        [threadId, startSeq + i, JSON.stringify(envelopeMessage(message)), countTokens(message.content)],
                                    ),
                                ).map(() => undefined),
                            ),
                        okVoid<DbError>(),
                    ),
                ),
        );
    }

    function loadRecent(threadId: string, tokenBudget: number): ResultAsync<ModelMessage[], DbError> {
        return tryQuery("thread-history.loadRecent", async () => {
            const { rows } = await pool.query<MessageRow>(
                // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
                // `seq::text AS seq` output alias (Postgres resolves an unqualified
                // ORDER BY name to the output column), sorting the bigint as text:
                // "10" before "2". Scrambled order splits a tool-call/tool-result pair
                // across an intervening turn. The qualified name forces the bigint column.
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

            const { totalTokens, turnsEvicted: turnsEvictedHist } = getInstruments();
            const attributes = { eviction: turnsEvicted > 0 };
            totalTokens.record(threadTotal, attributes);
            turnsEvictedHist.record(turnsEvicted, attributes);

            return turns
                .slice(turnsEvicted)
                .flat()
                .map((row) => row.message);
        });
    }

    function loadPage(threadId: string, page: number, perPage: number): ResultAsync<MessagePage, DbError> {
        const safePerPage = Math.min(Math.max(perPage, 1), 200);
        const safePage = Math.max(page, 0);

        return tryQuery("thread-history.loadPage", async () => {
            // Display pages are turn-bounded, not row-bounded. A serial-tool assistant
            // turn is persisted as one row per step (plus its tool_result `user` rows),
            // so a row-windowed page could split a turn — truncating the trailing
            // report card/text out of the page the UI fetches. Read the thread, group
            // into turns, and slice whole turns so a turn always reloads intact.
            // Threads are conversation-scoped and bounded, so reading every row here
            // matches `loadRecent`'s existing whole-thread read.
            const { rows } = await pool.query<{
                seq: string;
                message_envelope: unknown;
            }>(
                // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
                // `seq::text AS seq` output alias (Postgres resolves an unqualified
                // ORDER BY name to the output column), sorting the bigint as text:
                // "10" before "2". The qualified name forces the bigint column.
                `SELECT seq::text AS seq, message_envelope
         FROM messages WHERE thread_id = $1
         ORDER BY messages.seq ASC`,
                [threadId],
            );

            const stored: StoredMessage[] = rows.map((r) => {
                const envelope = parseStoredMessageEnvelope(r.message_envelope, `${threadId}/${r.seq}`);
                return { seq: Number(r.seq), envelope, message: envelope.message };
            });

            const turns = groupTurns(stored, (row) => isGenuineUserStart(row.message));
            const total = turns.length;
            const offset = safePage * safePerPage;
            const pageTurns = turns.slice(offset, offset + safePerPage);

            return {
                messages: pageTurns.flat(),
                total,
                page: safePage,
                perPage: safePerPage,
                hasMore: offset + pageTurns.length < total,
            };
        });
    }

    return { appendTurn, loadRecent, loadPage };
}
