import { describe, expect, it } from "bun:test";

import { makeSession } from "../../providers/__fixtures__/session.js";
import type { ChatRequest, ChatStreamEvent } from "../../providers/types.js";
import { createStreamingChat } from "../../providers/streaming-chat.js";
import { makeMessage, scriptedProvider, textBlock, thinkingBlock, toolUseBlock } from "./scripted-provider.js";

const REQUEST: ChatRequest = { system: "s", messages: [{ role: "user", content: "go" }], tools: {} };

async function drain(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
    const seen: ChatStreamEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
}

describe("scriptedProvider.chatStream", () => {
    it("streams one delta per text block, then the scripted reply as `done`", async () => {
        const reply = makeMessage([textBlock("hello "), textBlock("world")], "end_turn");
        const provider = scriptedProvider([reply]);

        const events = await drain(provider.chatStream(REQUEST, makeSession()));

        expect(events).toEqual([
            { type: "text-delta", text: "hello " },
            { type: "text-delta", text: "world" },
            { type: "done", response: reply },
        ]);
    });

    it("carries reasoning and tool calls only on the terminal response", async () => {
        const reply = makeMessage(
            [thinkingBlock("pondering", "sig-1"), textBlock("calling"), toolUseBlock("call-1", "read_file", { path: "a.txt" })],
            "tool_use",
        );
        const provider = scriptedProvider([reply]);

        const events = await drain(provider.chatStream(REQUEST, makeSession()));

        expect(events.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", text: "calling" }]);
        expect(events.at(-1)).toEqual({ type: "done", response: reply });
    });

    it("advances the script and records the session, as `chat` does", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("first")], "end_turn"), makeMessage([textBlock("second")], "end_turn")]);
        const session = makeSession({ user: "user-stream" });

        await drain(provider.chatStream(REQUEST, session));
        const second = await drain(provider.chatStream(REQUEST, session));

        expect(second).toContainEqual({ type: "text-delta", text: "second" });
        expect(provider.calls).toHaveLength(2);
        expect(provider.sessions.map((s) => s.identity.user)).toEqual(["user-stream", "user-stream"]);
    });

    it("drives `createStreamingChat` to the same collapsed response", async () => {
        const reply = makeMessage([textBlock("par"), textBlock("tial")], "end_turn");
        const forwarded: string[] = [];
        const chat = createStreamingChat(scriptedProvider([reply]), (text) => forwarded.push(text));

        const result = await chat.chat(REQUEST, makeSession());

        expect(forwarded).toEqual(["par", "tial"]);
        expect(result._unsafeUnwrap()).toEqual(reply);
    });
});
