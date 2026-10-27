import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";
import { defineTool, type AgentDefinition, type AgentSession, type Pool, type Tool } from "@inflexa-ai/harness";
import { inProcessChatTurns, reply, scriptedModel, text, toolCall, type ScriptStep } from "@inflexa-ai/harness/testing";

import { freshDb } from "../../test_support/db.ts";
import { getAnalysisUsageTotals } from "../../db/primary_query.ts";
import { buildChatSession, runChatTurn, type TurnOutcome } from "./turn.ts";
import { createUsageRecorder } from "./usage_recorder.ts";

// End to end over the real pieces: the cli's turn engine, the harness's own chat turn and loop (in process,
// through the chat turns of the test kit), the cli's `createUsageRecorder` realization, the real
// `upsertLlmUsage`, and a real migrated SQLite file. Only the model, the Postgres of the harness, and the
// workflow engine are stand-ins — everything between the completed call and the persisted row is
// production code, which is the point: the seam, the mapping, and the schema each look right in isolation
// and can still disagree about which column an id lands in.
//
// The session is built by `buildChatSession`, the same function the TUI and the REPL drive, and the
// harness turn stamps the provenance from the resolved agent. Thus the attribution asserted below is the
// attribution a real chat turn produces rather than a fixture's guess.

/**
 * The Postgres of the harness turn, holding no row. Each read finds nothing, and the writes of the turn
 * land nowhere, which the turn reports as a store fault and survives. Thus the model calls are the only
 * thing of the turn that reaches a store, and that store is the ledger under test.
 */
const emptyPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
} as unknown as Pool;

let conn: Database;

beforeEach(() => {
    conn = freshDb();
});

function agent(id: string, tools: readonly Tool[]): AgentDefinition {
    return { id, systemPrompt: "test agent", model: "claude-test", tools, maxIterations: 4 };
}

/** One chat turn of `conversation-agent` through the production engine, over a scripted model and the cli's recorder. */
async function chatTurn(analysisId: string, threadId: string, script: readonly ScriptStep[], tools: readonly Tool[] = []): Promise<TurnOutcome> {
    const model = scriptedModel(script);
    const conversation = agent("conversation-agent", tools);
    const outcome = await runChatTurn(
        {
            chatTurns: inProcessChatTurns({
                pool: emptyPool,
                agents: { forThread: () => ok(conversation) },
                provider: model.provider,
                usageRecorder: createUsageRecorder(),
            }),
            session: buildChatSession(analysisId, threadId),
            emit: () => {},
            signal: new AbortController().signal,
            analysisId,
            threadId,
            userInput: "go",
        },
        // No identity: these cases are about the usage ledger, thus the turn stamps no author.
        { readAuthor: () => null },
    );
    expect(model.calls).toHaveLength(script.length);
    return outcome;
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
    test("one row per completed call of the conversation agent, attributed to the analysis and thread with no run frame", async () => {
        // Two calls: the first asks for a tool, the second answers. "One row per call" is only testable
        // with more than one call, and a tool round-trip is how a real turn gets there.
        const echo: Tool = defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => ok({ label }),
        });

        const outcome = await chatTurn(
            "ana-ledger",
            "thr-ledger",
            [
                { ...reply([toolCall("tc-1", "echo", { label: "x" })], "tool-calls", { inputTokens: 100, outputTokens: 20 }), modelId: "answered-with" },
                { ...reply([text("done")], "stop", { inputTokens: 140, outputTokens: 35 }), modelId: "answered-with" },
            ],
            [echo],
        );

        expect(outcome.kind).toBe("ok");
        const ledger = rows();
        expect(ledger).toHaveLength(2);
        for (const row of ledger) {
            // Under the CONVERSATION agent's own id — the attribution that was missing from every row the
            // real ledger once held, where only sub-agents and workflow agents ever appeared.
            expect(row.agent_id).toBe("conversation-agent");
            expect(row.call_path).toBe("conversation-agent");
            expect(row.scope_kind).toBe("analysis");
            expect(row.scope_id).toBe("ana-ledger");
            expect(row.thread_id).toBe("thr-ledger");
            // The chat path runs outside any `RunFrame`, so there is no run or step to attribute to —
            // an id appearing in either column would mean the mapping invented a frame.
            expect(row.run_id).toBeNull();
            expect(row.step_id).toBeNull();
            expect(row.requested_model_id).toBe("scripted-model");
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
        await chatTurn("ana-total", "thr-total", [reply([text("done")], "stop", { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60 })]);

        const totals = getAnalysisUsageTotals("ana-total")._unsafeUnwrap();
        expect(totals).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60 });
        // The provider reported no cache writes and no reasoning, and the ledger says so rather than
        // reporting them as measured zeroes.
        expect(totals.cacheCreationInputTokens).toBeUndefined();
        expect(totals.reasoningTokens).toBeUndefined();
    });

    test("a re-delivered record updates its row in place instead of double-counting the turn", async () => {
        const session: AgentSession = {
            ...buildChatSession("ana-replay", "thr-replay"),
            provenance: { agentId: "conversation-agent", callPath: ["conversation-agent"] },
        };
        const recorder = createUsageRecorder();
        // A replayed durable body re-fires `record` with a byte-identical key. Chat keys are minted
        // per call, so the re-delivery is staged by hand — the property under test is the sink's, not
        // the key scheme's.
        const call = {
            recordKey: "run-1:step-a:conversation-agent:response-0",
            agentId: "conversation-agent",
            callPath: session.provenance.callPath,
            scope: session.scope,
            runId: "run-1",
            stepId: "step-a",
            usage: { inputTokens: 100, outputTokens: 20 },
        } as const;

        expect((await recorder.record(call)).isOk()).toBe(true);
        expect((await recorder.record({ ...call, usage: { inputTokens: 140, outputTokens: 35 } })).isOk()).toBe(true);

        const ledger = rows();
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ input_tokens: 140, output_tokens: 35, run_id: "run-1", step_id: "step-a" });
        expect(getAnalysisUsageTotals("ana-replay")._unsafeUnwrap()).toMatchObject({ calls: 1, inputTokens: 140 });
    });
});
