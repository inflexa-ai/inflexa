import { describe, expect, it } from "bun:test";

import { createConfiguredAiSdkProvider } from "@inflexa-ai/harness";
import type { AiSdkProviderConfig, ChatRequest, ConfiguredAiSdkProviderDeps } from "@inflexa-ai/harness";

import { makeSession } from "./__fixtures__/session.js";
import type { FetchLike } from "./types.js";

function anthropicJson(text: string, model: string): Response {
    return new Response(
        JSON.stringify({
            id: "msg_test_1",
            type: "message",
            role: "assistant",
            model,
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

function openaiJson(text: string, model: string): Response {
    return new Response(
        JSON.stringify({
            id: "chatcmpl_test_1",
            object: "chat.completion",
            created: 1_700_000_000,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

/**
 * Records each outbound request body so a test can assert on the wire model the
 * provider bound at construction (the request itself carries no model field),
 * and replies with a response echoing that body's `model`.
 */
function capturingFetch(respond: (text: string, model: string) => Response): { fetch: FetchLike; bodies: Array<{ model?: string }> } {
    const bodies: Array<{ model?: string }> = [];
    const fetch: FetchLike = async (_input, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
        bodies.push(body);
        return respond("Hello, world", body.model ?? "");
    };
    return { fetch, bodies };
}

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "Say hello." }],
    tools: {},
};

describe("provider configuration front door", () => {
    it("constructs a working anthropic ChatProvider from the package root", async () => {
        const cap = capturingFetch(anthropicJson);
        const config: AiSdkProviderConfig = {
            kind: "anthropic",
            baseURL: "http://models.local/anthropic",
            apiKey: "test-key",
            model: "claude-opus-4-7",
            fetch: cap.fetch,
        };
        const deps: ConfiguredAiSdkProviderDeps = { config, resolveBilling: async () => ({}) };
        const provider = createConfiguredAiSdkProvider(deps);

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toMatchObject({
            finishReason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
        });
        expect(provider.capabilities.toolCalling).toBe(true);
    });

    it("constructs a working openai-compatible ChatProvider from the package root", async () => {
        const cap = capturingFetch(openaiJson);
        const config: AiSdkProviderConfig = {
            kind: "openai-compatible",
            name: "self-hosted",
            baseURL: "http://models.local/v1",
            apiKey: "test-key",
            model: "local-tool-model",
            fetch: cap.fetch,
        };
        const provider = createConfiguredAiSdkProvider({ config, resolveBilling: async () => ({}) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toMatchObject({
            finishReason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
        });
        expect(provider.capabilities.toolCalling).toBe(true);
    });

    it("builds two provider instances over one connection, each carrying its own bound model", async () => {
        const cap = capturingFetch(openaiJson);
        const connection = {
            kind: "openai-compatible" as const,
            name: "shared-endpoint",
            baseURL: "http://models.local/v1",
            apiKey: "shared-key",
            fetch: cap.fetch,
        };
        const conversationProvider = createConfiguredAiSdkProvider({ config: { ...connection, model: "model-a" }, resolveBilling: async () => ({}) });
        const sandboxProvider = createConfiguredAiSdkProvider({ config: { ...connection, model: "model-b" }, resolveBilling: async () => ({}) });

        const first = await conversationProvider.chat(request, makeSession());
        const second = await sandboxProvider.chat(request, makeSession());

        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        // Same shared connection config; each provider instance's request carries the
        // model it was constructed with — no per-request model.
        expect(cap.bodies.map((body) => body.model)).toEqual(["model-a", "model-b"]);
    });
});
