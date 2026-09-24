import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolResultPart } from "ai";
import { err, errAsync, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { withSchema } from "../__tests__/setup/postgres.js";
import { forSubAgent } from "../auth/types.js";
import { createNoopUsageRecorder } from "../billing/noop-usage-recorder.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { runAgent } from "../loop/run-agent.js";
import type { AgentDefinition } from "../loop/types.js";
import { contextRecordOf } from "../memory/ai-sdk-message-storage.js";
import { storedMessagesToCortex } from "../memory/conversation-display-replay.js";
import { createThreadStore } from "../memory/thread-store.js";
import { createThreadHistory, type StoredMessage } from "../memory/thread-history.js";
import { NOT_RUN_TOOL_RESULT } from "../memory/tool-call-integrity.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ProviderError } from "../providers/errors.js";
import type { AgentChat, ChatRequest, ChatResponse, ChatUsage } from "../providers/types.js";
import type { ThreadAgentResolver } from "../runtime/assemble.js";
import { insertRun, updateRunStatus } from "../state/index.js";
import type { SessionProvenanceEvent } from "../provenance/seam.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { suspensionOfFailure } from "../workflows/suspension.js";
import { prepareChatTurn, runChatTurn, type RunChatTurnParams } from "./chat-turn.js";

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
