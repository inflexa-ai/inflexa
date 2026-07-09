import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { countTokens } from "./count-tokens.js";
import { __resetThreadHistoryMetricsForTest, createThreadHistory, type ThreadHistory } from "./thread-history.js";

const THREAD = "analysis-thread-1";

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

// --- token windowing --------------------------------------------------------

describe("loadRecent token windowing", () => {
    it("returns only the most recent turns whose cumulative tokens fit", async () => {
        const turn1 = [userText("first question about the dataset"), assistantText("first detailed answer about the dataset")];
        const turn2 = [userText("second question about the genes"), assistantText("second detailed answer about the genes")];
        const turn3 = [userText("third question about the pathways"), assistantText("third detailed answer about the pathways")];
        (await history.appendTurn(THREAD, turn1))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn2))._unsafeUnwrap();
        (await history.appendTurn(THREAD, turn3))._unsafeUnwrap();

        // Budget fits turn3 + turn2 exactly, but not turn1.
        const budget = turnCost(turn2) + turnCost(turn3);
        const loaded = (await history.loadRecent(THREAD, budget))._unsafeUnwrap();

        expect(loaded).toEqual([...turn2, ...turn3]);
        assertValidSequence(loaded);
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
