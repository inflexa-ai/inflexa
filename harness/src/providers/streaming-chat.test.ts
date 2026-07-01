import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { makeSession } from "./__fixtures__/session.js";
import { makeMessage, textBlock } from "../loop/__fixtures__/scripted-provider.js";
import { createStreamingChat } from "./streaming-chat.js";
import type { ChatProvider, ChatRequest, ChatStreamEvent, Message } from "./types.js";

const REQUEST: ChatRequest = { messages: [] };

/** A `ChatProvider` whose `chatStream` yields the given deltas, then `done`. */
function streamingFake(deltas: readonly string[], final: Message, options: { omitDone?: boolean } = {}): ChatProvider {
    return {
        chat: () => okAsync(final),
        // eslint-disable-next-line @typescript-eslint/require-await
        chatStream: async function* (): AsyncIterable<ChatStreamEvent> {
            for (const text of deltas) yield { type: "text-delta", text };
            if (!options.omitDone) yield { type: "done", message: final };
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
        const error = result._unsafeUnwrapErr();
        expect(error.type).toBe("provider");
        expect(error.message).toContain("ended without a final message");
    });
});
