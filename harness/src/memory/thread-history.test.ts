import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { isInterruptedMessage, markInterruptedMessage, syntheticUserMessage } from "./ai-sdk-message-storage.js";
import { countTokens } from "./count-tokens.js";
import { __resetThreadHistoryMetricsForTest, createThreadHistory, EVICTION_BLOCK_TURNS, type ThreadHistory } from "./thread-history.js";
import { createThreadStore } from "./thread-store.js";

const THREAD = "analysis-thread-1";
const ANALYSIS = "analysis-1";

// --- message builders -------------------------------------------------------

function userText(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}
function assistantText(text: string): ModelMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
}
function assistantToolUse(id: string, name: string, input: unknown): ModelMessage {
    return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: name, input }] };
}
function userToolResult(id: string, content: string): ModelMessage {
    return {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: "legacy_tool", output: { type: "text", value: content } }],
    };
}
function assistantThinking(thinking: string, signature: string): ModelMessage {
    return { role: "assistant", content: [{ type: "reasoning", text: thinking, providerOptions: { anthropic: { signature } } }] };
}

/** Token cost of a turn — the same per-message count `appendTurn` stamps. */
function turnCost(messages: readonly ModelMessage[]): number {
    return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

/** Assert a loaded window is a valid AI SDK model-message sequence. */
function assertValidSequence(messages: readonly ModelMessage[]): void {
    const first = messages[0];
    expect(first).toBeDefined();
    expect(first!.role).toBe("user");
    const seenToolUse = new Set<string>();
    for (const m of messages) {
        if (typeof m.content === "string") continue;
        for (const b of m.content) {
            if (b.type === "tool-call") seenToolUse.add(b.toolCallId);
            if (b.type === "tool-result") {
                expect(seenToolUse.has((b as ToolResultPart).toolCallId)).toBe(true);
            }
        }
    }
}

/** Total token cost of a flat window — the sum `loadRecent` budgets against. */
function windowCost(messages: readonly ModelMessage[]): number {
    return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

/**
 * A fixed-cost two-message turn tagged by a single-token `label`, so every turn
 * costs the same while its opening `user` message stays unique — letting a test
 * detect exactly when the window START (`messages[0]`) shifts.
 */
function labeledTurn(label: string): ModelMessage[] {
    return [userText(`question ${label} about the staged dataset here`), assistantText(`answer ${label} about the staged dataset here`)];
}

// --- metric harness ---------------------------------------------------------

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let meterProvider: MeterProvider;

async function collectMetrics(): Promise<MetricData[]> {
    await meterProvider.forceFlush();
    return exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics);
}

// --- fixtures ---------------------------------------------------------------

let pool: Pool;
let drop: () => Promise<void>;
let history: ThreadHistory;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("thread-history"));
    history = createThreadHistory(pool);

    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 3_600_000,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
    __resetThreadHistoryMetricsForTest();
});

afterEach(async () => {
    await meterProvider?.shutdown();
    metrics.disable();
    __resetThreadHistoryMetricsForTest();
    await drop?.();
});

// --- round-trip -------------------------------------------------------------

describe("appendTurn / loadRecent round-trip", () => {
    it("returns appended messages oldest-first with monotonic seq", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), assistantText("answer two")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();
        expect(loaded).toEqual([...turn1, ...turn2]);

        const { rows } = await pool.query<{ seq: string }>("SELECT seq FROM messages WHERE thread_id = $1 ORDER BY seq ASC", [THREAD]);
        const seqs = rows.map((r) => Number(r.seq));
        expect(seqs).toEqual([0, 1, 2, 3]);
        for (let i = 1; i < seqs.length; i++) {
            expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
        }
    });

    it("preserves a thinking block signature byte-identical", async () => {
        const signature = "Ev4BCkYIBx+gC/sig/abc==DEF09+xyz";
        (await history.appendTurn(THREAD, [userText("reason about this"), assistantThinking("step-by-step reasoning", signature)]))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();
        const reasoning = loaded.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).find((b) => b.type === "reasoning");
        expect(reasoning).toMatchObject({
            type: "reasoning",
            providerOptions: { anthropic: { signature } },
        });
    });

    it("returns an empty array for a thread with no messages", async () => {
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual([]);
    });
});

// --- marshalling fidelity (prompt-cache regression guard) -------------------

/**
 * Assert a loaded window matches what was sent as SERIALIZED BYTES — the form
 * the provider receives, and the form its prompt cache keys on. `toEqual` is
 * key-order-blind and cannot see a store that re-sorts object keys, which is
 * exactly what a re-sent prefix must not do.
 */
function assertMarshalsVerbatim(sent: readonly ModelMessage[], loaded: readonly ModelMessage[]): void {
    expect(loaded).toHaveLength(sent.length);
    for (const [i, message] of sent.entries()) {
        expect(JSON.stringify(loaded[i])).toBe(JSON.stringify(message));
    }
}

describe("envelope marshalling fidelity", () => {
    it("re-sends a persisted tool-calling turn byte-identical to the turn it stored", async () => {
        // Keys deliberately out of alphabetical and length order — a store that
        // sorts them rewrites every one of these payloads.
        const turn: ModelMessage[] = [
            userText("profile the staged counts matrix"),
            assistantToolUse("toolu_1", "execute_command", {
                script: "summarize.R",
                timeout: 600,
                env: { OMP_NUM_THREADS: "4", R_LIBS: "/mnt/libs" },
            }),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "toolu_1",
                        toolName: "execute_command",
                        output: { type: "json", value: { stdout: "done", exitCode: 0, artifacts: ["counts.rds"] } },
                    },
                ],
            },
            assistantText("The matrix has 18,204 genes across 12 samples."),
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        assertMarshalsVerbatim(turn, (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap());
    });

    it("preserves key order in every free-form payload a ModelMessage can carry", async () => {
        // The three payloads with no schema to be normalized back against on read:
        // a tool call's `input`, a json tool result's `value`, a `providerOptions` bag.
        const turn: ModelMessage[] = [
            {
                role: "user",
                content: "run it",
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
            },
            assistantToolUse("toolu_2", "write_file", { path: "/a/b.R", mode: "w", content: "x", nested: { z: 1, a: 2 } }),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "toolu_2",
                        toolName: "write_file",
                        output: { type: "json", value: { zebra: 1, alpha: 2, nested: { z: "last", a: "first" } } },
                    },
                ],
            },
            {
                role: "assistant",
                content: [{ type: "reasoning", text: "weighing options", providerOptions: { anthropic: { signature: "SIG-abc==", zebra: "z", alpha: "a" } } }],
            },
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        assertMarshalsVerbatim(turn, (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap());
    });

    it("holds the earlier turns of a thread byte-identical as later turns land on top", async () => {
        // The cache guarantee end to end: a prefix already sent reads back
        // unchanged after more turns land behind it.
        const turn1 = [userText("first question"), assistantToolUse("toolu_3", "search_gene", { symbol: "EGFR", species: "human", limit: 5 })];
        const turn2 = [userToolResult("toolu_3", JSON.stringify({ hits: 3 })), assistantText("EGFR is well characterized.")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        const afterFirst = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();

        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();
        const afterSecond = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();

        assertMarshalsVerbatim(turn1, afterFirst);
        expect(JSON.stringify(afterSecond.slice(0, turn1.length))).toBe(JSON.stringify(afterFirst));
        assertMarshalsVerbatim([...turn1, ...turn2], afterSecond);
    });

    it("drops a NUL byte from a tool result instead of losing the whole turn", async () => {
        // A `jsonb` column rejected the insert outright, taking the turn's whole
        // transaction with it; a `json` column stores the byte but then refuses to
        // run the boundary predicate's JSON operators over that row. So the write
        // scrubs it: the turn survives, and its tail stays retractable. The loop
        // strips NUL where it builds a tool result, so on the harness's own path
        // the stored row and the message it sent live are already identical.
        const NUL = String.fromCharCode(0);
        (await history.appendTurn(THREAD, [userText("read the binary header"), userToolResult("toolu_4", `MAGIC${NUL}rest`)]))._unsafeUnwrap();

        assertMarshalsVerbatim(
            [userText("read the binary header"), userToolResult("toolu_4", "MAGICrest")],
            (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap(),
        );
        expect((await history.retractLastTurn(THREAD))._unsafeUnwrap()).toEqual({ kind: "retracted", messages: 2 });
    });
});

// --- thread activity --------------------------------------------------------

describe("appendTurn thread activity", () => {
    it("bumps the thread's updated_at so the listing orders by activity, not by creation", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: "older", analysisId: ANALYSIS, title: "Older" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "newer", analysisId: ANALYSIS, title: "Newer" }))._unsafeUnwrap();

        // Creation order alone puts "newer" on top — the precondition that makes
        // the post-append order below a real reorder rather than a coincidence.
        const before = (await store.listThreads({ analysisId: ANALYSIS }))._unsafeUnwrap();
        expect(before.threads.map((t) => t.threadId)).toEqual(["newer", "older"]);
        const newerUpdatedAt = before.threads.find((t) => t.threadId === "newer")!.updatedAt;
        const olderBefore = before.threads.find((t) => t.threadId === "older")!.updatedAt;

        (await history.appendTurn("older", [userText("question one"), assistantText("answer one")]))._unsafeUnwrap();

        const after = (await store.listThreads({ analysisId: ANALYSIS }))._unsafeUnwrap();
        expect(after.threads.map((t) => t.threadId)).toEqual(["older", "newer"]);
        // Assert on the touched row itself. Reading the head of the listing
        // instead compares "older" against a bound it already cleared before the
        // append — a touch that did nothing at all would still satisfy it.
        const olderAfter = after.threads.find((t) => t.threadId === "older")!.updatedAt;
        expect(olderAfter.getTime()).toBeGreaterThan(olderBefore.getTime());
        expect(olderAfter.getTime()).toBeGreaterThan(newerUpdatedAt.getTime());
    });

    it("persists the turn when the metadata touch itself fails", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS, title: "Touch fails" }))._unsafeUnwrap();

        // Every UPDATE on the metadata table now raises, so the touch fails while
        // the turn's transaction is still open — the case that must cost nothing
        // but the breadcrumb.
        await pool.query(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated update failure'; END; $$ LANGUAGE plpgsql`);
        await pool.query("CREATE TRIGGER boom_trg BEFORE UPDATE ON cortex_analysis_threads FOR EACH ROW EXECUTE FUNCTION boom()");

        const turn = [userText("question one"), assistantText("answer one")];
        const appended = await history.appendTurn(THREAD, turn);
        expect(appended.isOk()).toBe(true);

        // The turn committed with the failed touch rolled back out of it, not
        // alongside it: both rows are readable.
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual(turn);
        const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM messages WHERE thread_id = $1", [THREAD]);
        expect(Number(rows[0]!.count)).toBe(turn.length);
    });

    it("leaves a soft-deleted thread's tombstone unmoved while persisting the turn", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS, title: "Deleted" }))._unsafeUnwrap();
        (await store.deleteThread(THREAD))._unsafeUnwrap();

        // Read the timestamp as text: the driver parses `timestamptz` into a JS
        // `Date`, and at millisecond resolution a bump this fast can land inside
        // the same tick as the row's prior value.
        const readTombstone = async () =>
            (
                await pool.query<{ deleted_at: Date | null; updated_at: string }>(
                    "SELECT deleted_at, updated_at::text AS updated_at FROM cortex_analysis_threads WHERE thread_id = $1",
                    [THREAD],
                )
            ).rows[0]!;
        const before = await readTombstone();

        const turn = [userText("question one"), assistantText("answer one")];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        // A deleted thread keeps its messages, so the turn still lands — but the
        // tombstone is not a live row and the touch must neither revive it nor
        // advance its activity clock.
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual(turn);
        const after = await readTombstone();
        expect(after.deleted_at).not.toBeNull();
        expect(after.updated_at).toBe(before.updated_at);
    });

    it("persists the turn for a thread that has no metadata row", async () => {
        const turn = [userText("question one"), assistantText("answer one")];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual(turn);

        const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM cortex_analysis_threads WHERE thread_id = $1", [THREAD]);
        expect(Number(rows[0]!.count)).toBe(0);
    });
});

// --- token windowing --------------------------------------------------------

describe("loadRecent token windowing", () => {
    it("evicts the oldest turns, keeping a within-budget window that ends at the most recent turn", async () => {
        const K = EVICTION_BLOCK_TURNS;
        const turns = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            .slice(0, 3 * K)
            .split("")
            .map(labeledTurn);
        for (const turn of turns) {
            (await history.appendTurn(THREAD, turn))._unsafeUnwrap();
        }

        // Budget fits only K of the 3K equal-cost turns, so the thread is well
        // over budget and the oldest turns must be evicted.
        const budget = K * turnCost(turns[0]!);
        const loaded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();

        assertValidSequence(loaded);
        // The retained window never exceeds the budget...
        expect(windowCost(loaded)).toBeLessThanOrEqual(budget);
        // ...always ends at the most recent turn...
        expect(loaded.slice(-2)).toEqual(turns.at(-1)!);
        // ...and is a genuine window, not the whole thread.
        expect(loaded.length).toBeLessThan(turns.flat().length);
    });

    it("returns an oversized single turn in full", async () => {
        const small = [userText("hi"), assistantText("hello")];
        const oversized = [
            userText("a long and detailed multi-part research question"),
            assistantToolUse("toolu_1", "search_gene", { symbol: "TP53" }),
            userToolResult("toolu_1", JSON.stringify({ hits: 12, genes: ["TP53"] })),
            assistantText("a thorough synthesis of every result returned above"),
        ];
        (await history.appendTurn(THREAD, small))._unsafeUnwrap();
        (await history.appendTurn(THREAD, oversized))._unsafeUnwrap();

        // Budget far below the most recent turn's own cost.
        const loaded = (await history.loadRecent(THREAD, 1))._unsafeUnwrap();

        expect(loaded).toEqual(oversized);
        assertValidSequence(loaded);
    });
});

// --- prefix stability (prompt-cache regression guard) -----------------------

describe("loadRecent prefix stability", () => {
    it("holds messages[0] byte-identical across a block of appends, shifting only on block boundaries", async () => {
        const K = EVICTION_BLOCK_TURNS;
        const turns = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            .slice(0, 3 * K + 2)
            .split("")
            .map(labeledTurn);

        // Equal per-turn cost is the precondition the block math relies on — a
        // single-token label keeps every turn the same size.
        const costs = turns.map(turnCost);
        expect(new Set(costs).size).toBe(1);
        const perTurn = costs[0]!;

        // Budget fits exactly K+1 newest turns; the (K+2)th present turn is the
        // first that must be evicted.
        const fitTurns = K + 1;
        const budget = fitTurns * perTurn;

        // Seed right up to the budget: whole thread returned, window opens on the
        // very first turn.
        for (let i = 0; i < fitTurns; i++) {
            (await history.appendTurn(THREAD, turns[i]!))._unsafeUnwrap();
        }
        const seeded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();
        expect(seeded).toEqual(turns.slice(0, fitTurns).flat());

        // Now append past the budget, capturing the window's first message after
        // each append. Two full blocks show the pattern: stable, jump, stable.
        const appendsToObserve = 2 * K + 1;
        const firstMessages: string[] = [];
        for (let i = fitTurns; i < fitTurns + appendsToObserve; i++) {
            (await history.appendTurn(THREAD, turns[i]!))._unsafeUnwrap();
            const loaded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();
            assertValidSequence(loaded);
            expect(windowCost(loaded)).toBeLessThanOrEqual(budget);
            // The most recent turn is always present, whatever the window start.
            expect(loaded.slice(-2)).toEqual(turns[i]!);
            firstMessages.push(JSON.stringify(loaded[0]));
        }

        // The regression guard: messages[0] must NOT advance every append. Within
        // each block of K appends it is byte-identical; it changes exactly once,
        // at the block boundary.
        for (let j = 1; j < K; j++) {
            expect(firstMessages[j]).toBe(firstMessages[0]!);
        }
        expect(firstMessages[K]).not.toBe(firstMessages[K - 1]!);
        for (let j = K + 1; j < 2 * K; j++) {
            expect(firstMessages[j]).toBe(firstMessages[K]!);
        }

        // Over 2K+1 appends a naive per-turn window would show 2K+1 distinct
        // starts; the chunked window shows just three (two full blocks + the
        // start of a third).
        expect(new Set(firstMessages).size).toBe(3);
    });
});

// --- boundary snapping ------------------------------------------------------

describe("loadRecent boundary snapping", () => {
    it("snaps past an orphan tool_result to a genuine user turn", async () => {
        const turn1 = [
            userText("question that needs a tool call"),
            assistantToolUse("toolu_a", "search_gene", { symbol: "EGFR" }),
            userToolResult("toolu_a", JSON.stringify({ hits: 3 })),
            assistantText("answer grounded in the tool result"),
        ];
        const turn2 = [userText("a simple follow-up question"), assistantText("a simple follow-up answer")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // A naive newest-first cut at this budget would include turn2 plus the
        // tail of turn1 — landing the window start on turn1's tool_result-only
        // user message. The snap drops the partial turn1 entirely.
        const budget = turnCost(turn2) + countTokens(turn1[3]!.content);
        const loaded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();

        expect(loaded).toEqual(turn2);
        assertValidSequence(loaded);
    });

    it("never splits a tool_use / tool_result pair", async () => {
        const turn1 = [userText("opening question"), assistantText("opening answer")];
        const turn2 = [
            userText("question driving a tool call"),
            assistantToolUse("toolu_x", "search_pathway", { id: "R-HSA-1" }),
            userToolResult("toolu_x", JSON.stringify({ pathway: "apoptosis" })),
            assistantText("final answer using the pathway result"),
        ];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // Budget lands between the tool_use and its tool_result if walked
        // message-by-message. The turn-atomic window keeps the pair together.
        const budget = countTokens(turn2[2]!.content) + countTokens(turn2[3]!.content);
        const loaded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();

        expect(loaded).toEqual(turn2);
        assertValidSequence(loaded);

        const toolUseIdx = loaded.findIndex((m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool-call"));
        const toolResultIdx = loaded.findIndex((m) => m.role === "tool" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool-result"));
        expect(toolUseIdx).toBeGreaterThanOrEqual(0);
        expect(toolResultIdx).toBe(toolUseIdx + 1);
    });
});

// --- numeric seq ordering ---------------------------------------------------

describe("loadRecent numeric seq ordering", () => {
    it("orders by numeric seq across the 9->10 boundary, keeping a tool pair intact", async () => {
        // Fill seq 0..7 with four plain turns so the tool turn lands on seq 8..11
        // — its assistant tool-call at seq 9 and matching tool-result at seq 10
        // straddle the 9->10 boundary. A lexicographic ORDER BY seq (bug) sorts
        // "10" before "2" and pushes "9" to the tail, separating the pair with
        // user messages between them; a numeric ORDER BY keeps insertion order.
        const plainTurns = [
            [userText("first question here"), assistantText("first answer here")],
            [userText("second question here"), assistantText("second answer here")],
            [userText("third question here"), assistantText("third answer here")],
            [userText("fourth question here"), assistantText("fourth answer here")],
        ];
        const toolTurn = [
            userText("fifth question driving a tool call"),
            assistantToolUse("toolu_boundary", "search_gene", { symbol: "BRCA1" }),
            userToolResult("toolu_boundary", JSON.stringify({ hits: 7 })),
            assistantText("fifth answer grounded in the tool result"),
        ];
        const inOrder = [...plainTurns, toolTurn];
        for (const turn of inOrder) {
            (await history.appendTurn(THREAD, turn))._unsafeUnwrap();
        }

        // Budget far above the whole thread — every turn is included, so the only
        // thing under test is the read's ordering.
        const loaded = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();

        // Ascending numeric seq == insertion order, which we control end to end.
        expect(loaded).toEqual(inOrder.flat());
        assertValidSequence(loaded);

        const toolUseIdx = loaded.findIndex((m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool-call"));
        const toolResultIdx = loaded.findIndex((m) => m.role === "tool" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool-result"));
        expect(toolUseIdx).toBeGreaterThanOrEqual(0);
        // The tool-result sits immediately after its tool-call — no user/system
        // message wedged between them by a scrambled order.
        expect(toolResultIdx).toBe(toolUseIdx + 1);
    });
});

// --- overflow metric --------------------------------------------------------

describe("loadRecent overflow metric", () => {
    it("reports no eviction for a thread under budget", async () => {
        (await history.appendTurn(THREAD, [userText("a small question"), assistantText("a small answer")]))._unsafeUnwrap();
        (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();

        const collected = await collectMetrics();
        const evicted = collected.find((m) => m.descriptor.name === "cortex.harness.thread.turns_evicted");
        expect(evicted).toBeDefined();
        const evictedPoint = evicted!.dataPoints[0]!;
        expect((evictedPoint.value as { sum: number }).sum).toBe(0);
        expect(evictedPoint.attributes.eviction).toBe(false);

        const total = collected.find((m) => m.descriptor.name === "cortex.harness.thread.total_tokens");
        expect(total).toBeDefined();
        expect((total!.dataPoints[0]!.value as { sum: number }).sum).toBeGreaterThan(0);
    });

    it("reports the evicted-turn count for a thread over budget", async () => {
        const turn1 = [userText("question one here"), assistantText("answer one here")];
        const turn2 = [userText("question two here"), assistantText("answer two here")];
        const turn3 = [userText("question three here"), assistantText("answer three here")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn3))._unsafeUnwrap();

        // Only the most recent turn fits — turns 1 and 2 are evicted.
        (await history.loadRecent(THREAD, turnCost(turn3)))._unsafeUnwrap();

        const collected = await collectMetrics();
        const evicted = collected.find((m) => m.descriptor.name === "cortex.harness.thread.turns_evicted");
        expect(evicted).toBeDefined();
        const evictedPoint = evicted!.dataPoints[0]!;
        expect((evictedPoint.value as { sum: number }).sum).toBe(2);
        expect(evictedPoint.attributes.eviction).toBe(true);
    });
});

// --- retractLastTurn --------------------------------------------------------

describe("retractLastTurn", () => {
    it("removes the last appended turn and restores the exact pre-append window", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), assistantText("answer two")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // Snapshot the window, append one more (single-message) turn, then retract
        // it: the byte-stable prefix guarantee only holds if the retracted tail
        // restores the exact prior row set.
        const before = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();

        (await history.appendTurn(THREAD, [userText("question three")]))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 1 });

        const after = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();
        expect(after).toEqual(before);
    });

    it("removes a multi-row tail turn whole, leaving the prior turn as the tail", async () => {
        const turn1 = [userText("opening question"), assistantText("opening answer")];
        const turn2 = [
            userText("question driving a tool call"),
            assistantToolUse("toolu_x", "search_pathway", { id: "R-HSA-1" }),
            userToolResult("toolu_x", JSON.stringify({ pathway: "apoptosis" })),
            assistantText("final answer using the pathway result"),
        ];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // The turn's tool-result row is `tool`-role, not `user`, so the turn opens
        // on its single user message: all four rows sit at or past that boundary
        // and come off together.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 4 });

        const page = (await history.loadPage(THREAD, 0, 50))._unsafeUnwrap();
        expect(page.total).toBe(1);
        expect(page.messages.map((m) => m.message)).toEqual(turn1);
    });

    it("reports empty-thread and deletes nothing when the thread has no rows", async () => {
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "empty-thread" });
    });

    it("refuses a thread whose rows carry no user-role message, deleting nothing", async () => {
        // Rows that never open a turn are anomalous data: retract refuses them
        // rather than emptying the thread. Appending an assistant-only "turn"
        // stages exactly that shape without a direct SQL insert.
        (await history.appendTurn(THREAD, [assistantText("orphan one"), assistantText("orphan two")]))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "no-user-turn" });

        const { rows } = await pool.query<{ seq: string }>("SELECT seq FROM messages WHERE thread_id = $1 ORDER BY seq ASC", [THREAD]);
        expect(rows.map((r) => Number(r.seq))).toEqual([0, 1]);
    });

    it("walks turns back to empty across repeated retracts", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), assistantText("answer two")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // First retract takes the newest turn off; the prior turn is now the tail.
        const first = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(first).toEqual({ kind: "retracted", messages: turn2.length });
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual(turn1);

        // Second retract takes the remaining turn off; the thread is now empty.
        const second = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(second).toEqual({ kind: "retracted", messages: turn1.length });
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual([]);

        // A third retract on the now-empty thread has nothing to remove.
        const third = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(third).toEqual({ kind: "empty-thread" });
    });

    it("empties a single-turn thread in one retract", async () => {
        const turn = [
            userText("the only question"),
            assistantToolUse("toolu_only", "search_gene", { symbol: "TP53" }),
            userToolResult("toolu_only", JSON.stringify({ hits: 1 })),
            assistantText("the only answer"),
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        // The sole turn is the tail, so one retract removes every row and empties
        // the thread — the outcome's count is the whole turn's row count.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: turn.length });
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual([]);
    });

    it("never leaves a partial turn when an append races a retract on one thread", async () => {
        const turn = [
            userText("concurrent question"),
            assistantToolUse("toolu_c", "search_gene", { symbol: "MYC" }),
            userToolResult("toolu_c", JSON.stringify({ hits: 5 })),
            assistantText("concurrent answer"),
        ];

        // The shared per-thread advisory lock forces these to serialize, so the
        // final state is one of exactly two: the whole turn present (retract ran
        // first on the empty thread) or the whole turn gone (retract ran after the
        // append and took it off). A partial turn would mean the lock failed.
        const [appendRes, retractRes] = await Promise.all([history.appendTurn(THREAD, turn), history.retractLastTurn(THREAD)]);
        appendRes._unsafeUnwrap();
        retractRes._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();
        expect(loaded.length === 0 || loaded.length === turn.length).toBe(true);
        if (loaded.length === turn.length) {
            expect(loaded).toEqual(turn);
            assertValidSequence(loaded);
        }
    });

    it("removes a turn containing a loop-synthesized nudge whole, not from the nudge onward", async () => {
        // The truncated-reply nudge (`run-agent.ts`) carries the `user` role because the wire format
        // needs one after a cut-off assistant message, and it is persisted with the rest of the turn.
        // Taken for user input it would read as this turn's head, and the delete would cut THERE —
        // leaving the opening question and the truncated reply behind as a headless fragment.
        const turn1 = [userText("opening question"), assistantText("opening answer")];
        const turn2 = [
            userText("a question whose answer runs long"),
            assistantText("a reply cut off at the output-token limit"),
            syntheticUserMessage("Your previous reply was cut off at the output-token limit; continue concisely."),
            assistantText("the continued and finished reply"),
        ];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 4 });

        // The whole tail turn came off and turn1 is intact — not a fragment of turn2.
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual(turn1);
    });

    it("groups a loop-synthesized nudge into its turn rather than opening a new one", async () => {
        // The same predicate on the read side: the nudge must not split one turn into two, or the
        // token window can evict half a turn and `loadPage`'s turn count is wrong.
        const turn = [
            userText("a question whose answer runs long"),
            assistantText("a reply cut off at the output-token limit"),
            syntheticUserMessage("Your previous reply was cut off at the output-token limit; continue concisely."),
            assistantText("the continued and finished reply"),
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        const page = (await history.loadPage(THREAD, 0, 50))._unsafeUnwrap();
        expect(page.total).toBe(1);
        expect(page.messages.map((m) => m.message)).toEqual(turn);
    });

    it("appends a whole valid turn after retracting first on an empty thread", async () => {
        // The race test above almost always resolves append-first, so its
        // retract-ran-first branch is rarely exercised. Pin that outcome here
        // deterministically: retract an empty thread first (nothing to remove),
        // then append a multi-message turn and confirm it lands whole and valid.
        const empty = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(empty).toEqual({ kind: "empty-thread" });

        const turn = [
            userText("concurrent question"),
            assistantToolUse("toolu_c", "search_gene", { symbol: "MYC" }),
            userToolResult("toolu_c", JSON.stringify({ hits: 5 })),
            assistantText("concurrent answer"),
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();
        expect(loaded).toEqual(turn);
        assertValidSequence(loaded);
    });
});

// --- interruption marker round-trip -----------------------------------------

describe("interruption marker round-trip", () => {
    it("survives appendTurn and reads back as interrupted on the assistant row only", async () => {
        const marked = markInterruptedMessage(assistantText("a partial reply cut off"));
        const turn = [userText("a question"), marked];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap();
        expect(loaded).toHaveLength(2);
        // The marker survives the store round-trip byte-identically...
        expect(loaded[1]).toEqual(marked);
        // ...and the helper reports interrupted on the assistant row, not the user row.
        expect(isInterruptedMessage(loaded[1]!)).toBe(true);
        expect(isInterruptedMessage(loaded[0]!)).toBe(false);
    });

    it("snaps a window over a marked-tail turn exactly as over an unmarked one", async () => {
        const turn1 = [
            userText("question that needs a tool call"),
            assistantToolUse("toolu_a", "search_gene", { symbol: "EGFR" }),
            userToolResult("toolu_a", JSON.stringify({ hits: 3 })),
            assistantText("answer grounded in the tool result"),
        ];
        const turn2 = [userText("a simple follow-up question"), markInterruptedMessage(assistantText("a simple follow-up answer"))];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // The marker rides a non-boundary assistant role and does not change any
        // message's content, so the window snaps past turn1's tool_result-only user
        // message to turn2's genuine user start — exactly as an unmarked tail would —
        // and the marker survives on the returned assistant message.
        const budget = turnCost(turn2) + countTokens(turn1[3]!.content);
        const loaded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();

        expect(loaded).toEqual(turn2);
        assertValidSequence(loaded);
        expect(isInterruptedMessage(loaded[1]!)).toBe(true);
    });

    it("retracts a marked-tail turn identically to an unmarked one", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), markInterruptedMessage(assistantText("an interrupted answer two"))];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();

        // The marker rides the assistant row — a non-boundary role — so the turn
        // opens on its single user message and comes off whole, exactly as an
        // unmarked turn does, leaving turn1 intact as the tail.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 2 });
        expect((await history.loadRecent(THREAD, 1_000_000))._unsafeUnwrap()).toEqual(turn1);
    });
});
