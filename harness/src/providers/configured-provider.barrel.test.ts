import { describe, expect, it } from "bun:test";

import { createConfiguredAiSdkProvider, DEFAULT_MAX_OUTPUT_TOKENS } from "@inflexa-ai/harness";
import type { AiSdkProviderConfig, ChatRequest, ConfiguredAiSdkProviderDeps } from "@inflexa-ai/harness";

import { makeSession } from "./__fixtures__/session.js";
import type { FetchLike } from "./types.js";

/** One `text/event-stream` body: each arm of the provider reads the wire as SSE. */
function sse(events: readonly string[]): Response {
    return new Response(events.map((event) => `${event}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

function anthropicSse(text: string, model: string): Response {
    const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    return sse([
        `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { id: "msg_test_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
        })}`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ]);
}

function openaiSse(text: string, model: string): Response {
    const base = { id: "chatcmpl_test_1", object: "chat.completion.chunk", created: 1_700_000_000, model };
    return sse([
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        })}`,
        "data: [DONE]",
    ]);
}

function responsesSse(text: string, model: string): Response {
    const item = { type: "message", id: "msg_test_1", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    const response = { id: "resp_test_1", created_at: 1_700_000_000, model, usage: { input_tokens: 12, output_tokens: 3 } };
    return sse([
        `data: ${JSON.stringify({ type: "response.created", response: { ...response, output: [] } })}`,
        `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } })}`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_test_1", output_index: 0, content_index: 0, delta: text })}`,
        `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_test_1", output_index: 0, content_index: 0, text })}`,
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}`,
        `data: ${JSON.stringify({ type: "response.completed", response: { ...response, output: [item] } })}`,
    ]);
}

/** One outbound request as it reached the wire: the whole JSON body, and the headers with lowercase names. */
interface CapturedRequest {
    readonly body: Record<string, unknown>;
    readonly headers: Record<string, string>;
}

/**
 * Records each outbound request, its whole body and its headers, so a test can
 * assert on what reached the wire, for example the model that the provider
 * bound at construction (the request itself carries no model field). The reply
 * echoes the `model` of the body.
 */
function capturingFetch(respond: (text: string, model: string) => Response): { fetch: FetchLike; requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = [];
    const fetch: FetchLike = async (_input, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        // `Headers` folds each name to lowercase, thus an assertion does not
        // depend on the spelling that the SDK forwards.
        const headers = Object.fromEntries(new Headers(init?.headers));
        requests.push({ body, headers });
        return respond("Hello, world", typeof body["model"] === "string" ? body["model"] : "");
    };
    return { fetch, requests };
}

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "Say hello." }],
    tools: {},
};

describe("provider configuration front door", () => {
    it("constructs a working anthropic ChatProvider from the package root", async () => {
        const cap = capturingFetch(anthropicSse);
        const config: AiSdkProviderConfig = {
            kind: "anthropic",
            baseURL: "http://models.local/anthropic",
            apiKey: "test-key",
            model: "claude-opus-4-7",
            fetch: cap.fetch,
        };
        const deps: ConfiguredAiSdkProviderDeps = { config };
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
        const cap = capturingFetch(openaiSse);
        const config: AiSdkProviderConfig = {
            kind: "openai-compatible",
            name: "self-hosted",
            baseURL: "http://models.local/v1",
            apiKey: "test-key",
            model: "local-tool-model",
            fetch: cap.fetch,
        };
        const provider = createConfiguredAiSdkProvider({ config });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toMatchObject({
            finishReason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
        });
        expect(provider.capabilities.toolCalling).toBe(true);
    });

    it("constructs a working openai ChatProvider from the package root", async () => {
        const cap = capturingFetch(responsesSse);
        const config: AiSdkProviderConfig = {
            kind: "openai",
            apiKey: "test-key",
            model: "gpt-5.1",
            fetch: cap.fetch,
        };
        const deps: ConfiguredAiSdkProviderDeps = { config };
        const provider = createConfiguredAiSdkProvider(deps);

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toMatchObject({
            finishReason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
        });
        expect(provider.capabilities.toolCalling).toBe(true);
    });

    it("builds two provider instances over one connection, each carrying its own bound model", async () => {
        const cap = capturingFetch(openaiSse);
        const connection = {
            kind: "openai-compatible" as const,
            name: "shared-endpoint",
            baseURL: "http://models.local/v1",
            apiKey: "shared-key",
            fetch: cap.fetch,
        };
        const conversationProvider = createConfiguredAiSdkProvider({ config: { ...connection, model: "model-a" } });
        const sandboxProvider = createConfiguredAiSdkProvider({ config: { ...connection, model: "model-b" } });

        const first = await conversationProvider.chat(request, makeSession());
        const second = await sandboxProvider.chat(request, makeSession());

        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        // Same shared connection config; each provider instance's request carries the
        // model it was constructed with — no per-request model.
        expect(cap.requests.map((captured) => captured.body["model"])).toEqual(["model-a", "model-b"]);
    });
});

describe("the reasoning effort of the configuration", () => {
    it("sends the configured effort of an anthropic arm on the wire", async () => {
        const cap = capturingFetch(anthropicSse);
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "anthropic",
                baseURL: "http://models.local/anthropic",
                apiKey: "test-key",
                model: "claude-opus-5-5",
                fetch: cap.fetch,
                reasoning: "high",
            },
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        // The request sets no reasoning, thus the configured value applies, and
        // the package maps it onto the effort of the model.
        expect(cap.requests[0]?.body["output_config"]).toMatchObject({ effort: "high" });
    });
});

describe("output-token ceiling", () => {
    /** Run one chat over a capturing fetch and report the `max_tokens` that reached the wire. */
    async function wireMaxTokens(
        respond: (text: string, model: string) => Response,
        build: (fetch: FetchLike) => AiSdkProviderConfig,
    ): Promise<number | undefined> {
        const cap = capturingFetch(respond);
        const provider = createConfiguredAiSdkProvider({ config: build(cap.fetch) });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        return cap.requests[0]?.body["max_tokens"] as number | undefined;
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
        expect(await wireMaxTokens(anthropicSse, anthropicModel("claude-opus-99-future"))).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it("lets the SDK clamp the default down to a known model's real limit", async () => {
        // What makes a high default safe: it never reaches a model the SDK knows
        // to have a smaller ceiling.
        expect(await wireMaxTokens(anthropicSse, anthropicModel("claude-opus-4-1"))).toBe(32_000);
    });

    it("recognizes claude-opus-5, clamping an over-large ceiling to its real limit", async () => {
        // Guards the dependency floor: before @ai-sdk/anthropic 4.0.20 this id was
        // unknown, so it took the 4096 fallback and skipped the clamp — 200000 would
        // ride out verbatim instead of landing on the model's real 128k.
        expect(await wireMaxTokens(anthropicSse, anthropicModel("claude-opus-5", 200_000))).toBe(128_000);
    });

    it("honours a per-config override on the openai-compatible arm", async () => {
        // The escape hatch for servers that validate prompt + max_tokens against a
        // small context window.
        expect(
            await wireMaxTokens(openaiSse, (fetch) => ({
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
