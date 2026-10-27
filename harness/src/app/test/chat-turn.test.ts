import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { textOf } from "../../lib/unknown-text.js";
import { referencedToolOutput } from "../../lib/test/text-shapes.js";
import { APICallError, type LanguageModelV4CallOptions, type LanguageModelV4Message, type LanguageModelV4ToolResultPart } from "@ai-sdk/provider";
import type { ModelMessage, ToolResultPart } from "ai";
import { err, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { type Connectable } from "../../lib/db-result.js";
import type { Querier } from "../../state/db.js";
import { z } from "zod";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { forSubAgent } from "../../auth/types.js";
import { createNoopUsageRecorder } from "../../billing/noop-usage-recorder.js";
import type { LlmUsageRecord, UsageRecorder } from "../../billing/usage-recorder.js";
import type { CompactionRules } from "../../loop/compaction.js";
import { runLoop } from "../../loop/run-loop.js";
import type { AgentDefinition, EmitFn } from "../../loop/types.js";
import {
    compactionExchangeOf,
    compactionMarkerOf,
    contextRecordOf,
    isInterruptedMessage,
    withRequestInputTokens,
} from "../../memory/ai-sdk-message-storage.js";
import { storedMessagesToChat } from "../../memory/conversation-display-replay.js";
import { createThreadStore } from "../../memory/thread-store.js";
import { conversationRecordTurn, createThreadHistory, type StoredMessage } from "../../memory/thread-history.js";
import { NOT_RUN_TOOL_RESULT } from "../../memory/tool-call-integrity.js";
import { deriveThreadTitle } from "../../memory/derive-thread-title.js";
import { createWorkingMemory } from "../../memory/working-memory.js";
import { presentAt, presentFind, presentFirst, presentLast } from "../../lib/present.js";
import { ResultError } from "../../lib/result.js";
import { isUnknownArray } from "../../lib/unknown-array.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { MEMORY_COMPACTION_REQUEST, SUMMARY_COMPACTION_REQUEST } from "../../prompts/compaction.js";
import type { ChatUsage } from "../../providers/types.js";
import type { ThreadAgentResolver } from "../../runtime/assemble.js";
import { insertRun, updateRunStatus } from "../../state/index.js";
import { createToolOutputStore } from "../../state/tool-outputs.js";
import type { SessionProvenanceEvent } from "../../provenance/seam.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptedModel, type ScriptedReply, type ScriptEntry, type ScriptStep } from "../../testing.js";
import { defineTool, type Tool } from "../../tools/define-tool.js";
import { createUpdateWorkingMemoryTool } from "../../tools/memory/update-working-memory.js";
import { createReadToolOutputTool } from "../../tools/read-tool-output.js";
import { suspensionOfFailure } from "../../workflows/suspension.js";
import { prepareChatTurn, type RunChatTurnDeps } from "../chat-turn.js";
import { inProcessChatTurns, openInProcessTurn, runInProcessTurn, type InProcessTurnParams } from "../in-process-turn.js";

/** The tool-result parts of a stored tool message, or a failed test on any other message. */
function toolResultParts(message: ModelMessage): ToolResultPart[] {
    if (message.role !== "tool") throw new Error("expected a tool message");
    return message.content.flatMap((part) => (part.type === "tool-result" ? [part] : []));
}

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

type TurnEvent = Parameters<EmitFn>[0];

/** The ids that the `message-start` events of a turn name, by role, in the order of the stream. */
function announcedIds(events: readonly TurnEvent[]): { user: string[]; assistant: string[] } {
    const ids = (role: "user" | "assistant") => events.flatMap((event) => (event.type === "message-start" && event.role === role ? [event.messageId] : []));
    return { user: ids("user"), assistant: ids("assistant") };
}

/** Flatten a message's content to a searchable string. */
function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (isUnknownArray(content)) {
        return content.map((b) => textOf(parseUnknownRecord(b)?.text)).join("\n");
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
        if (still === null) throw new Error("the thread row is absent");
        expect(still.analysisId).toBe(ANALYSIS_B);
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
        if (created === null) throw new Error("the thread row is absent");
        expect(created.analysisId).toBe(ANALYSIS_A);
        expect(created.title).toBe(deriveThreadTitle("run a differential expression analysis please"));

        // userMessage carries the new input.
        expect(contentText(result.userMessage.content)).toContain("run a differential expression analysis please");

        // The history holds the prior turn, and the context records follow the new user input.
        expect(result.history.map((m) => contentText(m.content))).toEqual(["earlier question about PCA", "earlier answer"]);
        const records = result.contextRecords.map((m) => contentText(m.content)).join("\n");
        expect(records).toContain("[Run Activity]");
        expect(records).toContain("No runs are currently running.");
        expect(contentText(result.userMessage.content)).not.toContain("[Run Activity]");
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
        if (after === null) throw new Error("the thread row is absent");
        expect(after.title).toBe("My Existing Title");
    });

    it("keeps an empty title that a person set", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: "t-cleared", analysisId: ANALYSIS_A, title: "Old title" }))._unsafeUnwrap();
        (await store.updateTitle("t-cleared", ""))._unsafeUnwrap();

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t-cleared", userInput: "compare the two batches" });

        expect(result.kind).toBe("ok");
        const cleared = (await store.getThread("t-cleared"))._unsafeUnwrap();
        if (cleared === null) throw new Error("the thread row is absent");
        expect(cleared.title).toBe("");
    });

    it("injects the analysis-wide running runs, and not a suspended run, regardless of launching thread", async () => {
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

        const joined = result.contextRecords.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("Running:");
        expect(joined).toContain("runId: run-other-thread");
        expect(joined).not.toContain("Suspended:");
        expect(joined).not.toContain("run-suspended");
        expect(joined).toContain("planId: none");
        expect(joined).not.toContain("run-other-analysis");
    });

    it("injects an unavailable state when only the activity read fails", async () => {
        const activityFailingPool: Querier & Connectable = {
            query: (textOrConfig, values) => {
                const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
                if (text.includes("status = 'running'")) {
                    return Promise.reject(new Error("activity unavailable"));
                }
                return pool.query(textOrConfig, values);
            },
            connect: () => pool.connect(),
        };

        const result = await prepareChatTurn({ pool: activityFailingPool }, { analysisId: ANALYSIS_A, threadId: "unavailable-thread", userInput: "hello" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        const joined = result.contextRecords.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("Run status is temporarily unavailable.");
        expect(joined).not.toContain("No runs are currently running.");
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
        if (created === null) throw new Error("the thread row is absent");
        expect(created.threadType).toBe("conversation");
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

        const joined = result.contextRecords.map((message) => contentText(message.content)).join("\n");
        expect(joined).not.toContain("# Working Memory");
        expect(joined).not.toContain("Find the driver genes.");
        expect(joined).toContain("[Run Activity]");
        expect(contentText(result.userMessage.content)).toBe("draft the summary");
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

        const joined = result.contextRecords.map((message) => contentText(message.content)).join("\n");
        expect(joined).toContain("# Working Memory");
        expect(joined).toContain("Find the driver genes.");
    });
});

// --- the run of a turn -------------------------------------------------------

/** A failure of the model endpoint with an HTTP status, as the AI SDK throws it. */
function apiFailure(statusCode: number, message: string): APICallError {
    return new APICallError({ message, url: "https://models.example/v1/messages", requestBodyValues: {}, statusCode });
}

function abortError(): DOMException {
    return new DOMException("The operation was aborted.", "AbortError");
}

/** The system message of a request. */
function systemOf(call: LanguageModelV4CallOptions): Extract<LanguageModelV4Message, { role: "system" }> {
    const system = presentFirst(call.prompt);
    if (system.role !== "system") throw new Error("the request starts with no system message");
    return system;
}

/** The cache directive on the system prompt of a request. */
function systemDirective(call: LanguageModelV4CallOptions): unknown {
    return systemOf(call).providerOptions?.["anthropic"]?.["cacheControl"];
}

/** The messages of a request after its system prompt, with the role, the text, and the options that the marker readers take. */
function sentMessages(call: LanguageModelV4CallOptions): ModelMessage[] {
    return call.prompt.flatMap((message): ModelMessage[] => {
        const { providerOptions } = message;
        switch (message.role) {
            case "system":
                return [];
            case "user":
                return [{ role: "user", content: contentText(message.content), providerOptions }];
            case "assistant":
                return [{ role: "assistant", content: contentText(message.content), providerOptions }];
            case "tool":
                return [{ role: "tool", content: [], providerOptions }];
        }
    });
}

/** The outputs of the tool results of a sent tool message, or a failed test on any other message. */
function sentToolOutputs(message: LanguageModelV4Message): LanguageModelV4ToolResultPart["output"][] {
    if (message.role !== "tool") throw new Error("expected a tool message");
    return message.content.flatMap((part) => (part.type === "tool-result" ? [part.output] : []));
}

describe("the run of a chat turn", () => {
    const THREAD = "t-turn";

    function echoTool(): Tool {
        return defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: ({ label }) => Promise.resolve(ok({ label })),
        });
    }

    function agentWith(tools: Tool[], systemPrompt = "You are the test conversation agent."): AgentDefinition {
        return { id: "conversation-agent", systemPrompt, model: "claude-test", tools, maxIterations: 8 };
    }

    function resolverFor(agent: AgentDefinition): ThreadAgentResolver {
        return { forThread: (type) => (type === "conversation" ? ok(agent) : err({ type: "unregistered_thread_type", threadType: type })) };
    }

    /** The runtime values of a turn over `model`: the values that `CoreRuntime.chatTurns` gives a host. */
    function depsFor(agents: ThreadAgentResolver, model: ScriptedModel, overrides: Partial<RunChatTurnDeps> = {}): RunChatTurnDeps {
        return { pool, agents, provider: model.provider, usageRecorder: createNoopUsageRecorder(), ...overrides };
    }

    function params(overrides: Partial<InProcessTurnParams> = {}): InProcessTurnParams {
        return {
            analysisId: ANALYSIS_A,
            threadId: THREAD,
            userInput: "compare the two groups",
            session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_A, threadId: THREAD } }),
            emit: () => {},
            signal: new AbortController().signal,
            ...overrides,
        };
    }

    const echoCall = (id: string, usage?: ChatUsage): ScriptedReply => reply([toolCall(id, "echo", { label: id })], "tool-calls", usage);

    function recordingUsage(): { readonly usageRecorder: UsageRecorder; readonly records: LlmUsageRecord[] } {
        const records: LlmUsageRecord[] = [];
        return {
            records,
            usageRecorder: {
                record: (record) => {
                    records.push(record);
                    return okAsync(undefined);
                },
            },
        };
    }

    /** A host emit that aborts the turn at the first text delta of the reply. */
    function abortingAtText(controller: AbortController): EmitFn {
        return (event) => {
            if (event.type === "text-delta") controller.abort();
        };
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
        const model = scriptedModel([
            echoCall("tu-1", { inputTokens: 100, outputTokens: 10 }),
            reply([text("the groups differ")], "stop", { inputTokens: 120, outputTokens: 20 }),
        ]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params({ startedAtMs: Date.now() - 1_000 }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" }, opened: true, turnUsage: { inputTokens: 220, outputTokens: 30 } });
        expect("storeError" in result).toBe(false);
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "tool", "assistant"]);
        expect(rows.slice(1, 3).map((row) => contextRecordOf(row.message)?.kind)).toEqual(["run-activity", "working-memory"]);
        const storedTurn = presentFirst(rows).turn;
        expect(storedTurn).toMatchObject({ status: "done", usage: { inputTokens: 220, outputTokens: 30 } });
        expect(storedTurn?.durationMs).toBeGreaterThanOrEqual(1_000);
    });

    it("gives the chat turns of the test kit: the frames of the turn with its end frame, a second read, and the end", async () => {
        const model = scriptedModel([echoCall("tu-1"), reply([text("the groups differ")], "stop", { inputTokens: 120, outputTokens: 20 })]);
        const chatTurns = inProcessChatTurns(depsFor(resolverFor(agentWith([echoTool()])), model));
        const { session } = params();

        const started = await chatTurns.open(session, { analysisId: ANALYSIS_A, threadId: THREAD, userInput: "compare the two groups" });
        if (started.kind !== "started") throw new Error(`expected a started turn, got ${started.kind}`);
        const read = async (): Promise<string[]> => {
            const types: string[] = [];
            for await (const frame of chatTurns.read(started.turnId)) types.push(frame.type);
            return types;
        };
        const first = await read();

        expect(first).toContain("tool-finished");
        expect(first.at(-1)).toBe("finish");
        expect(await read()).toEqual(first);
        expect(await chatTurns.outcome(started.turnId)).toMatchObject({ status: "done", opened: true, fallbackText: "the groups differ" });
    });

    it("reads a stored turn back as one user message and one assistant message", async () => {
        const model = scriptedModel([echoCall("tu-1"), reply([text("the groups differ")])]);
        await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        const replay = storedMessagesToChat(await storedRows());

        expect(replay.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(presentAt(replay, 1).parts).toHaveLength(2);
        const [toolCallPart, textPart] = presentAt(replay, 1).parts;
        if (toolCallPart?.type !== "tool-call") throw new Error("the reply did not store the tool call");
        const { durationMs, ...call } = toolCallPart;
        expect(call).toEqual({ type: "tool-call", toolCallId: "tu-1", toolName: "echo", outcome: "ok" });
        expect(durationMs).toBeTypeOf("number");
        expect(textPart).toEqual({ type: "text", text: "the groups differ" });
    });

    it("announces the id of the user message and of the assistant message, and stores the turn under those ids", async () => {
        const forwarded: TurnEvent[] = [];
        const model = scriptedModel([echoCall("tu-1"), reply([text("the groups differ")])]);

        await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params({ emit: (event) => void forwarded.push(event) }));

        const announced = announcedIds(forwarded);
        expect(forwarded.slice(0, 2).map((event) => event.type)).toEqual(["message-start", "message-start"]);
        expect(forwarded.filter((event) => event.type === "message-start")).toHaveLength(2);
        expect(storedMessagesToChat(await storedRows()).map((message) => [message.role, message.id])).toEqual([
            ["user", announced.user[0] ?? ""],
            ["assistant", announced.assistant[0] ?? ""],
        ]);
    });

    it("streams the text of the root reply to the emit of the host as text deltas", async () => {
        const deltas: string[] = [];
        const model = scriptedModel([echoCall("tu-1"), reply([text("the groups differ")])]);

        await runInProcessTurn(
            depsFor(resolverFor(agentWith([echoTool()])), model),
            params({
                emit: (event) => {
                    if (event.type === "text-delta") deltas.push(event.text);
                },
            }),
        );

        expect(deltas.join("")).toBe("the groups differ");
    });

    it("keeps two rounds, adds the note, and closes failed when the third request fails on the credential", async () => {
        const model = scriptedModel([
            echoCall("tu-1"),
            echoCall("tu-2"),
            { fail: apiFailure(401, "401 Unauthorized at https://models.example/v1 with key sk-secret-123") },
        ]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "The model endpoint refused the credential." } });
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "tool", "assistant", "tool", "user"]);
        expect(presentLast(rows).message.content).toBe(
            "[Turn Failed]\nThe turn stopped before it finished. Reason: The model endpoint refused the credential.\nThe rounds above this note ran, and their results are stored.",
        );
        expect(JSON.stringify(rows.map((row) => row.message))).not.toContain("sk-secret-123");
        expect(await turnRecords()).toEqual([{ status: "failed", reason: "The model endpoint refused the credential." }]);
    });

    it("starts the next turn with the failed request of the failed turn as its prefix, byte-identical, then the note", async () => {
        const failing = scriptedModel([echoCall("tu-1"), echoCall("tu-2"), { fail: apiFailure(401, "401 Unauthorized") }]);
        const agents = resolverFor(agentWith([echoTool()]));
        await runInProcessTurn(depsFor(agents, failing), params({ promptCache: "off" }));
        const next = scriptedModel([reply([text("continuing")])]);

        await runInProcessTurn(depsFor(agents, next), params({ userInput: "try again", promptCache: "off" }));

        const failedRequest = presentLast(failing.calls).prompt;
        const sent = presentFirst(next.calls).prompt;
        expect(JSON.stringify(sent.slice(0, failedRequest.length))).toBe(JSON.stringify(failedRequest));
        expect(contentText(sent[failedRequest.length]?.content)).toStartWith("[Turn Failed]");
    });

    it("closes failed with the reason of the host on a suspend error", async () => {
        const model = scriptedModel([{ fail: apiFailure(402, "Payment Required") }]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "payment_required" } });
        if (result.kind !== "ran" || result.outcome.status !== "failed") throw new Error("unreachable");
        expect(suspensionOfFailure(result.outcome.cause)).toEqual({ kind: "suspended", reason: "payment_required" });
        expect(await turnRecords()).toEqual([{ status: "failed", reason: "payment_required" }]);
    });

    it("closes failed with a reason that holds no text of the provider error on another refused request", async () => {
        const model = scriptedModel([{ fail: apiFailure(400, "prompt is too long for the key sk-secret-123") }]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "The model request failed." } });
        expect(JSON.stringify((await storedRows()).map((row) => row.message))).not.toContain("sk-secret-123");
        expect(await turnRecords()).toEqual([{ status: "failed", reason: "The model request failed." }]);
    });

    it("stores the opening and closes aborted on an abort before any output", async () => {
        const controller = new AbortController();
        const model = scriptedModel([
            () => {
                controller.abort();
                return { fail: abortError() };
            },
        ]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params({ signal: controller.signal }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "aborted" }, opened: true });
        expect((await storedRows()).map((row) => row.message.role)).toEqual(["user", "user", "user", "user"]);
        expect(await turnRecords()).toEqual([{ status: "aborted", reason: null }]);
    });

    it("stores the partial text of a reply that an abort cut, marked interrupted, and closes aborted with the note", async () => {
        const controller = new AbortController();
        const model = scriptedModel([{ breakAfter: [text("The two groups")], error: abortError() }]);

        const result = await runInProcessTurn(
            depsFor(resolverFor(agentWith([echoTool()])), model),
            params({ emit: abortingAtText(controller), signal: controller.signal }),
        );

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "aborted" }, opened: true, fallbackText: "The two groups" });
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "user"]);
        const partial = presentAt(rows, 3).message;
        expect(contentText(partial.content)).toBe("The two groups");
        expect(isInterruptedMessage(partial)).toBe(true);
        expect(presentLast(rows).message.content).toBe("[The user interrupted the request above. Do not continue it unless the user asks you to.]");
        expect(await turnRecords()).toEqual([{ status: "aborted", reason: null }]);
    });

    it("sends the next turn a note that the user interrupted the request, and the replay does not show the note", async () => {
        const controller = new AbortController();
        const agents = resolverFor(agentWith([echoTool()]));
        const aborting = scriptedModel([{ breakAfter: [text("The two groups")], error: abortError() }]);
        await runInProcessTurn(depsFor(agents, aborting), params({ emit: abortingAtText(controller), signal: controller.signal }));
        const next = scriptedModel([reply([text("hello")])]);

        await runInProcessTurn(depsFor(agents, next), params({ userInput: "say hello", promptCache: "off" }));

        const sent = presentFirst(next.calls).prompt;
        const opening = sent.findIndex((message) => contentText(message.content) === "say hello");
        expect(sent[opening - 1]).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "[The user interrupted the request above. Do not continue it unless the user asks you to.]" }],
        });
        expect(JSON.stringify(storedMessagesToChat(await storedRows()))).not.toContain("The user interrupted");
    });

    it("closes failed on an AbortError of a tool under a live signal, and keeps the call with a not-run result", async () => {
        const stall = defineTool({
            id: "stall",
            description: "Throws an AbortError that no abort of the turn caused.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => {
                return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
            },
        });
        const model = scriptedModel([callTools(toolCall("tu-1", "stall", {}))]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([stall])), model), params());

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "failed", reason: "The turn stopped on an internal error." } });
        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "tool", "user"]);
        const answer = toolResultParts(presentAt(rows, 4).message);
        expect(answer.map((part) => [part.toolCallId, part.output])).toEqual([["tu-1", { type: "error-text", value: NOT_RUN_TOOL_RESULT }]]);
    });

    it("writes no row and no record when the resolver refuses the thread type", async () => {
        (await createThreadStore(pool).createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        const model = scriptedModel([]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        expect(result).toEqual({ kind: "agent_unresolved", threadType: "report" });
        expect(await storedRows()).toEqual([]);
        expect(await turnRecords()).toEqual([]);
        expect(model.calls).toEqual([]);
    });

    it("gives prepare_failed with the cause, and writes no row, when the preparation throws", async () => {
        const unreachable: Querier & Connectable = {
            query: () => Promise.reject(new Error("the database is unreachable")),
            connect: () => Promise.reject(new Error("the database is unreachable")),
        };
        const model = scriptedModel([]);

        const result = await runInProcessTurn({ ...depsFor(resolverFor(agentWith([echoTool()])), model), pool: unreachable }, params());

        if (result.kind !== "prepare_failed") throw new Error(`expected prepare_failed, got ${result.kind}`);
        if (!(result.cause instanceof ResultError)) throw new Error("the cause is not the failure of the thread read");
        expect(result.cause.value).toMatchObject({ type: "query_failed", op: "thread-store.getThread" });
        expect(await storedRows()).toEqual([]);
        expect(await turnRecords()).toEqual([]);
        expect(model.calls).toEqual([]);
    });

    it("adds no context record on a second turn with no change", async () => {
        const agents = resolverFor(agentWith([echoTool()]));
        await runInProcessTurn(depsFor(agents, scriptedModel([reply([text("first answer")])])), params());

        await runInProcessTurn(depsFor(agents, scriptedModel([reply([text("second answer")])])), params({ userInput: "and now?" }));

        const rows = await storedRows();
        expect(rows.map((row) => row.message.role)).toEqual(["user", "user", "user", "assistant", "user", "assistant"]);
        expect(contextRecordOf(presentAt(rows, 4).message)).toBeUndefined();
    });

    it("opens a report thread with the report agent, and runs it under the provenance of that agent", async () => {
        (await createThreadStore(pool).createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        const { usageRecorder, records } = recordingUsage();
        const report: AgentDefinition = { ...agentWith([echoTool()]), id: "report-session-agent" };
        const agents: ThreadAgentResolver = { forThread: (type) => ok(type === "report" ? report : agentWith([echoTool()])) };
        const { provenance: _hostProvenance, ...session } = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_A, threadId: THREAD } });
        const model = scriptedModel([reply([text("drafted")], "stop", { inputTokens: 5, outputTokens: 1 })]);
        const { analysisId, threadId, userInput, ...run } = params({ session });

        const opened = await openInProcessTurn(depsFor(agents, model, { usageRecorder }), { analysisId, threadId, userInput });
        if (opened.kind !== "ready") throw new Error(`expected an open turn, got ${opened.kind}`);
        const result = await opened.run(run);

        expect(opened.agent.id).toBe("report-session-agent");
        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" } });
        expect(records.map((record) => [record.agentId, record.callPath])).toEqual([["report-session-agent", ["report-session-agent"]]]);
    });

    it("refuses a thread of a different analysis at the open, before any row of the turn", async () => {
        (await createThreadStore(pool).createThread({ threadId: THREAD, analysisId: ANALYSIS_B, title: "Owned by B" }))._unsafeUnwrap();

        const opened = await openInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), scriptedModel([])), {
            analysisId: ANALYSIS_A,
            threadId: THREAD,
            userInput: "hi",
        });

        expect(opened).toEqual({ kind: "not_found" });
        expect(await storedRows()).toEqual([]);
        expect(await turnRecords()).toEqual([]);
    });

    it("gives not_found for a turn on a thread of a different analysis, and the thread does not change", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS_B, title: "Owned by B" }))._unsafeUnwrap();
        const before = (await store.getThread(THREAD))._unsafeUnwrap();
        const model = scriptedModel([]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        expect(result).toEqual({ kind: "not_found" });
        expect((await store.getThread(THREAD))._unsafeUnwrap()).toEqual(before);
        expect(await storedRows()).toEqual([]);
        expect(model.calls).toEqual([]);
    });

    it("stores the display of the user message with the secrets redacted", async () => {
        const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
        const model = scriptedModel([reply([text("noted")])]);

        await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params({ userInput: `use the key ${secret}` }));

        const replay = storedMessagesToChat(await storedRows());
        expect(presentFirst(replay).parts).toEqual([{ type: "text", text: "use the key [REDACTED: OpenAI API Key]" }]);
        expect(JSON.stringify(replay)).not.toContain(secret);
    });

    it("records each model call of the turn with the usage recorder of the runtime values, with no usage wiring of the host", async () => {
        const { usageRecorder, records } = recordingUsage();
        const model = scriptedModel([
            echoCall("tu-1", { inputTokens: 10, outputTokens: 2 }),
            reply([text("hi")], "stop", { inputTokens: 12, outputTokens: 3 }),
        ]);

        await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model, { usageRecorder }), params());

        expect(records.map((record) => [record.agentId, record.callPath, record.usage])).toEqual([
            ["conversation-agent", ["conversation-agent"], { inputTokens: 10, outputTokens: 2 }],
            ["conversation-agent", ["conversation-agent"], { inputTokens: 12, outputTokens: 3 }],
        ]);
    });

    it("stores the excerpt of a long tool result in its round, and keeps the whole text under the reference of the excerpt", async () => {
        // Words, not one long run of a character: the write-time token count is slow on a long unbroken word.
        const value = "TP53 7 ".repeat(7_143).slice(0, 50_000);
        const long = defineTool({
            id: "long",
            description: "Give a long text.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.resolve(ok(value)),
        });
        const model = scriptedModel([callTools(toolCall("tu-1", "long", {})), reply([text("read it")])]);

        await runInProcessTurn(depsFor(resolverFor(agentWith([long, createReadToolOutputTool(createToolOutputStore(pool))])), model), params());

        const round = presentFind(await storedRows(), (row) => row.message.role === "tool");
        const output = presentFirst(toolResultParts(round.message)).output;
        if (output.type !== "text") throw new Error("expected the cut text output");
        const excerpt = output.value;
        expect(excerpt.startsWith("[Tool result cut: 50002 characters")).toBe(true);
        expect(excerpt.length).toBeLessThan(value.length);
        const ref = referencedToolOutput(excerpt);
        if (ref === undefined) throw new Error("the excerpt names no stored tool output");
        const { rows } = await pool.query<{ thread_id: string | null; content: string; total_length: number }>(
            "SELECT thread_id, content, total_length FROM cortex_tool_outputs WHERE analysis_id = $1 AND ref = $2",
            [ANALYSIS_A, ref],
        );
        expect(rows).toEqual([{ thread_id: THREAD, content: JSON.stringify(value), total_length: 50_002 }]);
    });

    it("sends the 1-hour cache directive from the root loop", async () => {
        const model = scriptedModel([reply([text("hi")])]);

        await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params());

        const request = presentFirst(model.calls);
        expect(systemDirective(request)).toEqual({ type: "ephemeral", ttl: "1h" });
        expect(presentLast(request.prompt).providerOptions?.["anthropic"]?.["cacheControl"]).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("sends the cache directive of a host policy", async () => {
        const model = scriptedModel([reply([text("hi")])]);

        await runInProcessTurn(depsFor(resolverFor(agentWith([echoTool()])), model), params({ promptCache: { ttl: "5m" } }));

        expect(systemDirective(presentFirst(model.calls))).toEqual({ type: "ephemeral", ttl: "5m" });
    });

    it("sends the 5-minute cache directive from a sub-agent loop of the turn", async () => {
        const SUB_PROMPT = "You are the test sub-agent.";
        const model = scriptedModel([callTools(toolCall("tu-1", "delegate", {})), reply([text("sub answer")]), reply([text("done")])]);
        const delegate = defineTool({
            id: "delegate",
            description: "Run a sub-agent.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async (_input, ctx) => {
                const sub = await runLoop(agentWith([], SUB_PROMPT), [{ role: "user", content: "brief" }], forSubAgent(ctx.session, "sub-agent"), {
                    provider: model.provider,
                    signal: ctx.signal,
                    emit: ctx.emit,
                    turnUsage: ctx.turnUsage,
                });
                return ok({ answer: sub.finish.reason });
            },
        });

        await runInProcessTurn(depsFor(resolverFor(agentWith([delegate])), model), params());

        expect(model.calls.map((call) => [systemOf(call).content === SUB_PROMPT, systemDirective(call)])).toEqual([
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
                    if (typeof value === "function") {
                        const fn: CallableFunction = value;
                        return fn.bind(target);
                    }
                    return value;
                }
                return async () => {
                    const client = await target.connect();
                    return new Proxy(client, {
                        get(inner, key, innerReceiver) {
                            if (key === "query") {
                                return (sql: string, values?: unknown[]) => {
                                    // The first row of the first round takes seq 3, after the three rows of the opening.
                                    if (!failed && sql.includes("INSERT INTO messages") && values?.[1] === 3) {
                                        failed = true;
                                        return Promise.reject(new Error("simulated insert failure"));
                                    }
                                    return inner.query(sql, values);
                                };
                            }
                            const value: unknown = Reflect.get(inner, key, innerReceiver);
                            if (typeof value === "function") {
                                const fn: CallableFunction = value;
                                return fn.bind(inner);
                            }
                            return value;
                        },
                    });
                };
            },
        });
        const model = scriptedModel([echoCall("tu-1"), echoCall("tu-2"), reply([text("done")])]);

        const result = await runInProcessTurn({ ...depsFor(resolverFor(agentWith([echoTool()])), model), pool: failingOnce }, params());

        expect(failed).toBe(true);
        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" }, opened: true });
        expect("storeError" in result).toBe(false);
        const rows = await storedRows();
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(rows.filter((row) => row.message.role === "tool").map((row) => presentFirst(toolResultParts(row.message)).toolCallId)).toEqual(["tu-1", "tu-2"]);
    });

    function approvalTool(): Tool {
        return defineTool({
            id: "run_script",
            description: "Run a script after the user approves it.",
            inputSchema: z.object({}),
            describeCall: "none",
            approval: () => ({ title: "Run a script", command: "Rscript de.R" }),
            execute: () => Promise.resolve(ok({ ran: "Rscript de.R" })),
        });
    }

    it("denies a call that asks for an approval when the turn has no approver, and the turn ends on the denial", async () => {
        const model = scriptedModel([callTools(toolCall("tu-1", "run_script", {}))]);

        const result = await runInProcessTurn(depsFor(resolverFor(agentWith([approvalTool()])), model), params());

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done", finish: { reason: "denied" } } });
        const answer = toolResultParts(presentFind(await storedRows(), (row) => row.message.role === "tool").message);
        expect(presentFirst(answer).output).toMatchObject({ type: "execution-denied" });
        expect(model.calls).toHaveLength(1);
    });
});

// --- the compaction of a turn -------------------------------------------------

describe("the compaction of a chat turn", () => {
    const THREAD = "t-compact";
    const SUMMARY = "The user compares two groups of samples.";
    /** The input tokens of a request past each budget of the test agents. */
    const OVER = 5_000;
    const CONVERSATION_RULES: CompactionRules = { turnStartBudget: 1_000, budget: 1_000 };
    const TURN_START_BUDGET = CONVERSATION_RULES.turnStartBudget;
    if (TURN_START_BUDGET === undefined) throw new Error("the conversation rules carry no turn-start budget");
    const REPORT_RULES: CompactionRules = { budget: 1_000 };

    function echoTool(): Tool {
        return defineTool({
            id: "echo",
            description: "Echo the label back.",
            inputSchema: z.object({ label: z.string() }),
            describeCall: "none",
            execute: ({ label }) => Promise.resolve(ok({ label })),
        });
    }

    function conversationAgent(): AgentDefinition {
        return {
            id: "conversation-agent",
            systemPrompt: "You are the test conversation agent.",
            model: "claude-test",
            tools: [echoTool(), createUpdateWorkingMemoryTool(createWorkingMemory(pool), pool)],
            maxIterations: 8,
            compaction: CONVERSATION_RULES,
        };
    }

    function reportAgent(): AgentDefinition {
        return {
            id: "report-session-agent",
            systemPrompt: "You are the test report agent.",
            model: "claude-test",
            tools: [echoTool()],
            maxIterations: 8,
            compaction: REPORT_RULES,
        };
    }

    const agents: () => ThreadAgentResolver = () => ({
        forThread: (type) => ok(type === "report" ? reportAgent() : conversationAgent()),
    });

    function isExchangeRequest(call: LanguageModelV4CallOptions): boolean {
        return call.prompt.some((message) => {
            const content = contentText(message.content);
            return content === MEMORY_COMPACTION_REQUEST || content === SUMMARY_COMPACTION_REQUEST;
        });
    }

    /**
     * A model that answers the task requests from `task` and the requests of an exchange from `exchange`.
     * `beforeReply` runs at each request, before the model answers it.
     */
    function compactingModel(
        task: readonly ScriptStep[],
        exchange: readonly ScriptStep[],
        options: { readonly contextWindow?: number; readonly beforeReply?: () => Promise<void> } = {},
    ): ScriptedModel {
        let taskCalls = 0;
        let exchangeCalls = 0;
        const next = async (call: LanguageModelV4CallOptions): Promise<ScriptEntry> => {
            await options.beforeReply?.();
            const step = isExchangeRequest(call) ? exchange[exchangeCalls++] : task[taskCalls++];
            if (step === undefined) throw new Error("no scripted reply");
            return typeof step === "function" ? step(call) : step;
        };
        const capabilities = options.contextWindow === undefined ? {} : { capabilities: { contextWindow: options.contextWindow } };
        return scriptedModel(
            Array.from({ length: task.length + exchange.length }, () => next),
            capabilities,
        );
    }

    /** A tool call whose request reported input tokens past each budget. */
    const overCall = (id: string): ScriptedReply => reply([toolCall(id, "echo", { label: id })], "tool-calls", { inputTokens: OVER });
    const answer = (value: string): ScriptedReply => reply([text(value)]);

    /** A request that the user aborts before the model answers. */
    function abortedBy(controller: AbortController): ScriptStep {
        return () => {
            controller.abort();
            return { fail: abortError() };
        };
    }

    function depsFor(model: ScriptedModel, resolver: ThreadAgentResolver = agents()): RunChatTurnDeps {
        return { pool, agents: resolver, provider: model.provider, usageRecorder: createNoopUsageRecorder() };
    }

    function params(overrides: Partial<InProcessTurnParams> = {}): InProcessTurnParams {
        return {
            analysisId: ANALYSIS_A,
            threadId: THREAD,
            userInput: "compare the two groups",
            session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS_A, threadId: THREAD } }),
            emit: () => {},
            signal: new AbortController().signal,
            ...overrides,
        };
    }

    async function storedRows(threadId = THREAD): Promise<StoredMessage[]> {
        return (await createThreadHistory(pool).loadAll(threadId))._unsafeUnwrap().flat();
    }

    const STORED_USER = { id: "<id>", createdAt: "<createdAt>", role: "user", parts: [{ type: "text", text: "compare the two groups" }] };
    const STORED_REPLY = { id: "<id>", createdAt: "<createdAt>", durationMs: "<durationMs>", role: "assistant", parts: [{ type: "text", text: "done" }] };
    const storedDivider = (trigger: string) => ({
        id: "<id>",
        createdAt: "<createdAt>",
        role: "system",
        parts: [{ type: "data-compaction", id: "<id>", status: "done", tokensBefore: OVER, durationMs: "<durationMs>", trigger }],
    });
    /** The stored display of a mid-turn compaction turn. The `data-compaction` frames are transient, thus their order on the stream cannot change it. */
    const MID_TURN_DISPLAY = [
        STORED_USER,
        {
            id: "<id>",
            createdAt: "<createdAt>",
            role: "assistant",
            parts: [{ type: "tool-call", toolCallId: "tu-1", toolName: "echo", outcome: "ok", durationMs: "<durationMs>" }],
        },
        storedDivider("mid-turn"),
        { ...STORED_REPLY, usage: { inputTokens: OVER } },
    ];
    /** The stored display of a turn-start compaction turn, with the same reason as {@link MID_TURN_DISPLAY}. */
    const TURN_START_DISPLAY = [storedDivider("turn-start"), STORED_USER, STORED_REPLY];

    function kindOf(message: ModelMessage): string {
        const marker = compactionMarkerOf(message);
        if (marker !== undefined) return `${marker.kind}-marker`;
        if (compactionExchangeOf(message) !== undefined) return `exchange-${message.role}`;
        return contextRecordOf(message)?.kind ?? message.role;
    }

    /** Store an earlier turn whose reply reported `inputTokens` for its request. */
    async function storeMeasuredTurn(inputTokens: number): Promise<void> {
        const earlier = withRequestInputTokens({ role: "assistant", content: [{ type: "text", text: "an earlier answer" }] }, inputTokens);
        (
            await createThreadHistory(pool).appendTurn(THREAD, {
                modelMessages: [{ role: "user", content: "an earlier question" }, earlier],
                displayMessages: [],
            })
        )._unsafeUnwrap();
    }

    it("stores the opening, a round, the marked exchange, the marker, the records, and the later rounds", async () => {
        const model = compactingModel([overCall("tu-1"), answer("done")], [answer(SUMMARY)]);

        const result = await runInProcessTurn(depsFor(model), params());

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
        const model = compactingModel([overCall("tu-1"), answer("done")], [answer(SUMMARY)]);
        await runInProcessTurn(depsFor(model), params());

        const replay = storedMessagesToChat(await storedRows());

        expect(replay.map((message) => message.role)).toEqual(["user", "assistant", "system", "assistant"]);
        expect(presentAt(replay, 1).id).not.toBe(presentAt(replay, 3).id);
        expect(presentAt(replay, 2).parts).toHaveLength(1);
        const [compactionPart] = presentAt(replay, 2).parts;
        if (compactionPart?.type !== "data-compaction") throw new Error("the turn did not store the compaction part");
        const { durationMs, ...storedPart } = compactionPart;
        expect(storedPart).toEqual({ type: "data-compaction", id: presentAt(replay, 2).id, status: "done", tokensBefore: OVER, trigger: "mid-turn" });
        expect(durationMs).toBeTypeOf("number");
        expect(JSON.stringify(replay)).not.toContain(SUMMARY);
        expect(presentAt(replay, 3).parts).toEqual([{ type: "text", text: "done" }]);
    });

    it("starts the next turn with the summary marker and its records, then the later rounds, then the new opening", async () => {
        await runInProcessTurn(depsFor(compactingModel([overCall("tu-1"), answer("done")], [answer(SUMMARY)])), params());
        const next = scriptedModel([answer("next answer")]);

        await runInProcessTurn(depsFor(next), params({ userInput: "and now?", promptCache: "off" }));

        const sent = sentMessages(presentFirst(next.calls));
        expect(sent.map(kindOf)).toEqual(["summary-marker", "run-activity", "working-memory", "assistant", "user"]);
        expect(contentText(presentFirst(sent).content)).toBe(`[Conversation Summary]\n${SUMMARY}`);
        expect(contentText(presentLast(sent).content)).toBe("and now?");
    });

    it("sends no text delta of the exchange to the emit of the host", async () => {
        const deltas: string[] = [];
        const model = compactingModel([overCall("tu-1"), answer("done")], [answer(SUMMARY)]);

        await runInProcessTurn(
            depsFor(model),
            params({
                emit: (event) => {
                    if (event.type === "text-delta") deltas.push(event.text);
                },
            }),
        );

        expect(deltas).toEqual(["done"]);
    });

    it("puts a constraint that the exchange added into the working-memory record after the marker", async () => {
        const memoryEdit = callTools(toolCall("tu-m", "update_working_memory", { section: "constraint", text: "Use an FDR of 0.01.", origin: "user" }));
        const model = compactingModel([overCall("tu-1"), answer("done")], [memoryEdit, answer(SUMMARY)]);

        await runInProcessTurn(depsFor(model), params());

        const rows = (await storedRows()).map((row) => row.message);
        const afterMarker = rows.slice(rows.findIndex((message) => compactionMarkerOf(message) !== undefined) + 1);
        const memory = afterMarker.find((message) => contextRecordOf(message)?.kind === "working-memory");
        expect(contentText(memory?.content)).toContain("Use an FDR of 0.01.");
        expect(presentLast(model.calls).prompt.some((message) => contentText(message.content).includes("Use an FDR of 0.01."))).toBe(true);
    });

    it("keeps the seed and the summary marker first on a report turn, runs no tool in the exchange, and adds no working-memory record", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        (await createThreadHistory(pool).appendTurn(THREAD, conversationRecordTurn("[Report Brief]\nDraft the methods section.")))._unsafeUnwrap();
        const model = compactingModel([overCall("tu-1"), answer("done")], [callTools(toolCall("tu-x", "echo", { label: "x" })), answer(SUMMARY)]);

        await runInProcessTurn(depsFor(model), params());

        const exchange = model.calls.filter(isExchangeRequest);
        expect(contentText(presentLast(presentFirst(exchange).prompt).content)).toBe(SUMMARY_COMPACTION_REQUEST);
        const refused = presentFirst(sentToolOutputs(presentLast(presentAt(exchange, 1).prompt)));
        expect(refused).toMatchObject({ type: "error-text" });
        expect(JSON.stringify(refused)).toContain("No tool can run for this request");
        const after = sentMessages(presentLast(model.calls));
        expect(after.map(kindOf)).toEqual(["user", "summary-marker", "run-activity"]);
        expect(contentText(presentFirst(after).content)).toBe("[Report Brief]\nDraft the methods section.");
    });

    it("removes the exchange and the marker of the last turn at a retract, and the next turn starts from the earlier marker", async () => {
        await runInProcessTurn(depsFor(compactingModel([overCall("tu-1"), answer("done")], [answer("first summary")])), params());
        await runInProcessTurn(
            depsFor(compactingModel([overCall("tu-2"), answer("done again")], [answer("second summary")])),
            params({ userInput: "once more" }),
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
        expect(presentFirst(view).content).toBe("[Conversation Summary]\nfirst summary");
    });

    it("compacts before the user message when the last request passed the turn-start budget, and sends the user message after the summary", async () => {
        await storeMeasuredTurn(OVER);
        const storedAtRequest: string[][] = [];
        const model = compactingModel([answer("done")], [answer(SUMMARY)], {
            beforeReply: async () => {
                storedAtRequest.push((await storedRows()).map((row) => kindOf(row.message)));
            },
        });

        await runInProcessTurn(depsFor(model), params());

        const first = presentAt(model.calls, 0);
        const task = presentAt(model.calls, 1);
        expect(isExchangeRequest(first)).toBe(true);
        expect(sentMessages(first).map(kindOf)).toEqual(["user", "assistant", "user"]);
        expect(contentText(presentLast(first.prompt).content)).toBe(MEMORY_COMPACTION_REQUEST);
        expect(storedAtRequest).toEqual([
            ["user", "assistant"],
            ["user", "assistant", "exchange-user", "exchange-assistant", "summary-marker", "run-activity", "working-memory", "user"],
        ]);
        expect(sentMessages(task).map(kindOf)).toEqual(["summary-marker", "run-activity", "working-memory", "user"]);
        expect(contentText(presentLast(task.prompt).content)).toBe("compare the two groups");
        const marker = (await storedRows()).map((row) => compactionMarkerOf(row.message)).find((found) => found !== undefined);
        expect(marker).toMatchObject({ kind: "summary", tokensBefore: OVER, trigger: "turn-start" });
    });

    it("opens the turn record on the user message after a turn-start compaction, and stores the author on that row", async () => {
        await storeMeasuredTurn(OVER);
        const model = compactingModel([answer("done")], [answer(SUMMARY)]);

        const result = await runInProcessTurn(depsFor(model), params({ author: "dr.chen@lab.example" }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "done" }, opened: true });
        const rows = await storedRows();
        expect(rows.map((row) => kindOf(row.message))).toEqual([
            "user",
            "assistant",
            "exchange-user",
            "exchange-assistant",
            "summary-marker",
            "run-activity",
            "working-memory",
            "user",
            "assistant",
        ]);
        expect(rows.flatMap((row) => (row.turn === undefined ? [] : [row.seq]))).toEqual([presentAt(rows, 7).seq]);
        expect(presentAt(rows, 7).turn).toMatchObject({ status: "done" });
        expect(presentAt(rows, 7).message.content).toBe("compare the two groups");
        expect(rows.flatMap((row) => (row.author === undefined ? [] : [[row.seq, row.author]]))).toEqual([[presentAt(rows, 7).seq, "dr.chen@lab.example"]]);
        const replay = storedMessagesToChat(rows);
        expect(replay.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
        expect(presentFirst(replay).parts).toHaveLength(1);
        const [compactionPart] = presentFirst(replay).parts;
        if (compactionPart?.type !== "data-compaction") throw new Error("the turn did not store the compaction part");
        const { durationMs, ...storedPart } = compactionPart;
        expect(storedPart).toEqual({ type: "data-compaction", id: presentFirst(replay).id, status: "done", tokensBefore: OVER, trigger: "turn-start" });
        expect(durationMs).toBeTypeOf("number");
    });

    /** The frames of the compaction before and after the `message-start` of `messageId`. */
    function compactionAround(forwarded: readonly TurnEvent[], messageId: string | undefined): { before: TurnEvent[]; after: TurnEvent[] } {
        const start = forwarded.findIndex((event) => event.type === "message-start" && event.messageId === messageId);
        if (start === -1) throw new Error(`the stream announced no id ${String(messageId)}`);
        const compaction = (events: readonly TurnEvent[]) => events.filter((event) => event.type === "data-compaction");
        return { before: compaction(forwarded.slice(0, start)), after: compaction(forwarded.slice(start)) };
    }

    /** The stored display of the thread with no random id, no time, and no measured duration, thus two runs of one script compare equal. */
    async function storedDisplay(): Promise<unknown> {
        const varying = new Set(["id", "createdAt", "durationMs"]);
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the replacer masks the fields that vary between runs, and the schema-parse helper takes no replacer.
        return JSON.parse(JSON.stringify(storedMessagesToChat(await storedRows()), (key, value: unknown) => (varying.has(key) ? `<${key}>` : value)));
    }

    it("announces the user id and each assistant id of a mid-turn compaction, and the stored messages carry exactly those ids", async () => {
        const forwarded: TurnEvent[] = [];
        const model = compactingModel([overCall("tu-1"), answer("done")], [answer(SUMMARY)]);

        await runInProcessTurn(depsFor(model), params({ emit: (event) => void forwarded.push(event) }));

        const replay = storedMessagesToChat(await storedRows());
        const announced = announcedIds(forwarded);
        expect(replay.map((message) => message.role)).toEqual(["user", "assistant", "system", "assistant"]);
        expect(announced.assistant).toHaveLength(2);
        expect(replay.filter((message) => message.role !== "system").map((message) => message.id)).toEqual([...announced.user, ...announced.assistant]);
        // The two parts of the compaction stream under the first assistant id, before the second id.
        expect(compactionAround(forwarded, announced.assistant[1])).toMatchObject({
            before: [{ data: { status: "running", trigger: "mid-turn" } }, { data: { status: "done", trigger: "mid-turn" } }],
            after: [],
        });
        expect(await storedDisplay()).toEqual(MID_TURN_DISPLAY);
    });

    it("announces each id that a turn-start compaction turn stores, and the stream names one assistant id with no stored message", async () => {
        await storeMeasuredTurn(OVER);
        const forwarded: TurnEvent[] = [];
        const model = compactingModel([answer("done")], [answer(SUMMARY)]);

        await runInProcessTurn(depsFor(model), params({ emit: (event) => void forwarded.push(event) }));

        const announced = announcedIds(forwarded);
        // The stream announces the user id and a first assistant id before the `running` part of the compaction, thus before
        // the turn opens. The two parts of the compaction stream under that id. The marker round gives a second assistant
        // id, and the stream announces it after the `done` part.
        expect(forwarded.slice(0, 3)).toMatchObject([
            { type: "message-start", role: "user" },
            { type: "message-start", role: "assistant" },
            { type: "data-compaction", data: { status: "running", trigger: "turn-start" } },
        ]);
        expect(announced.assistant).toHaveLength(2);
        expect(compactionAround(forwarded, announced.assistant[1])).toMatchObject({
            before: [{ data: { status: "running", trigger: "turn-start" } }, { data: { status: "done", trigger: "turn-start" } }],
            after: [],
        });
        // The store holds the divider before the user message, and the reply under the second assistant id. The rounds
        // of the compaction keep no assistant part, thus the first assistant id has live frames only and no stored message.
        const replay = storedMessagesToChat(await storedRows());
        expect(replay.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
        expect(replay[1]?.id).toBe(announced.user[0]);
        expect(replay[2]?.id).toBe(announced.assistant[1]);
        expect(replay[0]?.id).toBeTypeOf("string");
        // The divider is no message of the turn, and the stream names its id as the id of the compaction part.
        const donePart = forwarded.find((event) => {
            if (event.type !== "data-compaction") return false;
            const record = parseUnknownRecord(event.data);
            return record !== undefined && record.status === "done" && record.id === replay[0]?.id;
        });
        expect(donePart).toBeDefined();
        expect(await storedDisplay()).toEqual(TURN_START_DISPLAY);
    });

    it("stores the exchange request, and no user message and no turn record, when an abort ends the turn-start compaction", async () => {
        await storeMeasuredTurn(OVER);
        const controller = new AbortController();
        const model = compactingModel([], [abortedBy(controller)]);

        const result = await runInProcessTurn(depsFor(model), params({ signal: controller.signal }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "aborted" }, opened: false });
        if (result.kind !== "ran") throw new Error("unreachable");
        expect(result.fallbackText ?? "").toBe("");
        const rows = await storedRows();
        expect(rows.map((row) => kindOf(row.message))).toEqual(["user", "assistant", "exchange-user"]);
        expect(rows.some((row) => row.turn !== undefined)).toBe(false);
        expect(rows.map((row) => row.message.content)).not.toContain("compare the two groups");
    });

    it("runs no turn-start compaction at the turn-start budget of the agent", async () => {
        await storeMeasuredTurn(TURN_START_BUDGET);
        const model = compactingModel([answer("done")], []);

        await runInProcessTurn(depsFor(model), params());

        expect(model.calls.map(isExchangeRequest)).toEqual([false]);
    });

    it("compacts at 80% of a context window that the provider reports below the budget", async () => {
        await storeMeasuredTurn(TURN_START_BUDGET);
        const model = compactingModel([answer("done")], [answer(SUMMARY)], { contextWindow: 1_000 });

        await runInProcessTurn(depsFor(model), params());

        expect(model.calls.map(isExchangeRequest)).toEqual([true, false]);
    });

    it("runs no turn-start compaction on a report thread, and compacts before the first request with the user message in the view", async () => {
        const store = createThreadStore(pool);
        (await store.createThread({ threadId: THREAD, analysisId: ANALYSIS_A, title: "A report", type: "report" }))._unsafeUnwrap();
        (await createThreadHistory(pool).appendTurn(THREAD, conversationRecordTurn("[Report Brief]\nDraft the methods section.")))._unsafeUnwrap();
        await storeMeasuredTurn(OVER);
        const model = compactingModel([answer("done")], [answer(SUMMARY)]);

        await runInProcessTurn(depsFor(model), params());

        expect(model.calls.map(isExchangeRequest)).toEqual([true, false]);
        expect(presentFirst(model.calls).prompt.map((message) => contentText(message.content))).toContain("compare the two groups");
        const marker = (await storedRows()).map((row) => compactionMarkerOf(row.message)).find((found) => found !== undefined);
        expect(marker).toMatchObject({ kind: "summary", trigger: "mid-turn" });
    });

    it("closes the turn aborted with the stored exchange request and no marker when an abort ends the exchange", async () => {
        const controller = new AbortController();
        const model = compactingModel([overCall("tu-1")], [abortedBy(controller)]);

        const result = await runInProcessTurn(depsFor(model), params({ signal: controller.signal }));

        expect(result).toMatchObject({ kind: "ran", outcome: { status: "aborted" } });
        if (result.kind !== "ran") throw new Error("unreachable");
        expect(result.fallbackText ?? "").toBe("");
        const rows = await storedRows();
        expect(rows.map((row) => kindOf(row.message))).toEqual(["user", "run-activity", "working-memory", "assistant", "tool", "exchange-user", "user"]);
        expect(presentFirst(rows).turn?.status).toBe("aborted");
    });

    it("runs no exchange on a thread whose agent declares no compaction rules", async () => {
        await storeMeasuredTurn(OVER);
        const model = compactingModel([overCall("tu-1"), answer("done")], []);
        const { compaction: _compaction, ...noRules } = conversationAgent();

        await runInProcessTurn(depsFor(model, { forThread: () => ok(noRules) }), params());

        expect(model.calls.some(isExchangeRequest)).toBe(false);
        expect((await storedRows()).some((row) => compactionMarkerOf(row.message) !== undefined)).toBe(false);
    });

    it("gives no policy to a sub-agent loop of the turn", async () => {
        const SUB_PROMPT = "You are the test sub-agent.";
        const model = scriptedModel([callTools(toolCall("tu-1", "delegate", {})), answer("sub answer"), answer("done")]);
        const delegate = defineTool({
            id: "delegate",
            description: "Run a sub-agent over a brief whose last request passed the budget.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async (_input, ctx) => {
                const sub = await runLoop(
                    { id: "sub-agent", systemPrompt: SUB_PROMPT, model: "claude-test", tools: [], maxIterations: 2 },
                    [
                        { role: "user", content: "brief" },
                        withRequestInputTokens({ role: "assistant", content: [{ type: "text", text: "noted" }] }, OVER),
                        { role: "user", content: "go on" },
                    ],
                    forSubAgent(ctx.session, "sub-agent"),
                    { provider: model.provider, signal: ctx.signal, emit: ctx.emit },
                );
                return ok({ answer: sub.finish.reason });
            },
        });
        const resolver: ThreadAgentResolver = { forThread: () => ok({ ...conversationAgent(), tools: [delegate] }) };

        await runInProcessTurn(depsFor(model, resolver), params());

        expect(model.calls.map((call) => systemOf(call).content === SUB_PROMPT)).toEqual([false, true, false]);
        expect(model.calls.some(isExchangeRequest)).toBe(false);
    });
});
