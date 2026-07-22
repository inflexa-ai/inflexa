import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { makeSession } from "./__fixtures__/session.js";
import { makeMessage, textBlock } from "../loop/__fixtures__/scripted-provider.js";
import { createStreamingChat } from "./streaming-chat.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChatStreamEvent } from "./types.js";

const REQUEST: ChatRequest = { system: "test", messages: [], tools: {} };

/** A `ChatProvider` whose `chatStream` yields the given deltas, then `done`. */
function streamingFake(deltas: readonly string[], final: ChatResponse, options: { omitDone?: boolean } = {}): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: () => okAsync(final),
        chatStream: async function* (): AsyncIterable<ChatStreamEvent> {
            for (const text of deltas) yield { type: "text-delta", text };
            if (!options.omitDone) yield { type: "done", response: final };
        },
    };
}

/** A `ChatProvider` whose `chatStream` yields the given deltas, then throws `toThrow` mid-flight. */
function throwingStreamFake(deltas: readonly string[], toThrow: unknown): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: () => okAsync(makeMessage([textBlock("unused")], "end_turn")),
        chatStream: async function* (): AsyncIterable<ChatStreamEvent> {
            for (const text of deltas) yield { type: "text-delta", text };
            throw toThrow;
        },
    };
}

describe("createStreamingChat", () => {
    it("forwards every text delta in order and returns the final Message", async () => {
        const final = makeMessage([textBlock("hello world")], "end_turn");
        const seen: string[] = [];
        const streaming = createStreamingChat(streamingFake(["hel", "lo ", "world"], final), (t) => seen.push(t));

        const result = (await streaming.chat(REQUEST, makeSession()))._unsafeUnwrap();

        expect(result).toBe(final);
        expect(seen).toEqual(["hel", "lo ", "world"]);
    });

    it("returns the Message without text deltas for a tool-only reply", async () => {
        const final = makeMessage([textBlock("")], "tool_use");
        const seen: string[] = [];
        const streaming = createStreamingChat(streamingFake([], final), (t) => seen.push(t));

        const result = (await streaming.chat(REQUEST, makeSession()))._unsafeUnwrap();

        expect(result).toBe(final);
        expect(seen).toEqual([]);
    });

    it("returns a provider err when the stream ends without a final message", async () => {
        const final = makeMessage([textBlock("x")], "end_turn");
        const streaming = createStreamingChat(streamingFake(["x"], final, { omitDone: true }), () => {});

        const result = await streaming.chat(REQUEST, makeSession());
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            const error = result.error;
            expect(error.type).toBe("provider");
            expect(error.message).toContain("ended without a final message");
        }
    });

    it("resolves aborted with the concatenated partial when the stream aborts mid-flight", async () => {
        const seen: string[] = [];
        const abort = new DOMException("The operation was aborted.", "AbortError");
        const streaming = createStreamingChat(throwingStreamFake(["hel", "lo ", "wor"], abort), (t) => seen.push(t));

        const result = (await streaming.chat(REQUEST, makeSession()))._unsafeUnwrap();

        expect(result.finishReason).toBe("aborted");
        expect(result.message).toEqual({ role: "assistant", content: "hello wor" });
        // Every delta that arrived before the abort was still forwarded.
        expect(seen).toEqual(["hel", "lo ", "wor"]);
    });

    it("treats an Error named AbortError the same as a DOMException abort", async () => {
        const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
        const streaming = createStreamingChat(throwingStreamFake(["partial"], abort), () => {});

        const result = (await streaming.chat(REQUEST, makeSession()))._unsafeUnwrap();

        expect(result.finishReason).toBe("aborted");
        expect(result.message).toEqual({ role: "assistant", content: "partial" });
    });

    it("resolves aborted with an empty partial when the abort beats the first delta", async () => {
        const seen: string[] = [];
        const abort = new DOMException("The operation was aborted.", "AbortError");
        const streaming = createStreamingChat(throwingStreamFake([], abort), (t) => seen.push(t));

        const result = (await streaming.chat(REQUEST, makeSession()))._unsafeUnwrap();

        expect(result.finishReason).toBe("aborted");
        expect(result.message).toEqual({ role: "assistant", content: "" });
        expect(seen).toEqual([]);
    });

    it("returns a provider err when the stream throws a non-abort failure", async () => {
        const streaming = createStreamingChat(throwingStreamFake(["x"], new Error("upstream 500")), () => {});

        const result = await streaming.chat(REQUEST, makeSession());
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("provider");
            expect(result.error.message).toContain("upstream 500");
        }
    });
});
