import { describe, test, expect } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { okAsync } from "neverthrow";

import { assembleMessages } from "./message-assembly.js";
import type { ThreadHistory } from "../memory/thread-history.js";
import type { WorkingMemoryStore } from "../memory/working-memory.js";
import { emptyWorkingMemory } from "../memory/working-memory.js";

const WM_RENDER = "# Working Memory\n\n## Goal\n\n_none yet_\n";

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
    test("places analysis context, working memory, and user input in the tail", async () => {
        const window: MessageParam[] = [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
        ];
        const { messages, userMessage } = await assembleMessages({
            threadId: "thread-1",
            analysisId: "analysis-1",
            userInput: "what is BRCA1?",
            analysisContext: "RNA-seq of tumor vs normal.",
            history: stubHistory(window),
            workingMemory: stubWorkingMemory(),
        });

        // history window stays the cacheable prefix, untouched.
        expect(messages.slice(0, 2)).toEqual(window);
        // tail order: analysis context, working memory, user input.
        expect(messages.length).toBe(5);
        expect(contentText(messages[2]!)).toContain("[Analysis Context]");
        expect(contentText(messages[2]!)).toContain("RNA-seq of tumor vs normal.");
        expect(contentText(messages[3]!)).toBe(WM_RENDER);
        expect(messages[4]).toEqual(userMessage);
        expect(userMessage.content).toBe("what is BRCA1?");
    });

    test("the assembled sequence is a valid Anthropic message sequence", async () => {
        const { messages } = await assembleMessages({
            threadId: "thread-1",
            analysisId: "analysis-1",
            userInput: "hello",
            analysisContext: null,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });
        // First message is a genuine user message; no tool_use/tool_result split.
        expect(messages[0]!.role).toBe("user");
        // With no analysis context, the tail is working memory + user input only.
        expect(messages.length).toBe(2);
        expect(messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    });

    test("redacts a secret in the user input", async () => {
        const { userMessage } = await assembleMessages({
            threadId: "t",
            analysisId: "a",
            userInput: "my key is AKIAIOSFODNN7EXAMPLE keep it safe",
            analysisContext: null,
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
            analysisId: "a",
            userInput: `align this sequence ${fortyMer} please`,
            analysisContext: null,
            history: stubHistory([]),
            workingMemory: stubWorkingMemory(),
        });
        expect(userMessage.content).toContain(fortyMer);
    });

    test("sanitization is not applied to history or analysis context", async () => {
        const secret = "AKIAIOSFODNN7EXAMPLE";
        const window: MessageParam[] = [{ role: "user", content: `prior turn mentioned ${secret}` }];
        const { messages } = await assembleMessages({
            threadId: "t",
            analysisId: "a",
            userInput: "continue",
            analysisContext: `context references ${secret}`,
            history: stubHistory(window),
            workingMemory: stubWorkingMemory(),
        });
        // History message is passed through verbatim.
        expect(contentText(messages[0]!)).toContain(secret);
        // Analysis context message is passed through verbatim.
        expect(contentText(messages[1]!)).toContain(secret);
    });
});
