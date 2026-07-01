/**
 * Per-model capability gates for harness provider calls.
 *
 * The harness `ChatRequest` is a passthrough of `MessageCreateParamsBase`,
 * so callers already pass per-call overrides (`temperature`, `thinking`,
 * tool config, …) as native fields. This module is the silent drop-on-reject
 * gate at the provider edge: model-rejected fields are stripped before they
 * hit the wire so the call still succeeds (e.g. `acceptsTemperature`).
 *
 * Classification is pattern-based on the bare model name (no provider
 * prefix — the harness `createAnthropicProvider` already knows it is
 * Anthropic). No network calls, no runtime probing.
 */

import type { Message } from "./types.js";

/**
 * Anthropic Opus/Sonnet/Haiku 4.7+ reject `temperature` with HTTP 400.
 * 4.6 and earlier accept it.
 */
export function anthropicAcceptsTemperature(modelName: string): boolean {
    return !/^claude-(opus|sonnet|haiku)-4-([7-9]|\d{2,})\b/.test(modelName.toLowerCase());
}

/**
 * The model's true maximum output-token ceiling — the `max_tokens` the
 * Anthropic provider sets per call (the API requires the field). Pattern-
 * matched on the bare model name (no provider prefix). Ceilings per the
 * current Anthropic model reference: Opus 4.x → 128K, Sonnet 4.6 → 64K,
 * Haiku 4.5 → 64K.
 */
export function maxOutputTokens(modelName: string): number {
    const name = modelName.toLowerCase();
    if (/^claude-opus-4-/.test(name)) return 128_000;
    if (/^claude-sonnet-4-/.test(name)) return 64_000;
    if (/^claude-haiku-4-/.test(name)) return 64_000;
    // Unknown model — a generous default broadly accepted by current models;
    // the loop recovers from truncation, so erring high is cheap.
    return 32_768;
}

/**
 * Map an OpenAI `finish_reason` into the Anthropic `stop_reason` the harness
 * loop branches on (see the harness-providers spec — every provider adapts into Anthropic shape).
 * The imminent `openai.ts` adapter is the first caller.
 */
export function mapOpenAiFinishReason(finishReason: string | null): Message["stop_reason"] {
    switch (finishReason) {
        case "length":
            return "max_tokens";
        case "tool_calls":
            return "tool_use";
        case "stop":
            return "end_turn";
        case "content_filter":
            return "refusal";
        default:
            return "end_turn";
    }
}
