/**
 * Integration test — prompt caching for tool-bearing requests via the billing gateway.
 *
 * Verifies that `cache_control` markers actually hit the cache on
 * tool-bearing calls (the Claude Max OAuth path disables caching, so this
 * must run against a real key). The agent loop relies on caching to keep
 * replayed in-flight LLM steps cheap, so the marker convention is verified
 * against a real key via the billing gateway.
 *
 * Gated on `ANTHROPIC_API_KEY`; skipped otherwise. Set `ANTHROPIC_BASE_URL`
 * to the billing gateway endpoint (defaults to the local `just up` billing gateway).
 */

import { describe, expect, it } from "bun:test";

import { createAnthropicProvider } from "../anthropic.js";
import { makeSession } from "../__fixtures__/session.js";
import type { ChatRequest } from "../types.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:8181/anthropic";

// A system prompt comfortably above the largest per-model cache minimum
// (Haiku requires ~2048 tokens). Padded so caching reliably engages.
const LARGE_SYSTEM = Array.from(
    { length: 240 },
    (_, i) =>
        `Cortex is a long-running multi-tenant bioinformatics agent platform; ` +
        `directive ${i} is operational filler used solely to exceed the prompt ` +
        `cache minimum token threshold for this integration check.`,
).join(" ");

const CACHED_REQUEST: ChatRequest = {
    system: [
        {
            type: "text",
            text: LARGE_SYSTEM,
            cache_control: { type: "ephemeral" },
        },
    ],
    tools: [
        {
            name: "noop",
            description: "A placeholder tool that does nothing.",
            input_schema: {
                type: "object",
                properties: { value: { type: "string" } },
            },
            cache_control: { type: "ephemeral" },
        },
    ],
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
};

describe.skipIf(!API_KEY)("Anthropic prompt caching via the billing gateway", () => {
    it("creates a cache entry then reads it back on a repeat call", async () => {
        const provider = createAnthropicProvider({
            baseURL: BASE_URL,
            token: API_KEY!,
            model: process.env.ANTHROPIC_TEST_MODEL ?? "claude-haiku-4-5-20251001",
            resolveBilling: async () => ({}),
        });
        const session = makeSession();

        const first = (await provider.chat(CACHED_REQUEST, session))._unsafeUnwrap();
        expect(first.usage.cache_creation_input_tokens ?? 0).toBeGreaterThan(0);

        const second = (await provider.chat(CACHED_REQUEST, session))._unsafeUnwrap();
        expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
    }, 60_000);
});
