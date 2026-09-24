import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage, ToolResultPart } from "ai";

import { answerUnansweredToolCalls, NOT_RUN_TOOL_RESULT, notRunResult } from "./tool-call-integrity.js";

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

function toolParts(message: ModelMessage | undefined): ToolResultPart[] {
    expect(message).toBeDefined();
    expect(message!.role).toBe("tool");
    return message!.content as ToolResultPart[];
}

describe("answerUnansweredToolCalls", () => {
    it("keeps an answered call and reports nothing", () => {
        const messages: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: [toolCall("tu-1")] }, toolResult("tu-1")];

        const answered = answerUnansweredToolCalls(messages);

        expect(answered).toEqual([]);
        expect(messages.length).toBe(3);
        expect(assistantContent(messages[1])).toEqual([toolCall("tu-1")]);
    });

    it("answers an unanswered call and keeps the message whole", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "text", text: "I cannot continue." }, toolCall("tu-x", "update_working_memory")] },
        ];

        const answered = answerUnansweredToolCalls(messages);

        expect(answered).toEqual([{ toolCallId: "tu-x", toolName: "update_working_memory" }]);
        expect(messages.length).toBe(3);
        expect(assistantContent(messages[1])).toEqual([{ type: "text", text: "I cannot continue." }, toolCall("tu-x", "update_working_memory")]);
        expect(toolParts(messages[2])).toEqual([notRunResult({ toolCallId: "tu-x", toolName: "update_working_memory" })]);
    });

    it("gives one constant error text that states that the call did not run", () => {
        const result = notRunResult({ toolCallId: "tu-1", toolName: "echo" });

        expect(result).toEqual({ type: "tool-result", toolCallId: "tu-1", toolName: "echo", output: { type: "error-text", value: NOT_RUN_TOOL_RESULT } });
        expect(NOT_RUN_TOOL_RESULT).toBe("Not run: the turn ended before this call ran.");
    });

    it("keeps a message whose other part is reasoning only", () => {
        const reasoning = { role: "assistant" as const, content: [{ type: "reasoning" as const, text: "thinking" }, toolCall("tu-x")] };
        const messages: ModelMessage[] = [{ role: "user", content: "go" }, reasoning];

        const answered = answerUnansweredToolCalls(messages);

        expect(answered.length).toBe(1);
        expect(messages[1]).toBe(reasoning);
        expect(toolParts(messages[2]).map((r) => r.toolCallId)).toEqual(["tu-x"]);
    });

    it("answers a dangling call in the middle of a transcript after its existing results", () => {
        const messages: ModelMessage[] = [
            { role: "user", content: "go" },
            { role: "assistant", content: [toolCall("tu-1"), toolCall("tu-2")] },
            toolResult("tu-1"),
            { role: "user", content: "next turn" },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
        ];

        const answered = answerUnansweredToolCalls(messages);

        expect(answered).toEqual([{ toolCallId: "tu-2", toolName: "echo" }]);
        expect(assistantContent(messages[1])).toEqual([toolCall("tu-1"), toolCall("tu-2")]);
        // [user, assistant, tool(tu-1), tool(tu-2 not run), user, assistant]
        expect(messages.length).toBe(6);
        expect(toolParts(messages[2]).map((r) => r.toolCallId)).toEqual(["tu-1"]);
        expect(toolParts(messages[3]).map((r) => [r.toolCallId, r.output.type])).toEqual([["tu-2", "error-text"]]);
        expect(messages[4]).toEqual({ role: "user", content: "next turn" });
    });

    it("does not answer before fromIndex, and still scans the whole array for results", () => {
        const messages: ModelMessage[] = [
            { role: "assistant", content: [toolCall("tu-prefix")] },
            { role: "assistant", content: [toolCall("tu-loop")] },
        ];

        const answered = answerUnansweredToolCalls(messages, 1);

        // The prefix message is not this caller's to repair; the in-range call is answered.
        expect(answered).toEqual([{ toolCallId: "tu-loop", toolName: "echo" }]);
        expect(messages.length).toBe(3);
        expect(assistantContent(messages[0])).toEqual([toolCall("tu-prefix")]);
        expect(toolParts(messages[2]).map((r) => r.toolCallId)).toEqual(["tu-loop"]);
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

        const answered = answerUnansweredToolCalls(messages);

        expect(answered).toEqual([]);
        expect(messages.length).toBe(1);
    });

    it("reports answers across messages in transcript order", () => {
        const messages: ModelMessage[] = [
            { role: "assistant", content: [{ type: "text", text: "a" }, toolCall("tu-1"), toolCall("tu-2")] },
            { role: "assistant", content: [{ type: "text", text: "b" }, toolCall("tu-3")] },
        ];

        const answered = answerUnansweredToolCalls(messages);

        expect(answered.map((d) => d.toolCallId)).toEqual(["tu-1", "tu-2", "tu-3"]);
        // Each answer goes directly after its own assistant message.
        expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    });

    it("gives the same messages for the same window each time", () => {
        const window = (): ModelMessage[] => [
            { role: "user", content: "go" },
            { role: "assistant", content: [toolCall("tu-x")] },
            { role: "user", content: "again" },
        ];
        const first = window();
        const second = window();

        answerUnansweredToolCalls(first);
        answerUnansweredToolCalls(second);

        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
});
