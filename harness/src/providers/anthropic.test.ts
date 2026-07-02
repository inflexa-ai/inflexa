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

function capturingFetch(): { fetch: FetchLike; bodies: unknown[]; headers: Headers[] } {
    const bodies: unknown[] = [];
    const headers: Headers[] = [];
    const fetch: FetchLike = async (_input, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        headers.push(new Headers(init?.headers));
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
            { type: "text-delta", text: "Hello, world" },
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
