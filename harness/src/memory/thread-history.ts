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
 * The window is always a valid Anthropic message sequence: it begins on a
 * `user` message that is genuine user input — never a `tool_result`
 * continuation — and never splits a `tool_use`/`tool_result` pair. The turn
 * is the atomic unit; `appendTurn` writes one atomically and `loadRecent`
 * rounds the budget walk to turn boundaries.
 */

import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { type Histogram, metrics } from "@opentelemetry/api";
import { ResultAsync, ok } from "neverthrow";
import type { Pool } from "pg";

import { type DbError, tryMutation, tryQuery, withTransaction } from "../lib/db-result.js";
import { countTokens } from "./count-tokens.js";

/** A resolved `ok(undefined)` ResultAsync — the empty/seed transaction step. */
function okVoid<E = DbError>(): ResultAsync<void, E> {
    return new ResultAsync(Promise.resolve(ok<void, E>(undefined)));
}

/** The stored shape of one message's content — Anthropic-shaped JSONB. */
type StoredContent = string | ContentBlockParam[];

interface MessageRow {
    readonly role: string;
    readonly content_jsonb: StoredContent;
    readonly tokens: number;
}

/** One stored message, as returned by the display read (`loadPage`). */
export interface StoredMessage {
    readonly seq: number;
    readonly role: string;
    readonly content: StoredContent;
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
    appendTurn(threadId: string, messages: readonly MessageParam[]): ResultAsync<void, DbError>;
    /**
     * Return the most recent messages whose cumulative `tokens` fit
     * `tokenBudget`, oldest-first, snapped to a valid Anthropic sequence.
     */
    loadRecent(threadId: string, tokenBudget: number): ResultAsync<MessageParam[], DbError>;
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
 * A turn starts on a `user` message that is genuine user input — string
 * content, or a content array with no `tool_result` block. A `user` message
 * carrying `tool_result` blocks is a mid-turn tool continuation, not a
 * boundary.
 */
function isGenuineUserStart(role: string, content: StoredContent): boolean {
    if (role !== "user") return false;
    if (typeof content === "string") return true;
    return !content.some((block) => block.type === "tool_result");
}

/**
 * Group rows (oldest-first) into turns at genuine-user-start boundaries.
 * Generic over the row shape so both the token-windowed read (`MessageRow`,
 * content under `content_jsonb`) and the display read (`StoredMessage`, content
 * under `content`) share it, each supplying its own start predicate.
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
 * Create a `ThreadHistory` bound to a Postgres pool — a factory closure
 * capturing `pool` (dependency injection per the harness-durable-runtime spec). The `messages` table is
 * provisioned by the project's state-init DDL.
 */
export function createThreadHistory(pool: Pool): ThreadHistory {
    function appendTurn(threadId: string, messages: readonly MessageParam[]): ResultAsync<void, DbError> {
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
                                        `INSERT INTO messages (thread_id, seq, role, content_jsonb, tokens)
                     VALUES ($1, $2, $3, $4::jsonb, $5)`,
                                        [threadId, startSeq + i, message.role, JSON.stringify(message.content), countTokens(message.content)],
                                    ),
                                ).map(() => undefined),
                            ),
                        okVoid<DbError>(),
                    ),
                ),
        );
    }

    function loadRecent(threadId: string, tokenBudget: number): ResultAsync<MessageParam[], DbError> {
        return tryQuery("thread-history.loadRecent", async () => {
            const { rows } = await pool.query<MessageRow>(
                `SELECT role, content_jsonb, tokens
         FROM messages WHERE thread_id = $1 ORDER BY seq ASC`,
                [threadId],
            );

            const turns = groupTurns(rows, (row) => isGenuineUserStart(row.role, row.content_jsonb));
            const turnTokens = turns.map((turn) => turn.reduce((sum, row) => sum + row.tokens, 0));
            const threadTotal = turnTokens.reduce((sum, n) => sum + n, 0);

            // Walk turns newest-first, accumulating token cost. The most recent turn
            // is always included — even if it alone exceeds the budget, a valid
            // sequence beats an under-budget one. Older turns join while they fit.
            let included = 0;
            let cumulative = 0;
            for (let t = turns.length - 1; t >= 0; t--) {
                if (included > 0 && cumulative + turnTokens[t]! > tokenBudget) break;
                cumulative += turnTokens[t]!;
                included++;
            }
            const turnsEvicted = turns.length - included;

            const { totalTokens, turnsEvicted: turnsEvictedHist } = getInstruments();
            const attributes = { eviction: turnsEvicted > 0 };
            totalTokens.record(threadTotal, attributes);
            turnsEvictedHist.record(turnsEvicted, attributes);

            return turns
                .slice(turns.length - included)
                .flat()
                .map((row) => ({
                    role: row.role as MessageParam["role"],
                    content: row.content_jsonb,
                }));
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
                role: string;
                content_jsonb: StoredContent;
            }>(
                // ORDER BY must qualify `messages.seq` — a bare `seq` would bind to the
                // `seq::text AS seq` output alias (Postgres resolves an unqualified
                // ORDER BY name to the output column), sorting the bigint as text:
                // "10" before "2". The qualified name forces the bigint column.
                `SELECT seq::text AS seq, role, content_jsonb
         FROM messages WHERE thread_id = $1
         ORDER BY messages.seq ASC`,
                [threadId],
            );

            const stored: StoredMessage[] = rows.map((r) => ({
                seq: Number(r.seq),
                role: r.role,
                content: r.content_jsonb,
            }));

            const turns = groupTurns(stored, (row) => isGenuineUserStart(row.role, row.content));
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
