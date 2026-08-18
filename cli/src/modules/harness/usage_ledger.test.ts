import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { ok, okAsync } from "neverthrow";
import { z } from "zod";
import {
    defineTool,
    forSubAgent,
    passthroughStep,
    runAgent,
    type AgentChat,
    type AgentDefinition,
    type ChatRequest,
    type ChatResponse,
    type ChatUsage,
    type LogFields,
    type Logger,
    type Pool,
    type ThreadHistory,
    type Tool,
} from "@inflexa-ai/harness";

import { freshDb } from "../../test_support/db.ts";
import { getAnalysisUsageTotals } from "../../db/primary_query.ts";
import { buildChatSession, runChatTurn } from "./turn.ts";
import { createUsageRecorder } from "./usage_recorder.ts";

// End to end over the real pieces: the harness's own `runAgent` loop, the cli's `createUsageRecorder`
// realization, the real `upsertLlmUsage`, and a real migrated SQLite file. Only the model is a stub —
// everything between the completed call and the persisted row is production code, which is the point:
// the seam, the mapping, and the schema each look right in isolation and can still disagree about
// which column an id lands in.
//
// The session is built by `buildChatSession`, the same function the TUI and the REPL drive, so the
// attribution asserted below is the attribution a real chat turn produces rather than a fixture's guess.

let conn: Database;

beforeEach(() => {
    conn = freshDb();
});

/** Silent logger — a passing run logs nothing, and a failing write would be a test failure, not a log to read. */
const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    with: () => silentLogger,
    named: () => silentLogger,
    errorFields: (e: unknown): LogFields => ({ err: e }),
};

/**
 * A model stub that replies from a script, one entry per call, and records what it was asked.
 * Deliberately not the harness's own scripted-provider fixture: that lives behind a deep package path,
 * and the house rule admits only the barrel.
 */
function scriptedChat(script: readonly ChatResponse[]): AgentChat & { calls: ChatRequest[] } {
    const calls: ChatRequest[] = [];
    return {
        calls,
        capabilities: { toolCalling: true },
        chat: (request: ChatRequest) => {
            const reply = script[calls.length];
            calls.push(request);
            if (reply === undefined) throw new Error(`scriptedChat: no reply scripted for call ${calls.length - 1}`);
            return okAsync(reply);
        },
    };
}

function reply(content: ChatResponse["message"]["content"], finishReason: ChatResponse["finishReason"], usage: ChatUsage): ChatResponse {
    return { message: { role: "assistant", content }, finishReason, usage, requestedModelId: "asked-for", servedModelId: "answered-with" };
}

function agent(id: string, tools: readonly Tool[]): AgentDefinition {
    return { id, systemPrompt: "test agent", model: "claude-test", tools, maxIterations: 4 };
}

type UsageRow = {
    record_key: string;
    recorded_at: number;
    agent_id: string;
    call_path: string;
    scope_kind: string;
    scope_id: string;
    thread_id: string | null;
    run_id: string | null;
    step_id: string | null;
    requested_model_id: string | null;
    served_model_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
};

function rows(): UsageRow[] {
    return conn.query<UsageRow, []>("SELECT * FROM llm_usage ORDER BY agent_id, input_tokens").all();
}

describe("a chat turn's calls land in the local ledger", () => {
    test("one row per completed call, attributed to the analysis and thread with no run frame", async () => {
        const session = buildChatSession("tui-chat", "ana-ledger", "thr-ledger");
        // Two calls: the first asks for a tool, the second answers. "One row per call" is only testable
        // with more than one call, and a tool round-trip is how a real turn gets there.
        const chat = scriptedChat([
            reply([{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { label: "x" } }], "tool-calls", { inputTokens: 100, outputTokens: 20 }),
            reply([{ type: "text", text: "done" }], "stop", { inputTokens: 140, outputTokens: 35 }),
        ]);
        const echo: Tool = defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => ok({ label }),
        });

        await runAgent(agent("tui-chat", [echo]), [{ role: "user", content: "go" }], session, {
            provider: chat,
            signal: new AbortController().signal,
            emit: () => {},
            runStep: passthroughStep,
            usageRecorder: createUsageRecorder({ logger: silentLogger }),
        });

        const ledger = rows();
        expect(chat.calls).toHaveLength(2);
        expect(ledger).toHaveLength(2);
        for (const row of ledger) {
            expect(row.scope_kind).toBe("analysis");
            expect(row.scope_id).toBe("ana-ledger");
            expect(row.thread_id).toBe("thr-ledger");
            // The chat path runs outside any `RunFrame`, so there is no run or step to attribute to —
            // an id appearing in either column would mean the mapping invented a frame.
            expect(row.run_id).toBeNull();
            expect(row.step_id).toBeNull();
            expect(row.requested_model_id).toBe("asked-for");
            expect(row.served_model_id).toBe("answered-with");
            expect(row.recorded_at).toBeGreaterThan(0);
        }
        expect(ledger.map((r) => [r.input_tokens, r.output_tokens])).toEqual([
            [100, 20],
            [140, 35],
        ]);
        // Each call's key is distinct, so nothing collapsed two calls into one upserted row.
        expect(new Set(ledger.map((r) => r.record_key)).size).toBe(2);
    });

    test("the analysis total read back through the query layer is what the turn actually spent", async () => {
        const session = buildChatSession("tui-chat", "ana-total", "thr-total");
        const chat = scriptedChat([reply([{ type: "text", text: "done" }], "stop", { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60 })]);

        await runAgent(agent("tui-chat", []), [{ role: "user", content: "go" }], session, {
            provider: chat,
            signal: new AbortController().signal,
            emit: () => {},
            runStep: passthroughStep,
            usageRecorder: createUsageRecorder({ logger: silentLogger }),
        });

        const totals = getAnalysisUsageTotals("ana-total")._unsafeUnwrap();
        expect(totals).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60 });
        // The provider reported no cache writes and no reasoning, and the ledger says so rather than
        // reporting them as measured zeroes.
        expect(totals.cacheCreationInputTokens).toBeUndefined();
        expect(totals.reasoningTokens).toBeUndefined();
    });

    test("a sub-agent's calls reach the same ledger under its own id and call path", async () => {
        const session = buildChatSession("tui-chat", "ana-nested", "thr-nested");
        const recorder = createUsageRecorder({ logger: silentLogger });
        // The nested loop is what a real sub-agent tool (planner, literature reviewer) does: derive a
        // child session with `forSubAgent` and drive another `runAgent` under the SAME injected
        // recorder. Both loops' calls must arrive, each carrying its own agent id and chain.
        const subChat = scriptedChat([reply([{ type: "text", text: "planned" }], "stop", { inputTokens: 10, outputTokens: 2 })]);
        const planTool: Tool = defineTool({
            id: "plan",
            description: "Run the planner sub-agent.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async (_input, ctx) => {
                await runAgent(agent("planner", []), [{ role: "user", content: "plan" }], forSubAgent(ctx.session, "planner"), {
                    provider: subChat,
                    signal: ctx.signal,
                    emit: ctx.emit,
                    runStep: ctx.runStep,
                    usageRecorder: recorder,
                    ...(ctx.turnUsage === undefined ? {} : { turnUsage: ctx.turnUsage }),
                });
                return ok({ planned: true });
            },
        });
        const rootChat = scriptedChat([
            reply([{ type: "tool-call", toolCallId: "tc-1", toolName: "plan", input: {} }], "tool-calls", { inputTokens: 100, outputTokens: 20 }),
            reply([{ type: "text", text: "done" }], "stop", { inputTokens: 140, outputTokens: 35 }),
        ]);

        await runAgent(agent("tui-chat", [planTool]), [{ role: "user", content: "go" }], session, {
            provider: rootChat,
            signal: new AbortController().signal,
            emit: () => {},
            runStep: passthroughStep,
            usageRecorder: recorder,
        });

        const ledger = rows();
        expect(ledger).toHaveLength(3);
        expect(ledger.filter((r) => r.agent_id === "planner").map((r) => r.call_path)).toEqual(["tui-chat>planner"]);
        expect(ledger.filter((r) => r.agent_id === "tui-chat").map((r) => r.call_path)).toEqual(["tui-chat", "tui-chat"]);
        // Both loops attribute to the one analysis, so the analysis total covers the sub-agent's spend
        // — which is the whole reason a sub-agent records under the same injected realization.
        expect(getAnalysisUsageTotals("ana-nested")._unsafeUnwrap()).toMatchObject({ calls: 3, inputTokens: 250, outputTokens: 57 });
    });

    // The one test in this file that does NOT hand `runAgent` an options bag of its own making, and
    // the reason it exists: for a whole release the conversation agent recorded nothing, because
    // production built that bag without a `usageRecorder` while every test here built one with it.
    // `runAgent` reads the recorder from its OPTIONS and silently falls back to the no-op, so the
    // omission cost nothing at runtime — the turn succeeded, the header still showed a figure from the
    // finish rollup, and no row was written. A test that substitutes `runAgent` and asserts the
    // substitute was called cannot see that; only the production bag can be asked.
    //
    // So `run` here is the REAL `runAgent` and the options it receives are the ones `runChatTurn`
    // composes. Only `prepare` (Postgres) and the thread store are stood in for, and neither is on the
    // path between a completed call and a persisted row. A `turn.ts` that dropped the field again
    // produces zero rows below rather than a green test.
    test("the conversation agent's own calls reach the ledger through the production chat-turn path", async () => {
        const session = buildChatSession("tui-chat", "ana-chat-turn", "thr-chat-turn");
        const chat = scriptedChat([reply([{ type: "text", text: "answered" }], "stop", { inputTokens: 320, outputTokens: 44 })]);
        const userMessage = { role: "user", content: "go" } as const;
        // The thread store is Postgres-backed; the append is orthogonal to accounting (the turn carries
        // its fault separately), so a store that records nothing keeps this test offline without
        // touching the path under test.
        const history: ThreadHistory = {
            appendTurn: () => okAsync(undefined),
            loadRecent: () => okAsync([]),
            loadPage: () => okAsync({ messages: [], total: 0, page: 1, perPage: 200, hasMore: false }),
            loadAll: () => okAsync([]),
            retractLastTurn: () => okAsync({ kind: "empty-thread" }),
            latestSeq: () => okAsync(null),
            latestTurnAt: () => okAsync(null),
            countUserTurnsAfter: () => okAsync(0),
        };

        const outcome = await runChatTurn(
            {
                // `prepare` is the only thing that would dereference it, and it is stood in for below.
                pool: {} as unknown as Pool,
                agents: { forThread: () => ok(agent("tui-chat", [])) },
                chat: () => chat,
                history,
                session,
                emit: () => {},
                signal: new AbortController().signal,
                usageRecorder: createUsageRecorder({ logger: silentLogger }),
                analysisId: "ana-chat-turn",
                threadId: "thr-chat-turn",
                userInput: "go",
            },
            { prepare: () => Promise.resolve({ kind: "ok", threadType: "conversation", messages: [userMessage], userMessage }), run: runAgent },
        );

        expect(outcome.kind).toBe("ok");
        const ledger = rows();
        expect(ledger).toHaveLength(1);
        // Under the CONVERSATION agent's own id — the attribution that was missing from every row the
        // real ledger held, where only sub-agents and workflow agents ever appeared.
        expect(ledger[0]).toMatchObject({ agent_id: "tui-chat", call_path: "tui-chat", thread_id: "thr-chat-turn", input_tokens: 320, output_tokens: 44 });
        expect(getAnalysisUsageTotals("ana-chat-turn")._unsafeUnwrap()).toMatchObject({ calls: 1, inputTokens: 320, outputTokens: 44 });
    });

    test("a re-delivered record updates its row in place instead of double-counting the turn", async () => {
        const session = buildChatSession("tui-chat", "ana-replay", "thr-replay");
        const recorder = createUsageRecorder({ logger: silentLogger });
        // A replayed durable body re-fires `record` with a byte-identical key. Chat keys are minted
        // per call, so the re-delivery is staged by hand — the property under test is the sink's, not
        // the key scheme's.
        const call = {
            recordKey: "run-1:step-a:tui-chat:llm-0",
            agentId: "tui-chat",
            callPath: session.provenance.callPath,
            scope: session.scope,
            runId: "run-1",
            stepId: "step-a",
            usage: { inputTokens: 100, outputTokens: 20 },
        } as const;

        recorder.record(call);
        recorder.record({ ...call, usage: { inputTokens: 140, outputTokens: 35 } });

        const ledger = rows();
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ input_tokens: 140, output_tokens: 35, run_id: "run-1", step_id: "step-a" });
        expect(getAnalysisUsageTotals("ana-replay")._unsafeUnwrap()).toMatchObject({ calls: 1, inputTokens: 140 });
    });
});
