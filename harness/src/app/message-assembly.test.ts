import { describe, test, expect } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ModelMessage } from "ai";
import { okAsync } from "neverthrow";

import { assembleMessages, type AssembleMessagesArgs } from "./message-assembly.js";
import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { contextRecordOf, isSyntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import type { ThreadHistory } from "../memory/thread-history.js";
import { NOT_RUN_TOOL_RESULT } from "../memory/tool-call-integrity.js";
import type { WorkingMemoryStore } from "../memory/working-memory.js";
import { emptyWorkingMemory } from "../memory/working-memory.js";

const WM_RENDER = "# Working Memory\n\n## Goal\n\n_none yet_\n";
const RUN_ACTIVITY = "[Run Activity]\nNo runs are currently running or suspended.";

function stubHistory(window: MessageParam[]): ThreadHistory {
    return {
        appendTurn: () => okAsync(undefined),
        loadRecent: () => okAsync(window),
        loadAll: () => okAsync([]),
    };
}

const SEED = "the report brief";
const RECENT = "a recent turn";

/**
 * A store that stands in for a compacted thread: the seed message stays in front
 * of the view only when the read keeps the first turn.
 */
function seedKeepingHistory(): ThreadHistory {
    return {
        ...stubHistory([]),
        loadRecent: (_threadId, options) =>
            okAsync(
                options?.keepFirstTurn === true
                    ? [
                          { role: "user", content: SEED },
                          { role: "user", content: RECENT },
                      ]
                    : [{ role: "user", content: RECENT }],
            ),
    };
}

function stubWorkingMemory(render = WM_RENDER): WorkingMemoryStore {
    return {
        load: () => okAsync(emptyWorkingMemory()),
        updateSection: () => okAsync(undefined),
        render: () => okAsync(render),
    };
}

function contentText(m: MessageParam): string {
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

describe("assembleMessages", () => {
    test("gives the view as the history, the user input, and then the analysis context, the run activity, and the working memory", async () => {
        const window: MessageParam[] = [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
        ];
        const { history, userMessage, contextRecords } = await assembleMessages({
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "what is BRCA1?",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory(window),
            workingMemory: stubWorkingMemory(),
        });

        expect(history).toEqual(window);
        expect(userMessage.content).toBe("what is BRCA1?");
        expect(contextRecords.map(contentText)).toEqual(["[Analysis Context]\nRNA-seq of tumor vs normal.", RUN_ACTIVITY, `[Working Memory]\n${WM_RENDER}`]);
    });

    test("the assembled sequence is a valid Anthropic message sequence", async () => {
        const { history, userMessage, contextRecords } = await assembleMessages({
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "hello",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });
        const messages = [...history, userMessage, ...contextRecords];
        expect(messages[0]!.role).toBe("user");
        expect(isSyntheticUserMessage(messages[0]!)).toBe(false);
        expect(messages.length).toBe(3);
        expect(messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    });

    test("redacts a secret in the user input", async () => {
        const { userMessage } = await assembleMessages({
            threadId: "t",
            threadType: "conversation",
            analysisId: "a",
            userInput: "my key is AKIAIOSFODNN7EXAMPLE keep it safe",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });
        expect(userMessage.content).toContain("[REDACTED: AWS Access Key]");
        expect(userMessage.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    test("does NOT redact a 40-mer in the user input", async () => {
        const fortyMer = "ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT";
        expect(fortyMer.length).toBe(40);
        const { userMessage } = await assembleMessages({
            threadId: "t",
            threadType: "conversation",
            analysisId: "a",
            userInput: `align this sequence ${fortyMer} please`,
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });
        expect(userMessage.content).toContain(fortyMer);
    });

    test("a report thread gets no working-memory record and keeps the other two", async () => {
        const { contextRecords } = await assembleMessages({
            threadId: "thread-report",
            threadType: "report",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });

        expect(contextRecords.length).toBe(2);
        expect(contentText(contextRecords[0]!)).toContain("[Analysis Context]");
        expect(contentText(contextRecords[1]!)).toBe(RUN_ACTIVITY);
    });

    test("a report thread loads a view that keeps the seed", async () => {
        const { history } = await assembleMessages({
            threadId: "thread-report",
            threadType: "report",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: seedKeepingHistory(),
            workingMemory: stubWorkingMemory(),
        });

        expect(contentText(history[0]!)).toBe(SEED);
    });

    test("a conversation thread loads a view without the seed", async () => {
        const { history } = await assembleMessages({
            threadId: "thread-conversation",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: seedKeepingHistory(),
            workingMemory: stubWorkingMemory(),
        });

        expect(history.map(contentText)).not.toContain(SEED);
    });

    test("a conversation thread gets a working-memory record", async () => {
        const { contextRecords } = await assembleMessages({
            threadId: "thread-conversation",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });

        expect(contextRecords.length).toBe(3);
        expect(contextRecords.map(contentText)).toContain(`[Working Memory]\n${WM_RENDER}`);
    });

    test("sanitization is not applied to history or analysis context", async () => {
        const secret = "AKIAIOSFODNN7EXAMPLE";
        const window: MessageParam[] = [{ role: "user", content: `prior turn mentioned ${secret}` }];
        const { history, contextRecords } = await assembleMessages({
            threadId: "t",
            threadType: "conversation",
            analysisId: "a",
            userInput: "continue",
            analysisContext: `context references ${secret}`,
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory(window),
            workingMemory: stubWorkingMemory(),
        });
        expect(contentText(history[0]!)).toContain(secret);
        expect(contentText(contextRecords[0]!)).toContain(secret);
    });

    /** {@link stubHistory} typed over the AI SDK shape, for a window that carries tool parts. */
    function modelHistory(window: ModelMessage[]): ThreadHistory {
        return {
            ...stubHistory([]),
            loadRecent: () => okAsync(window),
        };
    }

    /** Returns a fresh array each call, like a real store read. */
    function danglingWindow(): ModelMessage[] {
        return [
            { role: "user", content: "earlier question" },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "on it" },
                    { type: "tool-call", toolCallId: "tu-x", toolName: "update_working_memory", input: {} },
                ],
            },
            { role: "user", content: "and then?" },
        ];
    }

    function assembleDangling(logger = createCapturingLogger()) {
        return assembleMessages({
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "what happened?",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: { ...stubHistory([]), loadRecent: () => okAsync(danglingWindow()) },
            workingMemory: stubWorkingMemory(),
            logger,
        });
    }

    test("answers a stored dangling tool call in place and logs the answer", async () => {
        const logger = createCapturingLogger();

        const { history } = await assembleDangling(logger);

        expect(history[1]).toEqual(danglingWindow()[1]!);
        expect(history[2]).toEqual({
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "tu-x",
                    toolName: "update_working_memory",
                    output: { type: "error-text", value: NOT_RUN_TOOL_RESULT },
                },
            ],
        });
        expect(history[3]).toEqual({ role: "user", content: "and then?" });
        const warn = logger.records.find((r) => r.level === "warn");
        expect(warn?.msg).toContain("unanswered tool calls answered in thread history");
        expect(warn?.fields).toMatchObject({ threadId: "thread-1", toolCallIds: ["tu-x"], tools: ["update_working_memory"] });
    });

    test("two assemblies of one window send byte-identical messages", async () => {
        const first = await assembleDangling();
        const second = await assembleDangling();

        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    test("keeps an answered tool call untouched and logs nothing", async () => {
        const logger = createCapturingLogger();
        const window: ModelMessage[] = [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "tu-1", toolName: "read_file", input: {} }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "tu-1", toolName: "read_file", output: { type: "json", value: {} } }] },
        ];

        const { history } = await assembleMessages({
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "continue",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: modelHistory(window),
            workingMemory: stubWorkingMemory(),
            logger,
        });

        expect(history).toEqual(window);
        expect(logger.records).toEqual([]);
    });
});

describe("assembleMessages — context records", () => {
    function argsOver(window: readonly ModelMessage[], overrides: Partial<AssembleMessagesArgs> = {}): AssembleMessagesArgs {
        return {
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "next question",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: { ...stubHistory([]), loadRecent: () => okAsync([...window]) },
            workingMemory: stubWorkingMemory(),
            ...overrides,
        };
    }

    /** The stored rows of one earlier turn: its user message and the records of its opening. */
    async function storedTurn(overrides: Partial<AssembleMessagesArgs> = {}): Promise<ModelMessage[]> {
        const { userMessage, contextRecords } = await assembleMessages(argsOver([], overrides));
        return [userMessage, ...contextRecords, { role: "assistant", content: [{ type: "text", text: "an answer" }] }];
    }

    const kindsOf = (records: readonly ModelMessage[]): (string | undefined)[] => records.map((record) => contextRecordOf(record)?.kind);

    test("gives each kind after the user message, in order, when the window holds no record", async () => {
        const { history, contextRecords } = await assembleMessages(argsOver([]));

        expect(kindsOf(contextRecords)).toEqual(["analysis-context", "run-activity", "working-memory"]);
        expect(history).toEqual([]);
        expect(contextRecords.every((record) => isSyntheticUserMessage(record))).toBe(true);
    });

    test("gives no record when the window holds the same records", async () => {
        const window = await storedTurn();

        const { history, contextRecords } = await assembleMessages(argsOver(window));

        expect(contextRecords).toEqual([]);
        expect(history).toEqual(window);
    });

    test("gives one working-memory record when the memory changed", async () => {
        const window = await storedTurn();

        const { contextRecords } = await assembleMessages(argsOver(window, { workingMemory: stubWorkingMemory("# Working Memory\n\n## Goal\n\nmap BRCA1\n") }));

        expect(kindsOf(contextRecords)).toEqual(["working-memory"]);
        expect(contextRecords[0]!.content).toContain("map BRCA1");
    });

    test("compares with the latest record of a kind only", async () => {
        const changed = stubWorkingMemory("# Working Memory\n\n## Goal\n\nmap BRCA1\n");
        const window = [...(await storedTurn()), ...(await storedTurn({ workingMemory: changed }))];

        const { contextRecords } = await assembleMessages(argsOver(window));

        expect(kindsOf(contextRecords)).toEqual(["working-memory"]);
        expect(contextRecords[0]!.content).toBe(`[Working Memory]\n${WM_RENDER}`);
    });

    test("gives no working-memory record on a report thread", async () => {
        const { contextRecords } = await assembleMessages(argsOver([], { threadType: "report" }));

        expect(kindsOf(contextRecords)).toEqual(["analysis-context", "run-activity"]);
    });

    test("gives the empty-state text for an empty working memory", async () => {
        const { contextRecords } = await assembleMessages(argsOver([], { workingMemory: stubWorkingMemory("") }));

        expect(contextRecords.at(-1)!.content).toBe("[Working Memory]\nThe working memory is empty.");
    });

    test("gives no analysis-context record for a null context", async () => {
        const { contextRecords } = await assembleMessages(argsOver([], { analysisContext: null }));

        expect(kindsOf(contextRecords)).toEqual(["run-activity", "working-memory"]);
    });
});
