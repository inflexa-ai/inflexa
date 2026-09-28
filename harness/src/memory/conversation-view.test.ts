import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
    contextRecordMessage,
    dropMarkerMessage,
    markCompactionExchange,
    summaryMarkerMessage,
    syntheticRecordMessage,
    syntheticUserMessage,
    withRequestInputTokens,
} from "./ai-sdk-message-storage.js";
import { conversationView, lastRequestInputTokens, withoutReasoning } from "./conversation-view.js";

function user(text: string): ModelMessage {
    return { role: "user", content: text };
}

function assistant(text: string): ModelMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
}

function thinking(reasoning: string, text: string): ModelMessage {
    return {
        role: "assistant",
        content: [
            { type: "reasoning", text: reasoning, providerOptions: { anthropic: { signature: `SIG-${reasoning}` } } },
            { type: "text", text },
        ],
    };
}

function toolCall(id: string): ModelMessage {
    return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "echo", input: { label: id } }] };
}

function toolResult(id: string): ModelMessage {
    return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "echo", output: { type: "json", value: { label: id } } }] };
}

function summary(id: string, text: string): ModelMessage {
    return summaryMarkerMessage(text, { kind: "summary", id, tokensBefore: 100, durationMs: 5 });
}

function anchored(message: ModelMessage, tokens: number): ModelMessage {
    if (message.role !== "assistant") throw new Error("an anchor rides an assistant message");
    return withRequestInputTokens(message, tokens);
}

function drop(id: string, keptTurns: number): ModelMessage {
    return dropMarkerMessage({ kind: "drop", id, tokensBefore: 100, durationMs: 5, keptTurns });
}

function exchange(id: string): ModelMessage[] {
    return [syntheticUserMessage("Reply with the summary."), toolCall(`${id}-memory`), toolResult(`${id}-memory`), assistant(`summary ${id}`)].map((message) =>
        markCompactionExchange(message, id),
    );
}

const record = (text: string): ModelMessage => contextRecordMessage("run-activity", `[Run Activity]\n${text}`);

describe("conversationView", () => {
    it("gives each message of a list with no marker, and each index as its source", () => {
        const messages = [user("u1"), record("none"), toolCall("t1"), toolResult("t1"), assistant("a1"), user("u2"), assistant("a2")];

        const view = conversationView(messages, {});

        expect(view.messages).toEqual(messages);
        expect(view.sources).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("counts only the latest summary marker", () => {
        const second = summary("c-2", "second");
        const messages = [
            user("u1"),
            assistant("a1"),
            ...exchange("c-1"),
            summary("c-1", "first"),
            record("r1"),
            user("u2"),
            ...exchange("c-2"),
            second,
            record("r2"),
        ];

        const view = conversationView(messages, {});

        expect(view.messages).toEqual([second, record("r2")]);
        expect(view.sources).toEqual([messages.indexOf(second), messages.length - 1]);
    });

    it("never holds an exchange message, also when no marker comes after the exchange", () => {
        const messages = [user("u1"), assistant("a1"), ...exchange("c-1")];

        expect(conversationView(messages, {}).messages).toEqual([user("u1"), assistant("a1")]);
    });

    it("keeps the seed of a thread in front of the summary marker", () => {
        const seed = syntheticRecordMessage("[Report Brief]\nThe brief.");
        const marker = summary("c-1", "the report so far");
        const messages = [seed, user("u1"), record("r0"), assistant("a1"), ...exchange("c-1"), marker, record("r1"), assistant("a2")];

        expect(conversationView(messages, { keepFirstTurn: true }).messages).toEqual([seed, marker, record("r1"), assistant("a2")]);
        expect(conversationView(messages, {}).messages).toEqual([marker, record("r1"), assistant("a2")]);
    });

    it("keeps the summary in front of a drop, and then the last kept turns", () => {
        const marker = summary("c-1", "first");
        const messages = [
            user("u1"),
            ...exchange("c-1"),
            marker,
            record("r1"),
            assistant("a1"),
            user("u2"),
            assistant("a2"),
            user("u3"),
            toolCall("t3"),
            toolResult("t3"),
            ...exchange("c-2"),
            drop("c-2", 2),
            record("r2"),
        ];

        expect(conversationView(messages, {}).messages).toEqual([
            marker,
            user("u2"),
            assistant("a2"),
            user("u3"),
            toolCall("t3"),
            toolResult("t3"),
            record("r2"),
        ]);
    });

    it("strips the reasoning of a kept message, and keeps the reasoning of a message after the drop", () => {
        const later = thinking("later", "a3");
        const messages = [user("u1"), thinking("early", "a1"), user("u2"), thinking("kept", "a2"), ...exchange("c-1"), drop("c-1", 1), later];

        const view = conversationView(messages, {}).messages;

        expect(view).toEqual([user("u2"), assistant("a2"), later]);
        expect(messages[3]).toEqual(thinking("kept", "a2"));
    });

    it("leaves out a kept assistant message that holds only a reasoning part", () => {
        const onlyReasoning: ModelMessage = { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] };
        const messages = [user("u1"), onlyReasoning, assistant("a1"), ...exchange("c-1"), drop("c-1", 1)];

        const view = conversationView(messages, {});

        expect(view.messages).toEqual([user("u1"), assistant("a1")]);
        expect(view.sources).toEqual([0, 2]);
    });

    it("gives a view whose view is byte-identical", () => {
        const seed = syntheticRecordMessage("[Report Brief]\nThe brief.");
        const messages = [
            seed,
            user("u1"),
            ...exchange("c-1"),
            summary("c-1", "first"),
            record("r1"),
            thinking("t", "a1"),
            user("u2"),
            thinking("t2", "a2"),
            ...exchange("c-2"),
            drop("c-2", 1),
            record("r2"),
            thinking("t3", "a3"),
        ];

        for (const keepFirstTurn of [true, false]) {
            const view = conversationView(messages, { keepFirstTurn }).messages;
            expect(JSON.stringify(conversationView(view, { keepFirstTurn }).messages)).toBe(JSON.stringify(view));
        }
    });
});

describe("lastRequestInputTokens", () => {
    it("gives the input tokens of the latest assistant message that holds them", () => {
        const messages = [user("u1"), anchored(assistant("a1"), 40_000), user("u2"), anchored(toolCall("t2"), 50_000), toolResult("t2"), record("r2")];

        expect(lastRequestInputTokens(messages)).toBe(50_000);
    });

    it("gives no figure when a marker follows the latest assistant message that holds them", () => {
        const messages = [user("u1"), anchored(assistant("a1"), 90_000), ...exchange("c-1"), summary("c-1", "first"), record("r1")];

        expect(lastRequestInputTokens(messages)).toBeUndefined();
        expect(lastRequestInputTokens([...messages.slice(0, -2), drop("c-1", 1), record("r1")])).toBeUndefined();
    });

    it("gives the input tokens of an assistant message after the marker", () => {
        const messages = [user("u1"), anchored(assistant("a1"), 90_000), ...exchange("c-1"), drop("c-1", 1), record("r1"), anchored(assistant("a2"), 30_000)];

        expect(lastRequestInputTokens(messages)).toBe(30_000);
    });

    it("gives no figure when no assistant message holds them", () => {
        expect(lastRequestInputTokens([user("u1"), assistant("a1"), user("u2")])).toBeUndefined();
        expect(lastRequestInputTokens([])).toBeUndefined();
    });
});

describe("withoutReasoning", () => {
    it("gives each other message unchanged", () => {
        const message = user("u1");

        expect(withoutReasoning(message)).toBe(message);
        expect(withoutReasoning(toolResult("t1"))).toEqual(toolResult("t1"));
        expect(withoutReasoning(assistant("a1"))).toEqual(assistant("a1"));
    });
});
