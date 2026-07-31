import { describe, expect, it } from "bun:test";

import { createConfiguredAiSdkProvider, DEFAULT_MAX_OUTPUT_TOKENS } from "@inflexa-ai/harness";
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
function capturingFetch(respond: (text: string, model: string) => Response): { fetch: FetchLike; bodies: Array<{ model?: string; max_tokens?: number }> } {
    const bodies: Array<{ model?: string; max_tokens?: number }> = [];
    const fetch: FetchLike = async (_input, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string; max_tokens?: number }) : {};
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

describe("output-token ceiling", () => {
    /** Run one chat over a capturing fetch and report the `max_tokens` that reached the wire. */
    async function wireMaxTokens(
        respond: (text: string, model: string) => Response,
        build: (fetch: FetchLike) => AiSdkProviderConfig,
    ): Promise<number | undefined> {
        const cap = capturingFetch(respond);
        const provider = createConfiguredAiSdkProvider({ config: build(cap.fetch), resolveBilling: async () => ({}) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        return cap.bodies[0]?.max_tokens;
    }

    const anthropicModel =
        (model: string, maxOutputTokens?: number) =>
        (fetch: FetchLike): AiSdkProviderConfig => ({
            kind: "anthropic",
            baseURL: "http://models.local/anthropic",
            apiKey: "test-key",
            model,
            fetch,
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        });

    it("sends the default ceiling for a model the SDK's capability table does not know", async () => {
        // The regression: an unrecognized id takes the SDK's 4096 fallback when
        // nothing names a ceiling, truncating plan-sized tool calls mid-payload.
        expect(await wireMaxTokens(anthropicJson, anthropicModel("claude-opus-99-future"))).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it("lets the SDK clamp the default down to a known model's real limit", async () => {
        // What makes a high default safe: it never reaches a model the SDK knows
        // to have a smaller ceiling.
        expect(await wireMaxTokens(anthropicJson, anthropicModel("claude-opus-4-1"))).toBe(32_000);
    });

    it("recognizes claude-opus-5, clamping an over-large ceiling to its real limit", async () => {
        // Guards the dependency floor: before @ai-sdk/anthropic 4.0.20 this id was
        // unknown, so it took the 4096 fallback and skipped the clamp — 200000 would
        // ride out verbatim instead of landing on the model's real 128k.
        expect(await wireMaxTokens(anthropicJson, anthropicModel("claude-opus-5", 200_000))).toBe(128_000);
    });

    it("honours a per-config override on the openai-compatible arm", async () => {
        // The escape hatch for servers that validate prompt + max_tokens against a
        // small context window.
        expect(
            await wireMaxTokens(openaiJson, (fetch) => ({
                kind: "openai-compatible",
                name: "self-hosted",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: "local-tool-model",
                fetch,
                maxOutputTokens: 8_192,
            })),
        ).toBe(8_192);
    });
});
