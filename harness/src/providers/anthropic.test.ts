import { describe, expect, it } from "bun:test";

import { makeSession } from "./__fixtures__/session.js";
import { createAnthropicProvider } from "./anthropic.js";
import type { ChatRequest, FetchLike } from "./types.js";

function anthropicJson(text: string): Response {
    return new Response(
        JSON.stringify({
            id: "msg_test_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
                input_tokens: 12,
                output_tokens: 3,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

function anthropicStream(deltas: readonly string[]): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg_test_1",
                type: "message",
                role: "assistant",
                model: "claude-opus-4-7",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 12,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...deltas.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
    ];
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function capturingFetch(): { fetch: FetchLike; bodies: unknown[]; headers: Headers[] } {
    const bodies: unknown[] = [];
    const headers: Headers[] = [];
    const fetch: FetchLike = async (_input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        bodies.push(body);
        headers.push(new Headers(init?.headers));
        if (body?.stream === true) {
            return anthropicStream(["Hello, ", "world"]);
        }
        return anthropicJson("Hello, world");
    };
    return { fetch, bodies, headers };
}

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "Say hello." }],
    tools: {},
};

describe("createAnthropicProvider", () => {
    it("keeps the compatibility factory while returning AI SDK model messages", async () => {
        const cap = capturingFetch();
        const provider = createAnthropicProvider({
            baseURL: "http://billing.test/anthropic",
            token: "test-token",
            model: "claude-opus-4-7",
            resolveBilling: async () => ({ "X-Billing-Virtual-Key": "sk-billing-test" }),
            fetch: cap.fetch,
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toMatchObject({
            finishReason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
        });
        expect(provider.capabilities.toolCalling).toBe(true);
        expect(cap.headers[0]!.get("x-billing-virtual-key")).toBe("sk-billing-test");
    });

    it("chatStream emits text deltas followed by one done response", async () => {
        const cap = capturingFetch();
        const provider = createAnthropicProvider({
            baseURL: "http://billing.test/anthropic",
            token: "test-token",
            model: "claude-opus-4-7",
            resolveBilling: async () => ({}),
            fetch: cap.fetch,
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) {
            events.push(event);
        }

        expect(events).toEqual([
            { type: "text-delta", text: "Hello, " },
            { type: "text-delta", text: "world" },
            {
                type: "done",
                response: {
                    finishReason: "stop",
                    rawFinishReason: "end_turn",
                    message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
                },
            },
        ]);
    });
});
