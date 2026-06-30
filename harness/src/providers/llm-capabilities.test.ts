import { describe, expect, it } from "bun:test";

import { anthropicAcceptsTemperature, mapOpenAiFinishReason, maxOutputTokens } from "./llm-capabilities.js";

describe("anthropicAcceptsTemperature", () => {
    it("accepts on 4.6 and earlier, rejects on 4.7+", () => {
        expect(anthropicAcceptsTemperature("claude-sonnet-4-6")).toBe(true);
        expect(anthropicAcceptsTemperature("claude-opus-4-6")).toBe(true);
        expect(anthropicAcceptsTemperature("claude-opus-4-7")).toBe(false);
        expect(anthropicAcceptsTemperature("claude-haiku-4-5")).toBe(true);
    });
});

describe("maxOutputTokens", () => {
    it("returns the true per-model ceiling for the models in use", () => {
        expect(maxOutputTokens("claude-opus-4-7")).toBe(128_000);
        expect(maxOutputTokens("claude-opus-4-8")).toBe(128_000);
        expect(maxOutputTokens("claude-sonnet-4-6")).toBe(64_000);
        expect(maxOutputTokens("claude-haiku-4-5")).toBe(64_000);
    });

    it("is case-insensitive on the bare model name", () => {
        expect(maxOutputTokens("CLAUDE-OPUS-4-7")).toBe(128_000);
    });

    it("falls back to a generous default for unknown models", () => {
        expect(maxOutputTokens("some-future-model")).toBe(32_768);
        expect(maxOutputTokens("gpt-9-ultra")).toBe(32_768);
    });
});

describe("mapOpenAiFinishReason", () => {
    it("maps OpenAI finish reasons into Anthropic stop_reason", () => {
        expect(mapOpenAiFinishReason("length")).toBe("max_tokens");
        expect(mapOpenAiFinishReason("tool_calls")).toBe("tool_use");
        expect(mapOpenAiFinishReason("stop")).toBe("end_turn");
        expect(mapOpenAiFinishReason("content_filter")).toBe("refusal");
    });

    it("defaults unknown or null reasons to end_turn", () => {
        expect(mapOpenAiFinishReason(null)).toBe("end_turn");
        expect(mapOpenAiFinishReason("function_call")).toBe("end_turn");
    });
});
