import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { stripUnansweredToolCalls } from "./tool-call-integrity.js";

function toolCall(toolCallId: string, toolName = "echo"): { type: "tool-call"; toolCallId: string; toolName: string; input: unknown } {
    return { type: "tool-call", toolCallId, toolName, input: {} };
}

function toolResult(toolCallId: string, toolName = "echo"): ModelMessage {
    return {
        role: "tool",
        content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value: { ok: true } } }],
    };
}

function assistantContent(message: ModelMessage | undefined): AssistantModelMessage["content"] {
    expect(message).toBeDefined();
    expect(message!.role).toBe("assistant");
    // Safe: the role assertion above fails the test before this cast can lie.
    return message!.content as AssistantModelMessage["content"];
}

describe("stripUnansweredToolCalls", () => {
    it("keeps an answered call and reports nothing", () => {
        const messages: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: [toolCall("tu-1")] }, toolResult("tu-1")];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped).toEqual([]);
        expect(messages.length).toBe(3);
        expect(assistantContent(messages[1])).toEqual([toolCall("tu-1")]);
    });

    it("strips an unanswered call and keeps the text beside it", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "text", text: "I cannot continue." }, toolCall("tu-x", "update_working_memory")] },
        ];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped).toEqual([{ toolCallId: "tu-x", toolName: "update_working_memory" }]);
        expect(messages.length).toBe(2);
        expect(assistantContent(messages[1])).toEqual([{ type: "text", text: "I cannot continue." }]);
    });

    it("removes a call-only message whole", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: "go" },
            { role: "assistant", content: [toolCall("tu-x")] },
        ];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped).toEqual([{ toolCallId: "tu-x", toolName: "echo" }]);
        expect(messages).toEqual([{ role: "user", content: "go" }]);
    });

    it("removes a message whose remainder is reasoning only", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, toolCall("tu-x")] },
        ];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped.length).toBe(1);
        expect(messages).toEqual([{ role: "user", content: "go" }]);
    });

    it("repairs a dangling call in the middle of a transcript", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: "go" },
            { role: "assistant", content: [toolCall("tu-1"), toolCall("tu-2")] },
            toolResult("tu-1"),
            { role: "user", content: "next turn" },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
        ];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped).toEqual([{ toolCallId: "tu-2", toolName: "echo" }]);
        expect(assistantContent(messages[1])).toEqual([toolCall("tu-1")]);
        expect(messages.length).toBe(5);
    });

    it("does not repair before fromIndex, and still scans the whole array for results", () => {
        const messages: ModelMessage[] = [
            { role: "assistant", content: [toolCall("tu-prefix")] },
            { role: "assistant", content: [toolCall("tu-loop")] },
        ];

        const dropped = stripUnansweredToolCalls(messages, 1);

        // The prefix message is not this caller's to repair; the in-range call goes.
        expect(dropped).toEqual([{ toolCallId: "tu-loop", toolName: "echo" }]);
        expect(messages.length).toBe(1);
        expect(assistantContent(messages[0])).toEqual([toolCall("tu-prefix")]);
    });

    it("skips a provider-executed call whose result rides the same message", () => {
        const messages: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    { ...toolCall("tu-server", "web_search"), providerExecuted: true },
                    { type: "tool-result", toolCallId: "tu-server", toolName: "web_search", output: { type: "json", value: {} } },
                ],
            },
        ];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped).toEqual([]);
        expect(messages.length).toBe(1);
    });

    it("reports removals across messages in transcript order", () => {
        const messages: ModelMessage[] = [
            { role: "assistant", content: [{ type: "text", text: "a" }, toolCall("tu-1"), toolCall("tu-2")] },
            { role: "assistant", content: [{ type: "text", text: "b" }, toolCall("tu-3")] },
        ];

        const dropped = stripUnansweredToolCalls(messages);

        expect(dropped.map((d) => d.toolCallId)).toEqual(["tu-1", "tu-2", "tu-3"]);
    });
});
