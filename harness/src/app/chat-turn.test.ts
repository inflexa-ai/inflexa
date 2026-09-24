import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { err, errAsync, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { withSchema } from "../__tests__/setup/postgres.js";
import { forSubAgent } from "../auth/types.js";
import { createNoopUsageRecorder } from "../billing/noop-usage-recorder.js";
import type { LlmUsageRecord, UsageRecorder } from "../billing/usage-recorder.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock, type ScriptedProvider } from "../loop/__fixtures__/scripted-provider.js";
import { runAgent } from "../loop/run-agent.js";
import type { AgentDefinition } from "../loop/types.js";
import { compactionExchangeOf, compactionMarkerOf, contextRecordOf } from "../memory/ai-sdk-message-storage.js";
import { storedMessagesToCortex } from "../memory/conversation-display-replay.js";
import { createThreadStore } from "../memory/thread-store.js";
import { conversationRecordTurn, createThreadHistory, type StoredMessage } from "../memory/thread-history.js";
import { NOT_RUN_TOOL_RESULT } from "../memory/tool-call-integrity.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ProviderError } from "../providers/errors.js";
import { MEMORY_COMPACTION_REQUEST, SUMMARY_COMPACTION_REQUEST } from "../prompts/compaction.js";
import { createStreamingChat } from "../providers/streaming-chat.js";
import type { AgentChat, ChatProvider, ChatRequest, ChatResponse, ChatUsage } from "../providers/types.js";
import type { ThreadAgentResolver } from "../runtime/assemble.js";
import { insertRun, updateRunStatus } from "../state/index.js";
import { createToolOutputStore } from "../state/tool-outputs.js";
import type { SessionProvenanceEvent } from "../provenance/seam.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { createUpdateWorkingMemoryTool } from "../tools/memory/update-working-memory.js";
import { createReadToolOutputTool } from "../tools/read-tool-output.js";
import { suspensionOfFailure } from "../workflows/suspension.js";
import { DEFAULT_CONVERSATION_BUDGET, openChatTurn, prepareChatTurn, runChatTurn, type RunChatTurnParams } from "./chat-turn.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("chat-turn"));
});

afterEach(async () => {
    await drop();
});

/** Flatten a message's content to a searchable string. */
function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((b) => (typeof b === "object" && b && "text" in b ? String(b.text) : "")).join("\n");
    }
    return "";
}

describe("prepareChatTurn", () => {
    it("returns not_found when the thread is owned by a different analysis", async () => {
        const store = createThreadStore(pool);
        (
            await store.createThread({
                threadId: "t1",
                analysisId: ANALYSIS_B,
                title: "Owned by B",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t1", userInput: "hello" });

        expect(result.kind).toBe("not_found");
        // Ownership untouched — the foreign thread still belongs to B.
        const still = (await store.getThread("t1"))._unsafeUnwrap();
        expect(still!.analysisId).toBe(ANALYSIS_B);
    });

    it("creates the thread with a derived title and returns ok with history + new input", async () => {
        const store = createThreadStore(pool);
        const history = createThreadHistory(pool);

        // Seed one prior turn so it must appear in the assembled window.
        (
            await history.appendTurn("t-new", {
                modelMessages: [
                    { role: "user", content: "earlier question about PCA" },
                    { role: "assistant", content: "earlier answer" },
                ],
                displayMessages: [],
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool },
            {
                analysisId: ANALYSIS_A,
                threadId: "t-new",
                userInput: "run a differential expression analysis please",
            },
        );

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        // Thread row created with a derived title.
        const created = (await store.getThread("t-new"))._unsafeUnwrap();
        expect(created).not.toBeNull();
        expect(created!.analysisId).toBe(ANALYSIS_A);
        expect(created!.title).toBe(deriveThreadTitle("run a differential expression analysis please"));

        // userMessage carries the new input.
        expect(contentText(result.userMessage.content)).toContain("run a differential expression analysis please");

        // messages include the prior turn's history AND the new user input.
        const joined = result.messages.map((m) => contentText(m.content)).join("\n");
        expect(joined).toContain("earlier question about PCA");
        expect(joined).toContain("earlier answer");
        expect(joined).toContain("run a differential expression analysis please");
        expect(joined).toContain("[Run Activity]");
        expect(joined).toContain("No runs are currently running or suspended.");
        expect(contentText(result.userMessage.content)).not.toContain("[Run Activity]");
        expect(result.messages.slice(-1 - result.contextRecords.length)).toEqual([result.userMessage, ...result.contextRecords]);
        expect(result.contextRecords.map((record) => contextRecordOf(record)?.kind)).toEqual(["run-activity", "working-memory"]);
    });

    it("leaves an existing non-empty title unchanged", async () => {
        const store = createThreadStore(pool);
        (
            await store.createThread({
                threadId: "t-titled",
                analysisId: ANALYSIS_A,
                title: "My Existing Title",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool },
            {
                analysisId: ANALYSIS_A,
                threadId: "t-titled",
                userInput: "a brand new message that would derive a different title",
            },
        );

        expect(result.kind).toBe("ok");
        const after = (await store.getThread("t-titled"))._unsafeUnwrap();
        expect(after!.title).toBe("My Existing Title");
    });

    it("injects analysis-wide running and suspended runs regardless of launching thread", async () => {
        (
            await insertRun(pool, { runId: "run-other-thread", analysisId: ANALYSIS_A, threadId: "other-thread", workflowName: "executeAnalysis" })
        )._unsafeUnwrap();
        (
            await insertRun(pool, {
                runId: "run-suspended",
                analysisId: ANALYSIS_A,
                threadId: "another-thread",
                workflowName: "executeAnalysis",
            })
        )._unsafeUnwrap();
        (await updateRunStatus(pool, "run-suspended", "suspended_insufficient_funds"))._unsafeUnwrap();
        (await insertRun(pool, { runId: "run-other-analysis", analysisId: ANALYSIS_B, workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "current-thread", userInput: "status?" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("Running:");
        expect(joined).toContain("runId: run-other-thread");
        expect(joined).toContain("Suspended:");
        expect(joined).toContain("runId: run-suspended");
        expect(joined).toContain("planId: none");
        expect(joined).not.toContain("run-other-analysis");
    });

    it("injects an unavailable state when only the activity read fails", async () => {
        const activityFailingPool = {
            query: (query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
                const text = typeof query === "string" ? query : query.text;
                if (text.includes("status IN ('running','suspended_insufficient_funds')")) {
                    return Promise.reject(new Error("activity unavailable"));
                }
                return pool.query(query as never, values as never);
            },
        } as unknown as Pool;

        const result = await prepareChatTurn({ pool: activityFailingPool }, { analysisId: ANALYSIS_A, threadId: "unavailable-thread", userInput: "hello" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("Run status is temporarily unavailable.");
        expect(joined).not.toContain("No runs are currently running or suspended.");
    });

    it("carries the stored conversation type on an existing thread", async () => {
        const store = createThreadStore(pool);
        (
            await store.createThread({
                threadId: "t-conv",
                analysisId: ANALYSIS_A,
                title: "A conversation",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-conv", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");
        expect(result.threadType).toBe("conversation");
    });

    it("carries the conversation type on a first-turn thread it creates", async () => {
        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-first", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");
        expect(result.threadType).toBe("conversation");

        // The created row matches the surfaced type.
        const created = (await createThreadStore(pool).getThread("t-first"))._unsafeUnwrap();
        expect(created!.threadType).toBe("conversation");
    });

    it("carries the stored report type on a report thread", async () => {
        // No production path creates a report thread yet — write one directly.
        (
            await createThreadStore(pool).createThread({
                threadId: "t-report",
                analysisId: ANALYSIS_A,
                title: "A report",
                type: "report",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-report", userInput: "hello" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");
        expect(result.threadType).toBe("report");
    });

    it("assembles no working-memory render on a report thread", async () => {
        (await createWorkingMemory(pool).updateSection(ANALYSIS_A, "goal", { text: "Find the driver genes." }))._unsafeUnwrap();
        (
            await createThreadStore(pool).createThread({
                threadId: "t-report-tail",
                analysisId: ANALYSIS_A,
                title: "A report",
                type: "report",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-report-tail", userInput: "draft the summary" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).not.toContain("# Working Memory");
        expect(joined).not.toContain("Find the driver genes.");
        expect(joined).toContain("[Run Activity]");
        expect(joined).toContain("draft the summary");
    });

    it("emits one create-session event when it writes a new conversation thread", async () => {
        const events: SessionProvenanceEvent[] = [];

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-observed", userInput: "hello" },
        );

        expect(result.kind).toBe("ok");
        expect(events).toEqual([{ type: "create-session", analysisId: ANALYSIS_A, threadId: "t-observed", sessionKind: "conversation" }]);
    });

    it("emits nothing on a turn over a thread that the store already holds", async () => {
        const events: SessionProvenanceEvent[] = [];
        (await createThreadStore(pool).createThread({ threadId: "t-already", analysisId: ANALYSIS_A, title: "Already here" }))._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-already", userInput: "hello again" },
        );

        expect(result.kind).toBe("ok");
        expect(events).toEqual([]);
    });

    it("emits nothing on a turn over an archived thread", async () => {
        const events: SessionProvenanceEvent[] = [];
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: "t-archived", analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        (await store.archiveThread("t-archived"))._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-archived", userInput: "hello again" },
        );

        expect(result.kind).toBe("ok");
        expect(events).toEqual([]);
    });

    it("emits nothing for a thread that another analysis owns", async () => {
        const events: SessionProvenanceEvent[] = [];
        (await createThreadStore(pool).createThread({ threadId: "t-foreign", analysisId: ANALYSIS_B, title: "Owned by B" }))._unsafeUnwrap();

        const result = await prepareChatTurn(
            { pool, provenance: { emitSessionEvent: (event) => events.push(event) } },
            { analysisId: ANALYSIS_A, threadId: "t-foreign", userInput: "hello" },
        );

        expect(result.kind).toBe("not_found");
        expect(events).toEqual([]);
    });

    it("assembles the working-memory render on a conversation thread", async () => {
        (await createWorkingMemory(pool).updateSection(ANALYSIS_A, "goal", { text: "Find the driver genes." }))._unsafeUnwrap();
        (
            await createThreadStore(pool).createThread({
                threadId: "t-conv-tail",
                analysisId: ANALYSIS_A,
                title: "A conversation",
            })
        )._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-conv-tail", userInput: "draft the summary" });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.messages.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("# Working Memory");
        expect(joined).toContain("Find the driver genes.");
    });
});

// --- runChatTurn ------------------------------------------------------------

describe("runChatTurn", () => {
    const THREAD = "t-turn";

    function echoTool(): Tool {
        return defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => ok({ label }),
        });
    }

    function agentWith(tools: Tool[], systemPrompt = "You are the test conversation agent."): AgentDefinition {
        return { id: "conversation-agent", systemPrompt, model: "claude-test", tools, maxIterations: 8 };
    }

    function resolverFor(agent: AgentDefinition): ThreadAgentResolver {
        return { forThread: (type) => (type === "conversation" ? ok(agent) : err({ type: "unregistered_thread_type", threadType: type })) };
    }

    function params(provider: AgentChat, overrides: Partial<RunChatTurnParams> = {}): RunChatTurnParams {
        return {
            analysisId: ANALYSIS_A,
            threadId: THREAD,
            userInput: "compare the two groups",
            session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_A, threadId: THREAD } }),
            chat: () => provider,
            emit: () => {},
            signal: new AbortController().signal,
            usageRecorder: createNoopUsageRecorder(),
            ...overrides,
        };
    }

    const toolCall = (id: string, usage?: ChatUsage): ChatResponse => makeMessage([toolUseBlock(id, "echo", { label: id })], "tool_use", usage);

    /** A provider that answers with `replies`, and then fails each later request with `failure`. */
    function failingAfter(replies: readonly ChatResponse[], failure: ProviderError): AgentChat {
        let calls = 0;
        return {
            capabilities: { toolCalling: true },
            chat: () => (calls < replies.length ? okAsync(replies[calls++]!) : errAsync(failure)),
        };
    }

    /** The cache directive on the system prompt of a request. */
    function systemDirective(request: ChatRequest): unknown {
        return typeof request.system === "string" ? undefined : request.system.providerOptions?.["anthropic"]?.["cacheControl"];
    }

    async function storedRows(threadId = THREAD): Promise<StoredMessage[]> {
        return (await createThreadHistory(pool).loadAll(threadId))._unsafeUnwrap().flat();
    }

    async function turnRecords(threadId = THREAD): Promise<{ status: string; reason: string | null }[]> {
        const { rows } = await pool.query<{ status: string; reason: string | null }>(
            "SELECT status, reason FROM cortex_thread_turns WHERE thread_id = $1 ORDER BY start_seq",
            [threadId],
        );
        return rows;
    }

    it("stores the opening, each round, and a done record with the rollup and the duration", async () => {
        const provider = scriptedProvider([
            toolCall("tu-1", { inputTokens: 100, outputTokens: 10 }),
            makeMessage([textBlock("the groups differ")], "end_turn", { inputTokens: 120, outputTokens: 20 }),
        ]);

        const result = await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider, { startedAtMs: Date.now() - 1_000 }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" }, opened: true, turnUsage: { inputTokens: 220, outputTokens: 30 } });
        expect("storeError" in result).toBe(false);
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "tool", "assistant"]);
        expect(rows.slice(1, 3).map((row) => contextRecordOf(row.message)?.kind)).toEqual(["run-activity", "working-memory"]);
        expect(rows[0]!.turn).toMatchObject({ status: "done", usage: { inputTokens: 220, outputTokens: 30 } });
        expect(rows[0]!.turn!.durationMs).toBeGreaterThanOrEqual(1_000);
    });

    it("reads a stored turn back as one user message and one assistant message", async () => {
        const provider = scriptedProvider([toolCall("tu-1"), makeMessage([textBlock("the groups differ")], "end_turn")]);
        await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider));

        const replay = storedMessagesToCortex(await storedRows());

        expect(replay.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(replay[1]!.parts).toEqual([
            { type: "tool-call", toolCallId: "tu-1", toolName: "echo", outcome: "ok" },
            { type: "text", text: "the groups differ" },
        ]);
    });

    it("keeps two rounds, adds the note, and closes failed when the third request fails on the credential", async () => {
        const provider = failingAfter([toolCall("tu-1"), toolCall("tu-2")], {
            type: "auth",
            retryable: false,
            message: "401 Unauthorized at https://models.example/v1 with key sk-secret-123",
        });

        const result = await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "The model endpoint refused the credential." } });
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "tool", "assistant", "tool", "user"]);
        expect(rows.at(-1)!.message.content).toBe(
            "[Turn Failed]\nThe turn stopped before it finished. Reason: The model endpoint refused the credential.\nThe rounds above this note ran, and their results are stored.",
        );
        expect(JSON.stringify(rows.map((row) => row.message))).not.toContain("sk-secret-123");
        expect(await turnRecords()).toEqual([{ status: "failed", reason: "The model endpoint refused the credential." }]);
    });

    it("starts the next turn with each stored row of the failed turn, byte-identical", async () => {
        const failing = failingAfter([toolCall("tu-1"), toolCall("tu-2")], { type: "auth", retryable: false, message: "401" });
        const agents = resolverFor(agentWith([echoTool()]));
        await runChatTurn({ pool, agents }, params(failing));
        const stored = (await storedRows()).map((row) => row.message);
        const next = scriptedProvider([makeMessage([textBlock("continuing")], "end_turn")]);

        await runChatTurn({ pool, agents }, params(next, { userInput: "try again", promptCache: "off" }));

        expect(JSON.stringify(next.calls[0]!.messages.slice(0, stored.length))).toBe(JSON.stringify(stored));
    });

    it("closes failed with the reason of the host on a suspend error", async () => {
        const provider = failingAfter([], { type: "suspend", retryable: false, reason: "payment_required", status: 402, message: "Payment Required" });

        const result = await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "payment_required" } });
        if (result.kind !== "ran" || result.outcome.status !== "failed") throw new Error("unreachable");
        expect(suspensionOfFailure(result.outcome.cause)).toEqual({ kind: "suspended", reason: "payment_required" });
        expect(await turnRecords()).toEqual([{ status: "failed", reason: "payment_required" }]);
    });

    it("stores the opening and closes aborted on an abort before any output", async () => {
        const controller = new AbortController();
        const provider = scriptedProvider((): ChatResponse => {
            controller.abort();
            return { message: { role: "assistant", content: "" }, finishReason: "aborted" };
        });

        const result = await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider, { signal: controller.signal }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "aborted" }, opened: true });
        expect((await storedRows()).map((row) => row.message.role)).toEqual(["user", "user", "user"]);
        expect(await turnRecords()).toEqual([{ status: "aborted", reason: null }]);
    });

    it("closes failed on an AbortError of a tool under a live signal, and keeps the call with a not-run result", async () => {
        const stall = defineTool({
            id: "stall",
            description: "Throws an AbortError that no abort of the turn caused.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw new DOMException("The operation was aborted", "AbortError");
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "stall", {})], "tool_use")]);

        const result = await runChatTurn({ pool, agents: resolverFor(agentWith([stall])) }, params(provider));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "The turn stopped on an internal error." } });
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "tool", "user"]);
        const answer = rows[4]!.message.content as ToolResultPart[];
        expect(answer.map((part) => [part.toolCallId, part.output])).toEqual([["tu-1", { type: "error-text", value: NOT_RUN_TOOL_RESULT }]]);
    });

    it("writes no row and no record when the resolver refuses the thread type", async () => {
        (await createThreadStore(pool).createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        const provider = scriptedProvider([]);

        const result = await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider));

        expect(result).toEqual({ kind: "agent_unresolved", threadType: "report" });
        expect(await storedRows()).toEqual([]);
        expect(await turnRecords()).toEqual([]);
        expect(provider.calls).toEqual([]);
    });

    it("adds no context record on a second turn with no change", async () => {
        const agents = resolverFor(agentWith([echoTool()]));
        await runChatTurn({ pool, agents }, params(scriptedProvider([makeMessage([textBlock("first answer")], "end_turn")])));

        await runChatTurn({ pool, agents }, params(scriptedProvider([makeMessage([textBlock("second answer")], "end_turn")]), { userInput: "and now?" }));

        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "user", "assistant"]);
        expect(contextRecordOf(rows[4]!.message)).toBeUndefined();
    });

    it("opens a report thread with the report agent, and runs it under the provenance of that agent", async () => {
        (await createThreadStore(pool).createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        const records: LlmUsageRecord[] = [];
        const usageRecorder: UsageRecorder = {
            record: (record) => {
                records.push(record);
                return okAsync(undefined);
            },
        };
        const report: AgentDefinition = { ...agentWith([echoTool()]), id: "report-session-agent" };
        const agents: ThreadAgentResolver = { forThread: (type) => ok(type === "report" ? report : agentWith([echoTool()])) };
        const { provenance: _hostProvenance, ...session } = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_A, threadId: THREAD } });
        const { analysisId, threadId, userInput, ...run } = params(
            scriptedProvider([makeMessage([textBlock("drafted")], "end_turn", { inputTokens: 5, outputTokens: 1 })]),
            { session, usageRecorder },
        );

        const opened = await openChatTurn({ pool, agents }, { analysisId, threadId, userInput });
        if (opened.kind !== "ready") throw new Error(`expected an open turn, got ${opened.kind}`);
        const result = await opened.run(run);

        expect(opened.agent.id).toBe("report-session-agent");
        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" } });
        expect(records.map((record) => [record.agentId, record.callPath])).toEqual([["report-session-agent", ["report-session-agent"]]]);
    });

    it("refuses a thread of a different analysis at the open, before any row of the turn", async () => {
        (await createThreadStore(pool).createThread({ threadId: THREAD, analysisId: ANALYSIS_B, title: "Owned by B" }))._unsafeUnwrap();

        const opened = await openChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, { analysisId: ANALYSIS_A, threadId: THREAD, userInput: "hi" });

        expect(opened).toEqual({ kind: "not_found" });
        expect(await storedRows()).toEqual([]);
        expect(await turnRecords()).toEqual([]);
    });

    it("stores the display of the user message with the secrets redacted", async () => {
        const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
        const provider = scriptedProvider([makeMessage([textBlock("noted")], "end_turn")]);

        await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider, { userInput: `use the key ${secret}` }));

        const replay = storedMessagesToCortex(await storedRows());
        expect(replay[0]!.parts).toEqual([{ type: "text", text: "use the key [REDACTED: OpenAI API Key]" }]);
        expect(JSON.stringify(replay)).not.toContain(secret);
    });

    it("gives the usage recorder of the host to the root loop", async () => {
        const records: LlmUsageRecord[] = [];
        const usageRecorder: UsageRecorder = {
            record: (record) => {
                records.push(record);
                return okAsync(undefined);
            },
        };
        const provider = scriptedProvider([makeMessage([textBlock("hi")], "end_turn", { inputTokens: 10, outputTokens: 2 })]);

        await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider, { usageRecorder }));

        expect(records.map((record) => [record.agentId, record.usage])).toEqual([["conversation-agent", { inputTokens: 10, outputTokens: 2 }]]);
    });

    it("stores the excerpt of a long tool result in its round, and keeps the whole text under the reference of the excerpt", async () => {
        // Words, not one long run of a character: the write-time token count is slow on a long unbroken word.
        const text = "TP53 7 ".repeat(7_143).slice(0, 50_000);
        const long = defineTool({
            id: "long",
            description: "Give a long text.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok(text),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "long", {})], "tool_use"), makeMessage([textBlock("read it")], "end_turn")]);

        await runChatTurn({ pool, agents: resolverFor(agentWith([long, createReadToolOutputTool(createToolOutputStore(pool))])) }, params(provider));

        const round = (await storedRows()).find((row) => row.message.role === "tool")!;
        const output = (round.message.content as ToolResultPart[])[0]!.output;
        expect(output.type).toBe("text");
        const excerpt = (output as { value: string }).value;
        expect(excerpt.startsWith("[Tool result cut: 50002 characters")).toBe(true);
        expect(excerpt.length).toBeLessThan(text.length);
        const ref = /reference "(to_[0-9a-f]{20})"/.exec(excerpt)![1]!;
        const { rows } = await pool.query<{ thread_id: string | null; content: string; total_length: number }>(
            "SELECT thread_id, content, total_length FROM cortex_tool_outputs WHERE analysis_id = $1 AND ref = $2",
            [ANALYSIS_A, ref],
        );
        expect(rows).toEqual([{ thread_id: THREAD, content: JSON.stringify(text), total_length: 50_002 }]);
    });

    it("sends the 1-hour cache directive from the root loop", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("hi")], "end_turn")]);

        await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider));

        const request = provider.calls[0]!;
        expect(systemDirective(request)).toEqual({ type: "ephemeral", ttl: "1h" });
        expect(request.messages.at(-1)!.providerOptions?.["anthropic"]?.["cacheControl"]).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("sends the cache directive of a host policy", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("hi")], "end_turn")]);

        await runChatTurn({ pool, agents: resolverFor(agentWith([echoTool()])) }, params(provider, { promptCache: { ttl: "5m" } }));

        expect(systemDirective(provider.calls[0]!)).toEqual({ type: "ephemeral", ttl: "5m" });
    });

    it("sends the 5-minute cache directive from a sub-agent loop of the turn", async () => {
        const SUB_PROMPT = "You are the test sub-agent.";
        const provider = scriptedProvider((callIndex, request) => {
            if (request.system !== undefined && JSON.stringify(request.system).includes(SUB_PROMPT)) return makeMessage([textBlock("sub answer")], "end_turn");
            return callIndex === 0 ? makeMessage([toolUseBlock("tu-1", "delegate", {})], "tool_use") : makeMessage([textBlock("done")], "end_turn");
        });
        const delegate = defineTool({
            id: "delegate",
            description: "Run a sub-agent.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async (_input, ctx) => {
                const sub = await runAgent(agentWith([], SUB_PROMPT), [{ role: "user", content: "brief" }], forSubAgent(ctx.session, "sub-agent"), {
                    provider,
                    signal: ctx.signal,
                    emit: ctx.emit,
                    runStep: ctx.runStep,
                    ...(ctx.turnUsage === undefined ? {} : { turnUsage: ctx.turnUsage }),
                });
                return ok({ answer: sub.finish.reason });
            },
        });

        await runChatTurn({ pool, agents: resolverFor(agentWith([delegate])) }, params(provider));

        expect(provider.calls.map((call) => [JSON.stringify(call.system).includes(SUB_PROMPT), systemDirective(call)])).toEqual([
            [false, { type: "ephemeral", ttl: "1h" }],
            [true, { type: "ephemeral", ttl: "5m" }],
            [false, { type: "ephemeral", ttl: "1h" }],
        ]);
    });

    it("stores a round that failed to land with the next round, in order", async () => {
        let failed = false;
        const failingOnce = new Proxy(pool, {
            get(target, prop, receiver) {
                if (prop !== "connect") {
                    const value: unknown = Reflect.get(target, prop, receiver);
                    return typeof value === "function" ? value.bind(target) : value;
                }
                return async () => {
                    const client = await target.connect();
                    return new Proxy(client, {
                        get(inner, key, innerReceiver) {
                            const value: unknown = Reflect.get(inner, key, innerReceiver);
                            if (key !== "query" || typeof value !== "function") return typeof value === "function" ? value.bind(inner) : value;
                            return (text: unknown, values?: unknown[]) => {
                                // The first row of the first round takes seq 3, after the three rows of the opening.
                                if (!failed && typeof text === "string" && text.includes("INSERT INTO messages") && values?.[1] === 3) {
                                    failed = true;
                                    return Promise.reject(new Error("simulated insert failure"));
                                }
                                return value.call(inner, text, values);
                            };
                        },
                    });
                };
            },
        });
        const provider = scriptedProvider([toolCall("tu-1"), toolCall("tu-2"), makeMessage([textBlock("done")], "end_turn")]);

        const result = await runChatTurn({ pool: failingOnce, agents: resolverFor(agentWith([echoTool()])) }, params(provider));

        expect(failed).toBe(true);
        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" }, opened: true });
        expect("storeError" in result).toBe(false);
        const rows = await storedRows();
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(rows.filter((row) => row.message.role === "tool").map((row) => (row.message.content as ToolResultPart[])[0]!.toolCallId)).toEqual([
            "tu-1",
            "tu-2",
        ]);
    });
});

// --- runChatTurn compaction ---------------------------------------------------

describe("runChatTurn — compaction", () => {
    const THREAD = "t-compact";
    const SUMMARY = "The user compares two groups of samples.";

    const big = (n: number): string => Array.from({ length: n }, () => "word").join(" ");

    function echoTool(): Tool {
        return defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: async ({ label }) => ok({ label }),
        });
    }

    function conversationAgent(): AgentDefinition {
        return {
            id: "conversation-agent",
            systemPrompt: "You are the test conversation agent.",
            model: "claude-test",
            tools: [echoTool(), createUpdateWorkingMemoryTool(createWorkingMemory(pool), pool)],
            maxIterations: 8,
        };
    }

    function reportAgent(): AgentDefinition {
        return { id: "report-session-agent", systemPrompt: "You are the test report agent.", model: "claude-test", tools: [echoTool()], maxIterations: 8 };
    }

    const agents: () => ThreadAgentResolver = () => ({
        forThread: (type) => ok(type === "report" ? reportAgent() : conversationAgent()),
    });

    function isExchangeRequest(request: ChatRequest): boolean {
        return request.messages.some((message) => message.content === MEMORY_COMPACTION_REQUEST || message.content === SUMMARY_COMPACTION_REQUEST);
    }

    /** A provider that answers the task requests from `task` and the requests of an exchange from `exchange`. */
    function compactingProvider(task: readonly ChatResponse[], exchange: readonly ChatResponse[]): ScriptedProvider {
        let taskCalls = 0;
        let exchangeCalls = 0;
        return scriptedProvider((_callIndex, request) => {
            const reply = isExchangeRequest(request) ? exchange[exchangeCalls++] : task[taskCalls++];
            if (reply === undefined) throw new Error("no scripted reply");
            return reply;
        });
    }

    const bigCall = (id: string): ChatResponse => makeMessage([toolUseBlock(id, "echo", { label: big(1_500) })], "tool_use");
    const text = (reply: string): ChatResponse => makeMessage([textBlock(reply)], "end_turn");

    function params(provider: ChatProvider, overrides: Partial<RunChatTurnParams> = {}): RunChatTurnParams {
        return {
            analysisId: ANALYSIS_A,
            threadId: THREAD,
            userInput: "compare the two groups",
            session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_A, threadId: THREAD } }),
            chat: (emit) => createStreamingChat(provider, (delta) => void emit({ type: "text-delta", text: delta })),
            emit: () => {},
            signal: new AbortController().signal,
            usageRecorder: createNoopUsageRecorder(),
            conversationBudget: 1_000,
            ...overrides,
        };
    }

    async function storedRows(threadId = THREAD): Promise<StoredMessage[]> {
        return (await createThreadHistory(pool).loadAll(threadId))._unsafeUnwrap().flat();
    }

    function kindOf(message: ModelMessage): string {
        const marker = compactionMarkerOf(message);
        if (marker !== undefined) return `${marker.kind}-marker`;
        if (compactionExchangeOf(message) !== undefined) return `exchange-${message.role}`;
        return contextRecordOf(message)?.kind ?? message.role;
    }

    it("stores the opening, a round, the marked exchange, the marker, the records, and the later rounds", async () => {
        const provider = compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)]);

        const result = await runChatTurn({ pool, agents: agents() }, params(provider));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" }, opened: true });
        expect((await storedRows()).map((row) => kindOf(row.message))).toEqual([
            "user",
            "run-activity",
            "working-memory",
            "assistant",
            "tool",
            "exchange-user",
            "exchange-assistant",
            "summary-marker",
            "run-activity",
            "working-memory",
            "assistant",
        ]);
    });

    it("replays the divider between the two assistant messages of the turn, with two ids", async () => {
        const provider = compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)]);
        await runChatTurn({ pool, agents: agents() }, params(provider));

        const replay = storedMessagesToCortex(await storedRows());

        expect(replay.map((message) => message.role)).toEqual(["user", "assistant", "system", "assistant"]);
        expect(replay[1]!.id).not.toBe(replay[3]!.id);
        expect(replay[2]!.parts).toEqual([
            {
                type: "data-compaction",
                id: replay[2]!.id,
                status: "done",
                tokensBefore: expect.any(Number),
                tokensAfter: expect.any(Number),
                durationMs: expect.any(Number),
            },
        ]);
        expect(JSON.stringify(replay)).not.toContain(SUMMARY);
        expect(replay[3]!.parts).toEqual([{ type: "text", text: "done" }]);
    });

    it("starts the next turn with the summary marker and its records, then the later rounds, then the new opening", async () => {
        await runChatTurn({ pool, agents: agents() }, params(compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)])));
        const next = scriptedProvider([text("next answer")]);

        await runChatTurn({ pool, agents: agents() }, params(next, { userInput: "and now?", conversationBudget: undefined, promptCache: "off" }));

        const sent = next.calls[0]!.messages;
        expect(sent.map(kindOf)).toEqual(["summary-marker", "run-activity", "working-memory", "assistant", "user"]);
        expect(sent[0]!.content).toBe(`[Conversation Summary]\n${SUMMARY}`);
        expect(sent.at(-1)!.content).toBe("and now?");
    });

    it("sends no text delta of the exchange to the emit of the host", async () => {
        const deltas: string[] = [];
        const provider = compactingProvider([bigCall("tu-1"), text("done")], [text(SUMMARY)]);

        await runChatTurn(
            { pool, agents: agents() },
            params(provider, {
                emit: (event) => {
                    if (event.type === "text-delta") deltas.push(event.text);
                },
            }),
        );

        expect(deltas).toEqual(["done"]);
    });

    it("puts a constraint that the exchange added into the working-memory record after the marker", async () => {
        const memoryEdit = makeMessage(
            [toolUseBlock("tu-m", "update_working_memory", { section: "constraint", text: "Use an FDR of 0.01.", origin: "user" })],
            "tool_use",
        );
        const provider = compactingProvider([bigCall("tu-1"), text("done")], [memoryEdit, text(SUMMARY)]);

        await runChatTurn({ pool, agents: agents() }, params(provider));

        const rows = (await storedRows()).map((row) => row.message);
        const afterMarker = rows.slice(rows.findIndex((message) => compactionMarkerOf(message) !== undefined) + 1);
        const memory = afterMarker.find((message) => contextRecordOf(message)?.kind === "working-memory");
        expect(String(memory?.content)).toContain("Use an FDR of 0.01.");
        expect(provider.calls.at(-1)!.messages.some((message) => String(message.content).includes("Use an FDR of 0.01."))).toBe(true);
    });

    it("keeps the seed and the summary marker first on a report turn, runs no tool in the exchange, and adds no working-memory record", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        (await createThreadHistory(pool).appendTurn(THREAD, conversationRecordTurn("[Report Brief]\nDraft the methods section.")))._unsafeUnwrap();
        const provider = compactingProvider(
            [bigCall("tu-1"), text("done")],
            [makeMessage([toolUseBlock("tu-x", "echo", { label: "x" })], "tool_use"), text(SUMMARY)],
        );

        await runChatTurn({ pool, agents: agents() }, params(provider, { conversationBudget: 1_000 }));

        const exchange = provider.calls.filter(isExchangeRequest);
        expect(exchange[0]!.messages.at(-1)!.content).toBe(SUMMARY_COMPACTION_REQUEST);
        const refused = exchange[1]!.messages.at(-1)!.content as ToolResultPart[];
        expect(refused[0]!.output).toMatchObject({ type: "error-text" });
        expect(JSON.stringify(refused[0]!.output)).toContain("No tool can run for this request");
        const after = provider.calls.at(-1)!.messages;
        expect(after.map(kindOf)).toEqual(["user", "summary-marker", "run-activity"]);
        expect(after[0]!.content).toBe("[Report Brief]\nDraft the methods section.");
    });

    it("removes the exchange and the marker of the last turn at a retract, and the next turn starts from the earlier marker", async () => {
        await runChatTurn({ pool, agents: agents() }, params(compactingProvider([bigCall("tu-1"), text("done")], [text("first summary")])));
        await runChatTurn(
            { pool, agents: agents() },
            params(compactingProvider([bigCall("tu-2"), text("done again")], [text("second summary")]), { userInput: "once more" }),
        );
        expect((await storedRows()).map((row) => compactionMarkerOf(row.message)?.kind).filter((kind) => kind !== undefined)).toEqual(["summary", "summary"]);

        (await createThreadHistory(pool).retractLastTurn(THREAD))._unsafeUnwrap();

        const rows = (await storedRows()).map((row) => row.message);
        expect(rows.map(kindOf).filter((kind) => kind.startsWith("exchange") || kind.endsWith("marker"))).toEqual([
            "exchange-user",
            "exchange-assistant",
            "summary-marker",
        ]);
        const view = (await createThreadHistory(pool).loadRecent(THREAD))._unsafeUnwrap();
        expect(view[0]!.content).toBe("[Conversation Summary]\nfirst summary");
    });

    it("compacts before the first task request when the view passes the budget of the host, after the stored opening", async () => {
        (
            await createThreadHistory(pool).appendTurn(THREAD, {
                modelMessages: [
                    { role: "user", content: big(3_000) },
                    { role: "assistant", content: "an earlier answer" },
                ],
                displayMessages: [],
            })
        )._unsafeUnwrap();
        const storedAtRequest: string[][] = [];
        const replies = compactingProvider([text("done")], [text(SUMMARY)]);
        const provider: ScriptedProvider = {
            ...replies,
            chatStream: (request, session, signal) => {
                const inner = replies.chatStream(request, session, signal);
                return (async function* () {
                    storedAtRequest.push((await storedRows()).map((row) => kindOf(row.message)));
                    yield* inner;
                })();
            },
        };

        await runChatTurn({ pool, agents: agents() }, params(provider, { conversationBudget: 2_000 }));

        const first = replies.calls[0]!;
        expect(isExchangeRequest(first)).toBe(true);
        expect(first.messages.slice(-4).map(kindOf)).toEqual(["user", "run-activity", "working-memory", "user"]);
        expect(first.messages.at(-1)!.content).toBe(MEMORY_COMPACTION_REQUEST);
        expect(storedAtRequest[0]).toEqual(["user", "assistant", "user", "run-activity", "working-memory"]);
    });

    it("closes the turn aborted with the stored exchange and no marker when an abort ends the exchange", async () => {
        const partial: ChatResponse = { message: { role: "assistant", content: "The user compares" }, finishReason: "aborted" };
        const provider = compactingProvider([bigCall("tu-1")], [partial]);

        const result = await runChatTurn({ pool, agents: agents() }, params(provider));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "aborted" } });
        if (result.kind !== "ran") throw new Error("unreachable");
        expect(result.fallbackText ?? "").not.toContain("The user compares");
        const rows = await storedRows();
        expect(rows.map((row) => kindOf(row.message))).toEqual([
            "user",
            "run-activity",
            "working-memory",
            "assistant",
            "tool",
            "exchange-user",
            "exchange-assistant",
        ]);
        expect(rows[0]!.turn?.status).toBe("aborted");
    });

    it("runs no exchange under the default budget", async () => {
        const provider = compactingProvider([bigCall("tu-1"), text("done")], []);

        await runChatTurn({ pool, agents: agents() }, params(provider, { conversationBudget: undefined }));

        expect(DEFAULT_CONVERSATION_BUDGET).toBe(150_000);
        expect(provider.calls.some(isExchangeRequest)).toBe(false);
        expect((await storedRows()).some((row) => compactionMarkerOf(row.message) !== undefined)).toBe(false);
    });

    it("gives no policy to a sub-agent loop of the turn", async () => {
        const SUB_PROMPT = "You are the test sub-agent.";
        const provider = scriptedProvider((callIndex, request) => {
            if (JSON.stringify(request.system).includes(SUB_PROMPT)) return text("sub answer");
            return callIndex === 0 ? makeMessage([toolUseBlock("tu-1", "delegate", {})], "tool_use") : text("done");
        });
        const delegate = defineTool({
            id: "delegate",
            description: "Run a sub-agent over a large brief.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async (_input, ctx) => {
                const sub = await runAgent(
                    { id: "sub-agent", systemPrompt: SUB_PROMPT, model: "claude-test", tools: [], maxIterations: 2 },
                    [{ role: "user", content: big(3_000) }],
                    forSubAgent(ctx.session, "sub-agent"),
                    { provider, signal: ctx.signal, emit: ctx.emit, runStep: ctx.runStep },
                );
                return ok({ answer: sub.finish.reason });
            },
        });
        const resolver: ThreadAgentResolver = { forThread: () => ok({ ...conversationAgent(), tools: [delegate] }) };

        await runChatTurn({ pool, agents: resolver }, params(provider));

        expect(provider.calls.some(isExchangeRequest)).toBe(false);
    });
});
