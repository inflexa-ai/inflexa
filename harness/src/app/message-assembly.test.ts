import { describe, test, expect } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { okAsync } from "neverthrow";

import { assembleMessages } from "./message-assembly.js";
import type { ThreadHistory } from "../memory/thread-history.js";
import type { WorkingMemoryStore } from "../memory/working-memory.js";
import { emptyWorkingMemory } from "../memory/working-memory.js";

const WM_RENDER = "# Working Memory\n\n## Goal\n\n_none yet_\n";
const RUN_ACTIVITY = "[Run Activity]\nNo runs are currently running or suspended.";

function stubHistory(window: MessageParam[]): ThreadHistory {
    return {
        appendTurn: () => okAsync(undefined),
        loadRecent: () => okAsync(window),
        loadPage: () =>
            okAsync({
                messages: [],
                total: 0,
                page: 0,
                perPage: 40,
                hasMore: false,
            }),
    };
}

const SEED = "the report brief";
const RECENT = "a recent turn";

/**
 * A store that stands in for an over-budget thread: the seed message survives
 * the eviction only when the read keeps the first turn.
 */
function seedKeepingHistory(): ThreadHistory {
    return {
        ...stubHistory([]),
        loadRecent: (_threadId, _budget, options) =>
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
    test("places analysis context, run activity, working memory, and user input in the tail", async () => {
        const window: MessageParam[] = [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
        ];
        const { messages, userMessage } = await assembleMessages({
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "what is BRCA1?",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory(window),
            workingMemory: stubWorkingMemory(),
        });

        // history window stays the cacheable prefix, untouched.
        expect(messages.slice(0, 2)).toEqual(window);
        // tail order: analysis context, run activity, working memory, user input.
        expect(messages.length).toBe(6);
        expect(contentText(messages[2]!)).toContain("[Analysis Context]");
        expect(contentText(messages[2]!)).toContain("RNA-seq of tumor vs normal.");
        expect(contentText(messages[3]!)).toBe(RUN_ACTIVITY);
        expect(contentText(messages[4]!)).toBe(WM_RENDER);
        expect(messages[5]).toEqual(userMessage);
        expect(userMessage.content).toBe("what is BRCA1?");
    });

    test("the assembled sequence is a valid Anthropic message sequence", async () => {
        const { messages } = await assembleMessages({
            threadId: "thread-1",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "hello",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });
        // First message is a genuine user message; no tool_use/tool_result split.
        expect(messages[0]!.role).toBe("user");
        // With no analysis context, the tail is run activity + working memory + user input.
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

    test("a report thread drops the working-memory tail and keeps the other two", async () => {
        const { messages, userMessage } = await assembleMessages({
            threadId: "thread-report",
            threadType: "report",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });

        // Tail: analysis context, run activity, user input. No live render.
        expect(messages.length).toBe(3);
        expect(messages.map(contentText)).not.toContain(WM_RENDER);
        expect(contentText(messages[0]!)).toContain("[Analysis Context]");
        expect(contentText(messages[1]!)).toBe(RUN_ACTIVITY);
        expect(messages[2]).toEqual(userMessage);
    });

    test("a report thread loads a window that keeps the seed", async () => {
        const { messages } = await assembleMessages({
            threadId: "thread-report",
            threadType: "report",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: seedKeepingHistory(),
            workingMemory: stubWorkingMemory(),
        });

        expect(contentText(messages[0]!)).toBe(SEED);
    });

    test("a conversation thread loads a window that evicts the seed", async () => {
        const { messages } = await assembleMessages({
            threadId: "thread-conversation",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: null,
            runActivityContext: RUN_ACTIVITY,
            history: seedKeepingHistory(),
            workingMemory: stubWorkingMemory(),
        });

        expect(messages.map(contentText)).not.toContain(SEED);
    });

    test("a conversation thread keeps the working-memory tail", async () => {
        const { messages } = await assembleMessages({
            threadId: "thread-conversation",
            threadType: "conversation",
            analysisId: "analysis-1",
            userInput: "draft the summary",
            analysisContext: "RNA-seq of tumor vs normal.",
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });

        expect(messages.length).toBe(4);
        expect(messages.map(contentText)).toContain(WM_RENDER);
    });

    test("sanitization is not applied to history or analysis context", async () => {
        const secret = "AKIAIOSFODNN7EXAMPLE";
        const window: MessageParam[] = [{ role: "user", content: `prior turn mentioned ${secret}` }];
        const { messages } = await assembleMessages({
            threadId: "t",
            threadType: "conversation",
            analysisId: "a",
            userInput: "continue",
            analysisContext: `context references ${secret}`,
            runActivityContext: RUN_ACTIVITY,
            history: stubHistory(window),
            workingMemory: stubWorkingMemory(),
        });
        // History message is passed through verbatim.
        expect(contentText(messages[0]!)).toContain(secret);
        // Analysis context message is passed through verbatim.
        expect(contentText(messages[1]!)).toContain(secret);
    });
});
