/**
 * Integration test — Anthropic prompt caching through the real provider seam.
 *
 * Proves the whole chain end to end against a live endpoint: the harness's
 * neutral `PromptCachePolicy` → the `anthropic.cacheControl` marker on the last
 * message → a served cache read → `ChatResponse.usage.cacheReadInputTokens`. If
 * any link breaks, the second identical request reports a zero cache read.
 *
 * ## Why this is gated on a direct API key — read this first
 *
 * A direct API key or a gateway is the only endpoint where a cache read proves
 * that OUR breakpoint works. The OSS CLI routes through a local CLIProxyAPI on
 * the Claude OAuth path, and that proxy places breakpoints of its own while it
 * cloaks the request. Caching does engage there — but it engages with
 * `promptCache: "off"` too, so a read there attributes nothing.
 *
 * Hence the `ANTHROPIC_API_KEY` gate rather than whatever the CLI happens to be
 * wired to. Nothing injects markers on this path, so a served read is the
 * placement in this module working, end to end.
 *
 * At runtime the same distinction applies to
 * `cortex.harness.agent.cache_read_tokens`: against a direct endpoint a
 * flat-zero read counter beside a non-zero write counter is the signature of an
 * endpoint billing for cache writes and serving no reads.
 *
 * Gated on `ANTHROPIC_API_KEY`; skipped otherwise. `ANTHROPIC_BASE_URL`
 * optionally points at a gateway instead of the public API.
 */

import { describe, expect, it } from "bun:test";
import { jsonSchema, tool as aiTool } from "ai";

import { makeSession } from "../__fixtures__/session.js";
import { createConfiguredAiSdkProvider } from "../ai-sdk.js";
import { DEFAULT_PROMPT_CACHE, withPromptCacheBreakpoint } from "../prompt-cache.js";
import type { ChatRequest } from "../types.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL;
const MODEL = process.env.ANTHROPIC_TEST_MODEL ?? "claude-haiku-4-5-20251001";

// The cache has a per-model minimum prefix length (Haiku needs ~2048 tokens);
// below it the API silently declines to cache. Padded well clear of that floor.
const LARGE_SYSTEM = Array.from(
    { length: 240 },
    (_, i) =>
        `Cortex is a long-running multi-tenant bioinformatics agent platform; ` +
        `directive ${i} is operational filler used solely to exceed the prompt ` +
        `cache minimum token threshold for this integration check.`,
).join(" ");

/**
 * The request the loop builds: a `system` string, an AI SDK `ToolSet`, and the
 * cache breakpoint placed on the LAST MESSAGE, exactly as `runAgent` places it.
 * One breakpoint at the end of the messages caches the whole prefix, because the
 * cache keys on a prefix and the render order is tools → system → messages.
 *
 * The placement is the part under test as much as the caching is: the marker has
 * to be a per-block one that an intermediary can count, never the request-level
 * directive that reaches the wire as a top-level `cache_control` field.
 *
 * Byte-identical across both calls — that is the whole point: the prefix must
 * not shift or nothing is read back.
 */
const CACHED_REQUEST: ChatRequest = {
    system: LARGE_SYSTEM,
    // Built exactly as `runAgent` builds its `toolDefs`.
    tools: {
        noop: aiTool({
            description: "A placeholder tool that does nothing.",
            inputSchema: jsonSchema({
                type: "object",
                properties: { value: { type: "string" } },
            }),
        }),
    },
    messages: withPromptCacheBreakpoint([{ role: "user", content: "Reply with the single word: ok" }], DEFAULT_PROMPT_CACHE),
};

describe.skipIf(!API_KEY)("Anthropic prompt caching", () => {
    it("creates a cache entry, then reads it back on an identical repeat call", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "anthropic",
                baseURL: BASE_URL,
                apiKey: API_KEY!,
                model: MODEL,
            },
            resolveBilling: async () => ({}),
        });
        const session = makeSession();

        const first = (await provider.chat(CACHED_REQUEST, session))._unsafeUnwrap();
        // The first call seeds the cache. (A warm cache from a previous run of
        // this test would instead read it straight back, so accept either.)
        const seeded = (first.usage?.cacheCreationInputTokens ?? 0) + (first.usage?.cacheReadInputTokens ?? 0);
        expect(seeded).toBeGreaterThan(0);

        const second = (await provider.chat(CACHED_REQUEST, session))._unsafeUnwrap();
        expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0);
    }, 60_000);
});
