import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { TokenUsageRollup } from "../contracts/usage.js";
import type { DbError } from "../lib/db-result.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import {
    contextRecordMessage,
    dropMarkerMessage,
    envelopeMessage,
    isInterruptedMessage,
    markCompactionExchange,
    markInterruptedMessage,
    summaryMarkerMessage,
    syntheticRecordMessage,
    syntheticUserMessage,
} from "./ai-sdk-message-storage.js";
import { countTokens } from "./count-tokens.js";
import type { ConversationUIMessage } from "./conversation-display-storage.js";
import {
    __resetThreadHistoryMetricsForTest,
    conversationRecordTurn,
    createThreadHistory,
    type ConversationTurn,
    type ThreadHistory,
} from "./thread-history.js";
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

/** A two-message turn whose opening `user` message the `label` makes unique. */
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

/**
 * Append a model-only turn. Most suites here exercise the model projection —
 * sequencing, the view, retraction — where an empty display
 * projection is the honest input: nothing was displayed because no turn ran.
 * The display projection has its own suite below.
 */
function append(threadId: string, modelMessages: readonly ModelMessage[]): ResultAsync<void, DbError> {
    return history.appendTurn(threadId, { modelMessages, displayMessages: [] });
}

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
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
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
        (await append(THREAD, [userText("reason about this"), assistantThinking("step-by-step reasoning", signature)]))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
        const reasoning = loaded.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).find((b) => b.type === "reasoning");
        expect(reasoning).toMatchObject({
            type: "reasoning",
            providerOptions: { anthropic: { signature } },
        });
    });

    it("returns an empty array for a thread with no messages", async () => {
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual([]);
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
        (await append(THREAD, turn))._unsafeUnwrap();

        assertMarshalsVerbatim(turn, (await history.loadRecent(THREAD))._unsafeUnwrap());
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
        (await append(THREAD, turn))._unsafeUnwrap();

        assertMarshalsVerbatim(turn, (await history.loadRecent(THREAD))._unsafeUnwrap());
    });

    it("holds the earlier turns of a thread byte-identical as later turns land on top", async () => {
        // The cache guarantee end to end: a prefix already sent reads back
        // unchanged after more turns land behind it.
        const turn1 = [userText("first question"), assistantToolUse("toolu_3", "search_gene", { symbol: "EGFR", species: "human", limit: 5 })];
        const turn2 = [userToolResult("toolu_3", JSON.stringify({ hits: 3 })), assistantText("EGFR is well characterized.")];
        (await append(THREAD, turn1))._unsafeUnwrap();
        const afterFirst = (await history.loadRecent(THREAD))._unsafeUnwrap();

        (await append(THREAD, turn2))._unsafeUnwrap();
        const afterSecond = (await history.loadRecent(THREAD))._unsafeUnwrap();

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
        (await append(THREAD, [userText("read the binary header"), userToolResult("toolu_4", `MAGIC${NUL}rest`)]))._unsafeUnwrap();

        assertMarshalsVerbatim(
            [userText("read the binary header"), userToolResult("toolu_4", "MAGICrest")],
            (await history.loadRecent(THREAD))._unsafeUnwrap(),
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

        (await append("older", [userText("question one"), assistantText("answer one")]))._unsafeUnwrap();

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
        const appended = await append(THREAD, turn);
        expect(appended.isOk()).toBe(true);

        // The turn committed with the failed touch rolled back out of it, not
        // alongside it: both rows are readable.
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn);
        const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM messages WHERE thread_id = $1", [THREAD]);
        expect(Number(rows[0]!.count)).toBe(turn.length);
    });

    it("leaves a soft-deleted thread's tombstone unmoved while persisting the turn", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS, title: "Deleted" }))._unsafeUnwrap();
        (await store.archiveThread(THREAD))._unsafeUnwrap();

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
        (await append(THREAD, turn))._unsafeUnwrap();

        // A deleted thread keeps its messages, so the turn still lands — but the
        // tombstone is not a live row and the touch must neither revive it nor
        // advance its activity clock.
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn);
        const after = await readTombstone();
        expect(after.deleted_at).not.toBeNull();
        expect(after.updated_at).toBe(before.updated_at);
    });

    it("persists the turn for a thread that has no metadata row", async () => {
        const turn = [userText("question one"), assistantText("answer one")];
        (await append(THREAD, turn))._unsafeUnwrap();

        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn);

        const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM cortex_analysis_threads WHERE thread_id = $1", [THREAD]);
        expect(Number(rows[0]!.count)).toBe(0);
    });
});

// --- the view of the latest marker -----------------------------------------

/** The stored messages of one compaction exchange: the request, a memory edit, and the summary reply. */
function exchangeOf(id: string): ModelMessage[] {
    return [
        syntheticUserMessage("Reply with the summary."),
        assistantToolUse(`${id}-memory`, "update_working_memory", { section: "goal", text: "Compare the groups." }),
        userToolResult(`${id}-memory`, JSON.stringify({ ok: true })),
        assistantText(`summary ${id}`),
    ].map((message) => markCompactionExchange(message, id));
}

function summaryMarker(id: string, text: string): ModelMessage {
    return summaryMarkerMessage(text, { kind: "summary", id, tokensBefore: 1_000, tokensAfter: 100, durationMs: 20 });
}

function dropMarker(id: string, keptTurns: number): ModelMessage {
    return dropMarkerMessage({ kind: "drop", id, tokensBefore: 1_000, tokensAfter: 500, durationMs: 20, keptTurns });
}

const runRecord = (text: string): ModelMessage => contextRecordMessage("run-activity", `[Run Activity]\n${text}`);

describe("loadRecent view of the latest marker", () => {
    it("gives each row of a thread with no marker", async () => {
        const turns = ["A", "B", "C", "D", "E", "F"].map(labeledTurn);
        for (const turn of turns) {
            (await append(THREAD, turn))._unsafeUnwrap();
        }

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();

        expect(loaded).toEqual(turns.flat());
        assertValidSequence(loaded);
    });

    it("starts the view at a stored summary marker, and holds no message of the stored exchange", async () => {
        const marker = summaryMarker("c-1", "The user compares two groups.");
        (await append(THREAD, labeledTurn("A")))._unsafeUnwrap();
        (
            await append(THREAD, [userText("question B"), assistantToolUse("toolu_b", "search_gene", { symbol: "EGFR" }), userToolResult("toolu_b", "{}")])
        )._unsafeUnwrap();
        (await append(THREAD, [...exchangeOf("c-1"), marker, runRecord("none"), assistantText("answer B")]))._unsafeUnwrap();
        (await append(THREAD, labeledTurn("C")))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();

        expect(loaded).toEqual([marker, runRecord("none"), assistantText("answer B"), ...labeledTurn("C")]);
        assertValidSequence(loaded);
    });

    it("gives each message except the exchange when no marker follows the exchange", async () => {
        (await append(THREAD, labeledTurn("A")))._unsafeUnwrap();
        (await append(THREAD, [userText("question B"), ...exchangeOf("c-1")]))._unsafeUnwrap();

        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual([...labeledTurn("A"), userText("question B")]);
    });

    it("gives the seed and then the summary marker of a report thread with keepFirstTurn", async () => {
        const seed = syntheticRecordMessage("[Report Brief]\nDraft the methods section.");
        const marker = summaryMarker("c-1", "The draft covers the methods.");
        (await append(THREAD, [seed]))._unsafeUnwrap();
        (await append(THREAD, labeledTurn("A")))._unsafeUnwrap();
        (await append(THREAD, [userText("question B"), ...exchangeOf("c-1"), marker, runRecord("none")]))._unsafeUnwrap();

        expect((await history.loadRecent(THREAD, { keepFirstTurn: true }))._unsafeUnwrap()).toEqual([seed, marker, runRecord("none")]);
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual([marker, runRecord("none")]);
    });

    it("gives the summary, the kept turns without reasoning, and the later rows after a stored drop marker", async () => {
        const marker = summaryMarker("c-1", "first summary");
        const kept: ModelMessage = {
            role: "assistant",
            content: [
                { type: "reasoning", text: "kept reasoning", providerOptions: { anthropic: { signature: "SIG-kept" } } },
                { type: "text", text: "answer C" },
            ],
        };
        const later = assistantThinking("later reasoning", "SIG-later");
        (await append(THREAD, [userText("question A"), ...exchangeOf("c-1"), marker, runRecord("r1")]))._unsafeUnwrap();
        (await append(THREAD, labeledTurn("B")))._unsafeUnwrap();
        (await append(THREAD, [userText("question C"), kept]))._unsafeUnwrap();
        (await append(THREAD, [userText("question D"), assistantText("answer D"), ...exchangeOf("c-2"), dropMarker("c-2", 2), later]))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();

        expect(loaded).toEqual([marker, userText("question C"), assistantText("answer C"), userText("question D"), assistantText("answer D"), later]);
        assertValidSequence(loaded);
        const stored = (await history.loadAll(THREAD))._unsafeUnwrap().flat();
        expect(stored.some((row) => JSON.stringify(row.message) === JSON.stringify(kept))).toBe(true);
    });

    it("goes back to the earlier marker when a retract removes the last turn and its marker", async () => {
        const first = summaryMarker("c-1", "first summary");
        (await append(THREAD, [userText("question A"), ...exchangeOf("c-1"), first, runRecord("r1"), assistantText("answer A")]))._unsafeUnwrap();
        (await append(THREAD, labeledTurn("B")))._unsafeUnwrap();
        const before = (await history.loadRecent(THREAD))._unsafeUnwrap();
        (await append(THREAD, [userText("question C"), ...exchangeOf("c-2"), summaryMarker("c-2", "second summary"), runRecord("r2")]))._unsafeUnwrap();

        (await history.retractLastTurn(THREAD))._unsafeUnwrap();

        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(before);
        expect(before[0]).toEqual(first);
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
            (await append(THREAD, turn))._unsafeUnwrap();
        }

        // Budget far above the whole thread — every turn is included, so the only
        // thing under test is the read's ordering.
        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();

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
    it("reports no eviction for a thread with no marker", async () => {
        (await append(THREAD, [userText("a small question"), assistantText("a small answer")]))._unsafeUnwrap();
        (await history.loadRecent(THREAD))._unsafeUnwrap();

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

    it("reports the turns before a summary marker in the sixth of eight turns", async () => {
        for (const label of ["A", "B", "C", "D", "E"]) {
            (await append(THREAD, labeledTurn(label)))._unsafeUnwrap();
        }
        (
            await append(THREAD, [userText("question F"), ...exchangeOf("c-1"), summaryMarker("c-1", "summary"), runRecord("none"), assistantText("answer F")])
        )._unsafeUnwrap();
        (await append(THREAD, labeledTurn("G")))._unsafeUnwrap();
        (await append(THREAD, labeledTurn("H")))._unsafeUnwrap();

        (await history.loadRecent(THREAD))._unsafeUnwrap();

        const collected = await collectMetrics();
        const evicted = collected.find((m) => m.descriptor.name === "cortex.harness.thread.turns_evicted");
        expect(evicted).toBeDefined();
        const evictedPoint = evicted!.dataPoints[0]!;
        expect((evictedPoint.value as { sum: number }).sum).toBe(5);
        expect(evictedPoint.attributes.eviction).toBe(true);
    });
});

// --- retractLastTurn --------------------------------------------------------

describe("retractLastTurn", () => {
    it("removes the last appended turn and restores the exact pre-append window", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), assistantText("answer two")];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        // Snapshot the window, append one more (single-message) turn, then retract
        // it: the byte-stable prefix guarantee only holds if the retracted tail
        // restores the exact prior row set.
        const before = (await history.loadRecent(THREAD))._unsafeUnwrap();

        (await append(THREAD, [userText("question three")]))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 1 });

        const after = (await history.loadRecent(THREAD))._unsafeUnwrap();
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
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        // The turn's tool-result row is `tool`-role, not `user`, so the turn opens
        // on its single user message: all four rows sit at or past that boundary
        // and come off together.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 4 });

        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(page.length).toBe(1);
        expect(page.flat().map((m) => m.message)).toEqual(turn1);
    });

    it("reports empty-thread and deletes nothing when the thread has no rows", async () => {
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "empty-thread" });
    });

    it("refuses a thread whose rows carry no user-role message, deleting nothing", async () => {
        // Rows that never open a turn are anomalous data: retract refuses them
        // rather than emptying the thread. Appending an assistant-only "turn"
        // stages exactly that shape without a direct SQL insert.
        (await append(THREAD, [assistantText("orphan one"), assistantText("orphan two")]))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "no-user-turn" });

        const { rows } = await pool.query<{ seq: string }>("SELECT seq FROM messages WHERE thread_id = $1 ORDER BY seq ASC", [THREAD]);
        expect(rows.map((r) => Number(r.seq))).toEqual([0, 1]);
    });

    it("walks turns back to empty across repeated retracts", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), assistantText("answer two")];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        // First retract takes the newest turn off; the prior turn is now the tail.
        const first = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(first).toEqual({ kind: "retracted", messages: turn2.length });
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn1);

        // Second retract takes the remaining turn off; the thread is now empty.
        const second = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(second).toEqual({ kind: "retracted", messages: turn1.length });
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual([]);

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
        (await append(THREAD, turn))._unsafeUnwrap();

        // The sole turn is the tail, so one retract removes every row and empties
        // the thread — the outcome's count is the whole turn's row count.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: turn.length });
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual([]);
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
        const append = async () => (await history.appendTurn(THREAD, { modelMessages: turn, displayMessages: [] }))._unsafeUnwrap();
        const retract = async () => (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        await Promise.all([append(), retract()]);

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
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
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 4 });

        // The whole tail turn came off and turn1 is intact — not a fragment of turn2.
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn1);
    });

    it("groups a loop-synthesized nudge into its turn rather than opening a new one", async () => {
        // The same predicate on the read side: the nudge must not split one turn into two, or a
        // drop can keep half a turn and `loadAll`'s turn grouping is wrong.
        const turn = [
            userText("a question whose answer runs long"),
            assistantText("a reply cut off at the output-token limit"),
            syntheticUserMessage("Your previous reply was cut off at the output-token limit; continue concisely."),
            assistantText("the continued and finished reply"),
        ];
        (await append(THREAD, turn))._unsafeUnwrap();

        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(page.length).toBe(1);
        expect(page.flat().map((m) => m.message)).toEqual(turn);
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
        (await append(THREAD, turn))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
        expect(loaded).toEqual(turn);
        assertValidSequence(loaded);
    });
});

// --- interruption marker round-trip -----------------------------------------

describe("interruption marker round-trip", () => {
    it("survives appendTurn and reads back as interrupted on the assistant row only", async () => {
        const marked = markInterruptedMessage(assistantText("a partial reply cut off"));
        const turn = [userText("a question"), marked];
        (await append(THREAD, turn))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
        expect(loaded).toHaveLength(2);
        // The marker survives the store round-trip byte-identically...
        expect(loaded[1]).toEqual(marked);
        // ...and the helper reports interrupted on the assistant row, not the user row.
        expect(isInterruptedMessage(loaded[1]!)).toBe(true);
        expect(isInterruptedMessage(loaded[0]!)).toBe(false);
    });

    it("keeps a marked-tail turn through a drop exactly as an unmarked one", async () => {
        const turn1 = [
            userText("question that needs a tool call"),
            assistantToolUse("toolu_a", "search_gene", { symbol: "EGFR" }),
            userToolResult("toolu_a", JSON.stringify({ hits: 3 })),
            assistantText("answer grounded in the tool result"),
        ];
        const turn2 = [userText("a simple follow-up question"), markInterruptedMessage(assistantText("a simple follow-up answer"))];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();
        (await append(THREAD, [userText("question three"), ...exchangeOf("c-1"), dropMarker("c-1", 2)]))._unsafeUnwrap();

        // The marker rides a non-boundary assistant role, thus the drop keeps turn2
        // whole, and the marker survives on the kept assistant message.
        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();

        expect(loaded).toEqual([...turn2, userText("question three")]);
        assertValidSequence(loaded);
        expect(isInterruptedMessage(loaded[1]!)).toBe(true);
    });

    it("retracts a marked-tail turn identically to an unmarked one", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), markInterruptedMessage(assistantText("an interrupted answer two"))];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        // The marker rides the assistant row — a non-boundary role — so the turn
        // opens on its single user message and comes off whole, exactly as an
        // unmarked turn does, leaving turn1 intact as the tail.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 2 });
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn1);
    });
});

// --- host-appended synthetic records ----------------------------------------

describe("host-appended synthetic records", () => {
    // The embedder's use of the marker: a record of work that happened OUTSIDE the conversation —
    // an analysis run finishing — appended between turns rather than mid-turn. It must reach the
    // model's next context without being mistaken for something the user said.
    //
    // Built with `syntheticRecordMessage` — the constructor the HOST actually calls — not with
    // `syntheticUserMessage`. The two are separate markers that agree today, and every invariant
    // below rests on that agreement: if a record ever stopped carrying `SYNTHETIC_MESSAGE_KEY` it
    // would read as a genuine turn start, splitting one turn in two for the view and handing
    // tail retraction a mid-turn cut point. Asserting against the loop's constructor instead would
    // leave that regression green.
    const runNotice = (): ModelMessage => syntheticRecordMessage("Run GSEA cross-species comparison completed: 3/3 steps in 4m12s.");

    it("does not open a turn for paging or the view", async () => {
        const turn = [userText("kick off the analysis"), assistantText("launched — I'll report back")];
        (await append(THREAD, turn))._unsafeUnwrap();
        (await append(THREAD, [runNotice()]))._unsafeUnwrap();

        // One turn, not two: the record rides the exchange it followed.
        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(page.length).toBe(1);
        expect(page.flat().length).toBe(3);
    });

    it("is present in the view the next turn is assembled from", async () => {
        // This is what lets the agent answer "are you done?" without a tool call.
        const turn = [userText("kick off the analysis"), assistantText("launched — I'll report back")];
        (await append(THREAD, turn))._unsafeUnwrap();
        const notice = runNotice();
        (await append(THREAD, [notice]))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
        expect(loaded).toEqual([...turn, notice]);
        assertValidSequence(loaded);
    });

    it("is removed with the turn it belongs to when that turn is retracted", async () => {
        const turn1 = [userText("first question"), assistantText("first answer")];
        const turn2 = [userText("kick off the analysis"), assistantText("launched")];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();
        (await append(THREAD, [runNotice()]))._unsafeUnwrap();

        // Accepted consequence of opening no turn: the record folds into turn2 and comes off with
        // it. The alternative — letting it open a turn — would hand retraction a mid-turn cut point.
        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 3 });
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(turn1);
    });

    it("survives a retraction when a later genuine turn insulates it", async () => {
        const turn1 = [userText("kick off the analysis"), assistantText("launched")];
        const notice = runNotice();
        const turn2 = [userText("what did it find?"), assistantText("here is the summary")];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, [notice]))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();
        expect(outcome).toEqual({ kind: "retracted", messages: 2 });
        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual([...turn1, notice]);
    });
});

describe("dual model/display turn persistence", () => {
    it("round-trips display on the turn head while loadRecent stays model-only", async () => {
        const modelMessages = [userText("show results"), assistantText("Here they are.")];
        const displayMessages: ConversationUIMessage[] = [
            { id: "u-display", role: "user", parts: [{ type: "text", text: "show results" }] },
            {
                id: "a-display",
                role: "assistant",
                parts: [
                    { type: "text", text: "Here they are." },
                    {
                        type: "data-file-reference",
                        id: "files-1",
                        data: { id: "files-1", files: [{ path: "runs/run-1/output/results.csv", runId: "run-1" }] },
                    },
                ],
            },
        ];

        (await history.appendTurn(THREAD, { modelMessages, displayMessages }))._unsafeUnwrap();

        expect((await history.loadRecent(THREAD))._unsafeUnwrap()).toEqual(modelMessages);
        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(page.flat()[0]!.displayEnvelope?.messages).toEqual(displayMessages);
        expect(page.flat()[1]!.displayEnvelope).toBeUndefined();

        const { rows } = await pool.query<{ tokens: number; display_envelope: unknown }>(
            "SELECT tokens, display_envelope FROM messages WHERE thread_id = $1 ORDER BY seq",
            [THREAD],
        );
        expect(rows[0]!.tokens).toBe(countTokens(modelMessages[0]!.content));
        expect(rows[0]!.display_envelope).not.toBeNull();
        expect(rows[1]!.display_envelope).toBeNull();
    });

    it("retract removes the model rows and their turn-head display envelope together", async () => {
        const modelMessages = [userText("question"), assistantText("answer")];
        const displayMessages: ConversationUIMessage[] = [
            { id: "u-display", role: "user", parts: [{ type: "text", text: "question" }] },
            { id: "a-display", role: "assistant", parts: [{ type: "text", text: "answer" }] },
        ];
        (await history.appendTurn(THREAD, { modelMessages, displayMessages }))._unsafeUnwrap();

        expect((await history.retractLastTurn(THREAD))._unsafeUnwrap()).toEqual({ kind: "retracted", messages: 2 });
        const { rows } = await pool.query("SELECT 1 FROM messages WHERE thread_id = $1", [THREAD]);
        expect(rows).toHaveLength(0);
    });

    it("rolls back model rows when the display projection cannot be stored", async () => {
        await pool.query("ALTER TABLE messages ADD CONSTRAINT reject_display_projection CHECK (display_envelope IS NULL)");
        const result = await history.appendTurn(THREAD, {
            modelMessages: [userText("question"), assistantText("answer")],
            displayMessages: [
                { id: "u-display", role: "user", parts: [{ type: "text", text: "question" }] },
                { id: "a-display", role: "assistant", parts: [{ type: "text", text: "answer" }] },
            ],
        });

        expect(result.isErr()).toBe(true);
        const { rows } = await pool.query("SELECT 1 FROM messages WHERE thread_id = $1", [THREAD]);
        expect(rows).toHaveLength(0);
    });
});

// --- figures of an older turn ------------------------------------------------

describe("the figures on the rows of an older turn", () => {
    it("reads a row with the two figures back with its figures", async () => {
        const rollup: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340 };
        await pool.query(
            `INSERT INTO messages (thread_id, seq, message_envelope, tokens, reported_usage, turn_duration_ms)
             VALUES ($1, 0, $2::json, 4, NULL, NULL), ($1, 1, $3::json, 4, $4::jsonb, 8412)`,
            [
                THREAD,
                JSON.stringify(envelopeMessage(userText("an older question"))),
                JSON.stringify(envelopeMessage(assistantText("an older answer"))),
                JSON.stringify(rollup),
            ],
        );

        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();

        expect(rows.map((row) => row.usage)).toEqual([undefined, rollup]);
        expect(rows.map((row) => row.durationMs)).toEqual([undefined, 8412]);
        expect("usage" in rows[0]!).toBe(false);
        expect("durationMs" in rows[0]!).toBe(false);
    });

    it("stores no figure on a row of appendTurn", async () => {
        (await append(THREAD, [userText("question one"), assistantText("answer one")]))._unsafeUnwrap();

        const { rows } = await pool.query<{ reported_usage: unknown; turn_duration_ms: string | null }>(
            "SELECT reported_usage, turn_duration_ms::text AS turn_duration_ms FROM messages WHERE thread_id = $1 ORDER BY messages.seq ASC",
            [THREAD],
        );
        expect(rows).toEqual([
            { reported_usage: null, turn_duration_ms: null },
            { reported_usage: null, turn_duration_ms: null },
        ]);
    });
});

// --- writeTurn --------------------------------------------------------------

describe("writeTurn", () => {
    const ROLLUP: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900 };

    function display(id: string, role: "user" | "assistant", text: string): ConversationUIMessage {
        return { id, role, parts: [{ type: "text", text, state: "done" }] };
    }

    function opening(text = "run the comparison"): ConversationTurn {
        return {
            modelMessages: [userText(text), contextRecordMessage("run-activity", "[Run Activity]\nNo runs are currently running or suspended.")],
            displayMessages: [display(`user-${text}`, "user", text)],
            author: "dr.chen@lab.example",
        };
    }

    function round(id: string, text: string): ConversationTurn {
        return {
            modelMessages: [assistantToolUse(`call-${id}`, "run_pca", { k: 2 }), userToolResult(`call-${id}`, "done"), assistantText(text)],
            displayMessages: [display("assistant-1", "assistant", text)],
        };
    }

    interface TurnRecordRow {
        readonly start_seq: string;
        readonly status: string;
        readonly reason: string | null;
        readonly reported_usage: TokenUsageRollup | null;
        readonly turn_duration_ms: string | null;
        readonly closed: boolean;
    }

    async function turnRecords(threadId = THREAD): Promise<TurnRecordRow[]> {
        const { rows } = await pool.query<TurnRecordRow>(
            `SELECT start_seq::text AS start_seq, status, reason, reported_usage, turn_duration_ms::text AS turn_duration_ms, closed_at IS NOT NULL AS closed
               FROM cortex_thread_turns WHERE thread_id = $1 ORDER BY start_seq`,
            [threadId],
        );
        return rows;
    }

    /** Each stored row as text, which a byte-identity check compares. */
    async function storedRowTexts(threadId = THREAD): Promise<string[]> {
        const { rows } = await pool.query<{ row: string }>(
            `SELECT seq::text || ' ' || message_envelope::text || ' ' || COALESCE(display_envelope::text, '-') || ' ' || COALESCE(author, '-') AS row
               FROM messages WHERE thread_id = $1 ORDER BY messages.seq ASC`,
            [threadId],
        );
        return rows.map((r) => r.row);
    }

    it("adds the rows of an opening and an open record, keyed by the seq of the user row", async () => {
        (await append(THREAD, [userText("an earlier question"), assistantText("an earlier answer")]))._unsafeUnwrap();

        const { startSeq } = (await history.writeTurn(THREAD, { opening: opening(), rounds: [] }))._unsafeUnwrap();

        expect(startSeq).toBe(2);
        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
        expect(rows[2]!.author).toBe("dr.chen@lab.example");
        expect(rows[3]!.author).toBeUndefined();
        expect(await turnRecords()).toEqual([{ start_seq: "2", status: "open", reason: null, reported_usage: null, turn_duration_ms: null, closed: false }]);
    });

    it("appends each later round after the opening, with the display envelope of the round on its first row", async () => {
        const { startSeq } = (await history.writeTurn(THREAD, { opening: opening(), rounds: [] }))._unsafeUnwrap();
        (await history.writeTurn(THREAD, { startSeq, rounds: [round("a", "first round")] }))._unsafeUnwrap();
        (await history.writeTurn(THREAD, { startSeq, rounds: [round("b", "second round")] }))._unsafeUnwrap();

        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(rows.map((row) => row.displayEnvelope !== undefined)).toEqual([true, false, true, false, false, true, false, false]);
        expect(rows[2]!.displayEnvelope!.messages[0]!.parts).toEqual([{ type: "text", text: "first round", state: "done" }]);
        expect(rows[5]!.displayEnvelope!.messages[0]!.parts).toEqual([{ type: "text", text: "second round", state: "done" }]);
    });

    it("lands the opening, two rounds, and the close of one write in order", async () => {
        const first = round("a", "first round");
        const second = round("b", "second round");

        (
            await history.writeTurn(THREAD, { opening: opening(), rounds: [first, second], close: { status: "done", turnUsage: ROLLUP, turnDurationMs: 8412 } })
        )._unsafeUnwrap();

        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();
        expect(rows.map((row) => row.message)).toEqual([...opening().modelMessages, ...first.modelMessages, ...second.modelMessages]);
        expect((await turnRecords()).map((record) => record.status)).toEqual(["done"]);
    });

    it("sets the status, the reason, the rollup, and the duration at the close, and stores the note last", async () => {
        const { startSeq } = (await history.writeTurn(THREAD, { opening: opening(), rounds: [round("a", "first round")] }))._unsafeUnwrap();
        const note = conversationRecordTurn("[Turn Failed]\nThe turn stopped before it finished. Reason: The model request failed.");

        (
            await history.writeTurn(THREAD, {
                startSeq,
                rounds: [],
                close: { status: "failed", reason: "The model request failed.", turnUsage: ROLLUP, turnDurationMs: 8412, note },
            })
        )._unsafeUnwrap();

        expect(await turnRecords()).toEqual([
            { start_seq: "0", status: "failed", reason: "The model request failed.", reported_usage: ROLLUP, turn_duration_ms: "8412", closed: true },
        ]);
        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();
        expect(rows.at(-1)!.message).toEqual(note.modelMessages[0]!);
    });

    it("stores a rollup with no quantity as absent, and a second close changes nothing", async () => {
        const { startSeq } = (
            await history.writeTurn(THREAD, { opening: opening(), rounds: [], close: { status: "done", turnUsage: {}, turnDurationMs: 0 } })
        )._unsafeUnwrap();

        (await history.writeTurn(THREAD, { startSeq, rounds: [], close: { status: "failed", reason: "The model request failed." } }))._unsafeUnwrap();

        expect(await turnRecords()).toEqual([{ start_seq: "0", status: "done", reason: null, reported_usage: null, turn_duration_ms: "0", closed: true }]);
    });

    it("leaves no row and no record when a write fails", async () => {
        await pool.query(
            `CREATE FUNCTION boom_insert() RETURNS trigger AS $$ BEGIN
               IF NEW.seq = 2 THEN RAISE EXCEPTION 'simulated insert failure'; END IF;
               RETURN NEW;
             END; $$ LANGUAGE plpgsql`,
        );
        await pool.query("CREATE TRIGGER boom_insert_trg BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION boom_insert()");

        const written = await history.writeTurn(THREAD, { opening: opening(), rounds: [round("a", "first round")] });

        expect(written.isErr()).toBe(true);
        expect(await storedRowTexts()).toEqual([]);
        expect(await turnRecords()).toEqual([]);
    });

    it("retracts the rows and the record of the last turn, and keeps the earlier turn byte-identical", async () => {
        (
            await history.writeTurn(THREAD, {
                opening: opening("first question"),
                rounds: [round("a", "first answer")],
                close: { status: "done", turnDurationMs: 10 },
            })
        )._unsafeUnwrap();
        const earlierRows = await storedRowTexts();
        const earlierRecords = await turnRecords();
        (
            await history.writeTurn(THREAD, { opening: opening("second question"), rounds: [round("b", "second answer")], close: { status: "aborted" } })
        )._unsafeUnwrap();

        const outcome = (await history.retractLastTurn(THREAD))._unsafeUnwrap();

        expect(outcome).toEqual({ kind: "retracted", messages: 5 });
        expect(await storedRowTexts()).toEqual(earlierRows);
        expect(await turnRecords()).toEqual(earlierRecords);
    });

    it("gives the record on the user row only, and a host record makes no record", async () => {
        (
            await history.writeTurn(THREAD, {
                opening: opening(),
                rounds: [round("a", "an answer")],
                close: { status: "done", turnUsage: ROLLUP, turnDurationMs: 8412 },
            })
        )._unsafeUnwrap();
        (await history.appendTurn(THREAD, conversationRecordTurn("Run run-1 completed.")))._unsafeUnwrap();

        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();

        expect(rows.map((row) => row.turn !== undefined)).toEqual([true, false, false, false, false, false]);
        expect(rows[0]!.turn).toEqual({ status: "done", usage: ROLLUP, durationMs: 8412 });
        expect(await turnRecords()).toHaveLength(1);
    });
});

// --- turn author ------------------------------------------------------------

describe("appendTurn turn author", () => {
    const AUTHOR = "dr.chen@lab.example";

    /**
     * Every row's stored author, oldest-first, as the column holds it. Asserted at
     * the column rather than through `loadAll`, because "on this row and on NO
     * other" is a storage fact: a read that folded the name onto a neighbour would
     * satisfy a display-level assertion while the write placed it wrong.
     */
    async function storedAuthors(threadId = THREAD): Promise<(string | null)[]> {
        const { rows } = await pool.query<{ author: string | null }>("SELECT author FROM messages WHERE thread_id = $1 ORDER BY messages.seq ASC", [threadId]);
        return rows.map((r) => r.author);
    }

    function appendAuthored(threadId: string, modelMessages: readonly ModelMessage[], author: string): ResultAsync<void, DbError> {
        return history.appendTurn(threadId, { modelMessages, displayMessages: [], author });
    }

    it("stores the author on the turn's user row and on no other", async () => {
        const turn = [
            userText("run the comparison"),
            assistantToolUse("call-1", "run_pca", { k: 2 }),
            userToolResult("call-1", "done"),
            assistantText("here are the results"),
        ];
        (await appendAuthored(THREAD, turn, AUTHOR))._unsafeUnwrap();

        expect(await storedAuthors()).toEqual([AUTHOR, null, null, null]);
        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(page.flat().map((m) => m.author)).toEqual([AUTHOR, undefined, undefined, undefined]);
    });

    it("stores no author when the caller supplies none", async () => {
        (await append(THREAD, [userText("question one"), assistantText("answer one")]))._unsafeUnwrap();

        expect(await storedAuthors()).toEqual([null, null]);
        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        // Absent, not present-and-undefined: a consumer that spreads the row must
        // not acquire an `author` key that overwrites one.
        expect("author" in page.flat()[0]!).toBe(false);
    });

    it("leaves a mid-turn synthetic nudge without an author", async () => {
        // The nudge carries the `user` role for the wire format, and nobody typed
        // it. Attributing it to the person would put a name on words they never sent.
        const turn = [
            userText("run the search"),
            assistantText("searching"),
            syntheticUserMessage("Your previous reply was cut off at the output-token limit; continue concisely."),
            assistantText("here is the hit"),
        ];
        (await appendAuthored(THREAD, turn, AUTHOR))._unsafeUnwrap();

        expect(await storedAuthors()).toEqual([AUTHOR, null, null, null]);
    });

    it("stores no author for a record append that supplies one", async () => {
        // A record of out-of-band work opens on a synthetic row. It is not the
        // message of a person, thus the genuine-user-start condition drops the name
        // however a host spreads it onto the turn.
        (await history.appendTurn(THREAD, { ...conversationRecordTurn("Run GSEA cross-species comparison completed."), author: AUTHOR }))._unsafeUnwrap();

        expect(await storedAuthors()).toEqual([null]);
    });

    it("drops a NUL from the author rather than failing the append", async () => {
        // The column is `text`, where a 0x00 byte fails the statement and takes the
        // whole turn down with it. The envelope write already strips NUL, and this
        // write obeys the same rule.
        const appended = await appendAuthored(THREAD, [userText("question one"), assistantText("answer one")], `dr\u0000.chen@lab.example`);

        expect(appended.isOk()).toBe(true);
        expect(await storedAuthors()).toEqual(["dr.chen@lab.example", null]);
    });

    it("reads a row written before the column existed back as absent", async () => {
        // The migration is additive with no backfill, thus a row that predates the
        // column is indistinguishable from a turn appended with no sender. An INSERT
        // that names neither the column nor a default is exactly that row.
        await pool.query("INSERT INTO messages (thread_id, seq, message_envelope, tokens) VALUES ($1, 0, $2::json, 4)", [
            THREAD,
            JSON.stringify(envelopeMessage(userText("written before authors existed"))),
        ]);

        const page = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(page.flat()[0]!.author).toBeUndefined();
        expect("author" in page.flat()[0]!).toBe(false);
    });

    it("leaves the model read untouched", async () => {
        // The provider never sees the author, thus the window is byte-identical to
        // the turn that was appended.
        const turn = [userText("question one"), assistantText("answer one")];
        (await appendAuthored(THREAD, turn, AUTHOR))._unsafeUnwrap();

        const loaded = (await history.loadRecent(THREAD))._unsafeUnwrap();
        expect(loaded).toEqual(turn);
        expect(loaded.some((m) => "author" in m)).toBe(false);
    });

    it("keeps the author and the time out of the stored display projection", async () => {
        // One fact, one durable copy. Both values ride the message row, the way the
        // rollup does, thus a projection cannot disagree with the row it opened.
        (
            await history.appendTurn(THREAD, {
                modelMessages: [userText("question one"), assistantText("answer one")],
                displayMessages: [
                    { id: "u-display", role: "user", parts: [{ type: "text", text: "question one" }] },
                    { id: "a-display", role: "assistant", parts: [{ type: "text", text: "answer one" }] },
                ],
                author: AUTHOR,
            })
        )._unsafeUnwrap();

        const { rows } = await pool.query<{ display_envelope: unknown }>("SELECT display_envelope FROM messages WHERE thread_id = $1 AND seq = 0", [THREAD]);
        const serialized = JSON.stringify(rows[0]!.display_envelope);
        expect(serialized).not.toContain("author");
        expect(serialized).not.toContain("createdAt");
    });

    it("takes the author with it when the tail turn is retracted", async () => {
        // Free by construction — the author is a column on the row — and pinned here
        // so a later move to a side table cannot orphan the name of a sender behind
        // a transcript that no longer holds the turn.
        (await appendAuthored(THREAD, [userText("first question"), assistantText("first answer")], AUTHOR))._unsafeUnwrap();
        (await appendAuthored(THREAD, [userText("second question"), assistantText("second answer")], "second.sender@lab.example"))._unsafeUnwrap();
        expect(await storedAuthors()).toEqual([AUTHOR, null, "second.sender@lab.example", null]);

        (await history.retractLastTurn(THREAD))._unsafeUnwrap();

        expect(await storedAuthors()).toEqual([AUTHOR, null]);
    });
});

// --- row creation time ------------------------------------------------------

describe("loadAll row creation time", () => {
    it("gives a Date on every row, one time for every row of an append", async () => {
        // `NOW()` is the START time of the transaction, and one append writes every
        // row of the turn in one transaction. Nothing here asserts an order between
        // two appends: the store gives none, and `seq` is what orders rows.
        const turn = [userText("run the comparison"), assistantToolUse("call-1", "run_pca", { k: 2 }), userToolResult("call-1", "done"), assistantText("done")];
        const before = Date.now();
        (await append(THREAD, turn))._unsafeUnwrap();

        const rows = (await history.loadAll(THREAD))._unsafeUnwrap().flat();
        const times = rows.map((m) => m.createdAt);
        expect(times.every((t) => t instanceof Date)).toBe(true);
        expect(new Set(times.map((t) => t!.getTime())).size).toBe(1);
        // `created_at` is the Postgres clock, and the test process runs on its own clock.
        // The 60-second slack on each side absorbs that skew. The bounds still reject a
        // zero, an epoch default, and a reading far in the future.
        expect(times[0]!.getTime()).toBeGreaterThanOrEqual(before - 60_000);
        expect(times[0]!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    });
});

// --- latestSeq --------------------------------------------------------------

describe("latestSeq", () => {
    it("gives the greatest seq of a thread that holds turns", async () => {
        const turn1 = [userText("question one"), assistantText("answer one")];
        const turn2 = [userText("question two"), assistantText("answer two")];
        (await append(THREAD, turn1))._unsafeUnwrap();
        (await append(THREAD, turn2))._unsafeUnwrap();

        // Four rows land at seq 0..3, so the tail is 3.
        expect((await history.latestSeq(THREAD))._unsafeUnwrap()).toBe(3);
    });

    it("gives null for a thread with no messages", async () => {
        expect((await history.latestSeq(THREAD))._unsafeUnwrap()).toBeNull();
    });
});

// --- countUserTurnsAfter ----------------------------------------------------

describe("countUserTurnsAfter", () => {
    it("counts one for each turn a person opened past the seq", async () => {
        // Three two-row turns land at seq 0..5, so the user starts sit at 0, 2, 4.
        (await append(THREAD, [userText("question one"), assistantText("answer one")]))._unsafeUnwrap();
        (await append(THREAD, [userText("question two"), assistantText("answer two")]))._unsafeUnwrap();
        (await append(THREAD, [userText("question three"), assistantText("answer three")]))._unsafeUnwrap();

        expect((await history.countUserTurnsAfter(THREAD, -1))._unsafeUnwrap()).toBe(3);
        expect((await history.countUserTurnsAfter(THREAD, 1))._unsafeUnwrap()).toBe(2);
        expect((await history.countUserTurnsAfter(THREAD, 3))._unsafeUnwrap()).toBe(1);
        expect((await history.countUserTurnsAfter(THREAD, 5))._unsafeUnwrap()).toBe(0);
    });

    it("gives zero for a thread with no messages", async () => {
        expect((await history.countUserTurnsAfter(THREAD, 0))._unsafeUnwrap()).toBe(0);
    });

    it("counts one turn once, whatever the row count of that turn is", async () => {
        // A serial-tool turn writes five rows and stays one ask. A row count of
        // the same span would report five, and the nudge would report two starts.
        (
            await append(THREAD, [
                userText("run the search"),
                assistantToolUse("c1", "workspace_search", { query: "the staged dataset" }),
                userToolResult("c1", "one hit"),
                syntheticUserMessage("Your previous reply was cut off at the output-token limit; continue concisely."),
                assistantText("here is the hit"),
            ])
        )._unsafeUnwrap();

        expect((await history.countUserTurnsAfter(THREAD, -1))._unsafeUnwrap()).toBe(1);
    });

    it("does not count a host-appended record", async () => {
        (await append(THREAD, [userText("kick off the analysis"), assistantText("launched")]))._unsafeUnwrap();
        // The record is the only row past seq 1, and it carries the `user` role.
        // Nobody typed it, thus it is no new work of the thread.
        (await append(THREAD, [syntheticRecordMessage("Run GSEA cross-species comparison completed: 3/3 steps.")]))._unsafeUnwrap();

        expect((await history.countUserTurnsAfter(THREAD, 1))._unsafeUnwrap()).toBe(0);

        // The genuine turn that follows the record does count, thus the zero above
        // reports the marker and not an empty span.
        (await append(THREAD, [userText("what did it find?"), assistantText("here is the summary")]))._unsafeUnwrap();
        expect((await history.countUserTurnsAfter(THREAD, 1))._unsafeUnwrap()).toBe(1);
    });
});

// --- the view is independent of the rollup ----------------------------------

describe("loadRecent ignores the stored rollup", () => {
    it("gives the same view with and without a rollup on each row", async () => {
        const huge: TokenUsageRollup = { inputTokens: 5_000_000, outputTokens: 5_000_000 };
        for (const threadId of ["with-rollups", "no-rollups"]) {
            for (const label of ["a", "b", "c"]) {
                (await append(threadId, labeledTurn(label)))._unsafeUnwrap();
            }
            (await append(threadId, [userText("question d"), ...exchangeOf("c-1"), dropMarker("c-1", 2), assistantText("answer d")]))._unsafeUnwrap();
        }
        await pool.query(
            `UPDATE messages SET reported_usage = $2::jsonb
              WHERE thread_id = $1 AND message_envelope->'message'->>'role' = 'assistant'`,
            ["with-rollups", JSON.stringify(huge)],
        );

        const withRollups = (await history.loadRecent("with-rollups"))._unsafeUnwrap();
        const withoutRollups = (await history.loadRecent("no-rollups"))._unsafeUnwrap();

        expect(withRollups).toEqual(withoutRollups);
        expect(withRollups).toEqual([...labeledTurn("c"), userText("question d"), assistantText("answer d")]);
    });
});

// --- loadAll / latestTurnAt --------------------------------------------------

describe("loadAll", () => {
    it("returns every turn of a thread far past any page size", async () => {
        const TURNS = 205;
        for (let i = 0; i < TURNS; i++) {
            (await append(THREAD, [userText(`ask ${i}`), assistantText(`answer ${i}`)]))._unsafeUnwrap();
        }

        const turns = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(turns).toHaveLength(TURNS);
        expect(turns.flat()).toHaveLength(TURNS * 2);
        expect(turns.at(-1)!.map((m) => m.message)).toEqual([userText(`ask ${TURNS - 1}`), assistantText(`answer ${TURNS - 1}`)]);
        // Past 200 deliberately: the read that this replaced clamped there and dropped the rest.
        expect(turns[200]!.map((m) => m.message)).toEqual([userText("ask 200"), assistantText("answer 200")]);
    });

    it("flattens back to the thread's rows in seq order", async () => {
        for (let i = 0; i < 3; i++) {
            (await append(THREAD, [userText(`ask ${i}`), assistantText(`answer ${i}`)]))._unsafeUnwrap();
        }

        const turns = (await history.loadAll(THREAD))._unsafeUnwrap();
        expect(turns.flat().map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(turns.flat().map((m) => m.message)).toEqual([
            userText("ask 0"),
            assistantText("answer 0"),
            userText("ask 1"),
            assistantText("answer 1"),
            userText("ask 2"),
            assistantText("answer 2"),
        ]);
    });

    it("reads an empty thread as no turns rather than an error", async () => {
        expect((await history.loadAll("thread-with-no-rows"))._unsafeUnwrap()).toEqual([]);
    });
});

describe("latestTurnAt", () => {
    it("is null for a thread with no rows", async () => {
        expect((await history.latestTurnAt(THREAD))._unsafeUnwrap()).toBeNull();
    });

    it("moves forward as turns land", async () => {
        (await append(THREAD, [userText("one"), assistantText("first")]))._unsafeUnwrap();
        const first = (await history.latestTurnAt(THREAD))._unsafeUnwrap();
        expect(first).not.toBeNull();

        (await append(THREAD, [userText("two"), assistantText("second")]))._unsafeUnwrap();
        const second = (await history.latestTurnAt(THREAD))._unsafeUnwrap();
        expect(second!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
    });

    it("is scoped to its own thread", async () => {
        (await append(THREAD, [userText("mine"), assistantText("ok")]))._unsafeUnwrap();
        expect((await history.latestTurnAt("some-other-thread"))._unsafeUnwrap()).toBeNull();
    });
});
