import { describe, expect, it } from "bun:test";

import { createAnthropicProvider } from "./anthropic.js";
import { makeSession } from "./__fixtures__/session.js";
import type { ChatRequest, FetchLike, Message } from "./types.js";

/**
 * One Server-Sent-Events frame: `event:` + `data:` + blank-line terminator,
 * the wire shape the Anthropic SDK stream decoder consumes.
 */
function sseFrame(type: string, payload: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/**
 * A recorded Anthropic stream: a `thinking` block (carrying a signature)
 * followed by a two-chunk `text` block.
 */
const RECORDED_STREAM = [
    sseFrame("message_start", {
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
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        },
    }),
    sseFrame("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    sseFrame("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me reason through this." },
    }),
    sseFrame("content_block_delta", {
        index: 0,
        delta: { type: "signature_delta", signature: "SIG-test-abc-123" },
    }),
    sseFrame("content_block_stop", { index: 0 }),
    sseFrame("content_block_start", {
        index: 1,
        content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
        index: 1,
        delta: { type: "text_delta", text: "Hello" },
    }),
    sseFrame("content_block_delta", {
        index: 1,
        delta: { type: "text_delta", text: ", world" },
    }),
    sseFrame("content_block_stop", { index: 1 }),
    sseFrame("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 15 },
    }),
    sseFrame("message_stop", {}),
].join("");

/** A `fetch` that replays the recorded stream as a fresh SSE response per call. */
function fakeStreamFetch(): FetchLike {
    return async () =>
        new Response(RECORDED_STREAM, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
}

/** Capturing fake fetch — records every request body for assertion. */
function capturingFetch(): { fetch: FetchLike; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const fetch: FetchLike = async (_input, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(RECORDED_STREAM, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    };
    return { fetch, bodies };
}

const REQUEST: ChatRequest = {
    messages: [{ role: "user", content: "Say hello." }],
};

function provider() {
    return createAnthropicProvider({
        baseURL: "http://billing.test/anthropic",
        token: "test-token",
        model: "claude-opus-4-7",
        resolveBilling: async () => ({ "X-Billing-Virtual-Key": "sk-billing-test" }),
        fetch: fakeStreamFetch(),
    });
}

function providerOn(model: string, fetch: FetchLike): ReturnType<typeof createAnthropicProvider> {
    return createAnthropicProvider({
        baseURL: "http://billing.test/anthropic",
        token: "test-token",
        model,
        resolveBilling: async () => ({ "X-Billing-Virtual-Key": "sk-billing-test" }),
        fetch,
    });
}

describe("createAnthropicProvider.chatStream", () => {
    it("yields text-deltas then one terminal done event", async () => {
        const events = [];
        for await (const event of provider().chatStream(REQUEST, makeSession())) {
            events.push(event);
        }

        expect(events.slice(0, 2)).toEqual([
            { type: "text-delta", text: "Hello" },
            { type: "text-delta", text: ", world" },
        ]);
        expect(events).toHaveLength(3);
        expect(events[2]!.type).toBe("done");
    });

    it("carries an assembled Message with content blocks intact on done", async () => {
        let done: unknown;
        for await (const event of provider().chatStream(REQUEST, makeSession())) {
            if (event.type === "done") done = event.message;
        }

        const message = done as Message;
        expect(message.role).toBe("assistant");
        expect(message.stop_reason).toBe("end_turn");
        expect(message.content).toHaveLength(2);

        const thinking = message.content.find((b) => b.type === "thinking");
        expect(thinking).toBeDefined();
        // The signature survives the provider byte-for-byte (see the harness-providers spec).
        expect(thinking).toMatchObject({
            type: "thinking",
            thinking: "Let me reason through this.",
            signature: "SIG-test-abc-123",
        });

        const text = message.content.find((b) => b.type === "text");
        expect(text).toMatchObject({ type: "text", text: "Hello, world" });
    });
});

describe("createAnthropicProvider per-call overrides", () => {
    it("forwards temperature on a temperature-accepting model", async () => {
        const cap = capturingFetch();
        await providerOn("claude-opus-4-6", cap.fetch).chat({ ...REQUEST, temperature: 0 }, makeSession());
        expect((cap.bodies[0] as { temperature?: number }).temperature).toBe(0);
    });

    it("drops temperature on Opus 4.7+ but keeps other per-call fields", async () => {
        const cap = capturingFetch();
        await providerOn("claude-opus-4-7", cap.fetch).chat(
            {
                ...REQUEST,
                temperature: 0,
                thinking: { type: "disabled" },
            },
            makeSession(),
        );
        const body = cap.bodies[0] as Record<string, unknown>;
        expect(body.temperature).toBeUndefined();
        expect(body.thinking).toEqual({ type: "disabled" });
    });

    it("two concurrent calls with different per-call overrides do not bleed", async () => {
        const cap = capturingFetch();
        const p = providerOn("claude-opus-4-6", cap.fetch);
        await Promise.all([p.chat({ ...REQUEST, temperature: 0 }, makeSession()), p.chat({ ...REQUEST, temperature: 1 }, makeSession())]);
        // Subsequent call without an override sees no temperature at all.
        await p.chat(REQUEST, makeSession());
        const seen = (cap.bodies as Array<{ temperature?: number }>).map((b) => b.temperature);
        expect(seen).toContain(0);
        expect(seen).toContain(1);
        expect(seen).toContain(undefined);
    });

    it("succeeds when callers pass an unknown override field (forward-compat)", async () => {
        const cap = capturingFetch();
        // The harness has no allowlist — unknown fields pass through to the SDK,
        // which forwards to the billing gateway; the wire endpoint decides what to do with
        // them. The contract for callers is "your call does not throw."
        await providerOn("claude-opus-4-6", cap.fetch).chat(
            {
                ...REQUEST,
                // @ts-expect-error — unknown field is a forward-compat probe.
                future_knob: { foo: "bar" },
            },
            makeSession(),
        );
        expect(cap.bodies).toHaveLength(1);
    });
});

describe("createAnthropicProvider.chat", () => {
    it("returns the same assembled Message the stream produces", async () => {
        const message = (await provider().chat(REQUEST, makeSession()))._unsafeUnwrap();

        expect(message.role).toBe("assistant");
        expect(message.stop_reason).toBe("end_turn");
        expect(message.content).toHaveLength(2);

        const thinking = message.content.find((b) => b.type === "thinking");
        expect(thinking).toMatchObject({
            type: "thinking",
            thinking: "Let me reason through this.",
            signature: "SIG-test-abc-123",
        });

        const text = message.content.find((b) => b.type === "text");
        expect(text).toMatchObject({ type: "text", text: "Hello, world" });
    });

    it("collapses to a Message identical to the stream's done payload", async () => {
        const collapsed = (await provider().chat(REQUEST, makeSession()))._unsafeUnwrap();

        let streamed: unknown;
        for await (const event of provider().chatStream(REQUEST, makeSession())) {
            if (event.type === "done") streamed = event.message;
        }

        expect(collapsed.content).toEqual((streamed as typeof collapsed).content);
    });
});
