/**
 * Integration test — Anthropic prompt caching through the real provider seam.
 *
 * Proves the whole chain end to end against a live endpoint: the harness's
 * neutral `PromptCachePolicy` → the `anthropic.cacheControl` wire option →
 * a served cache read → `ChatResponse.usage.cacheReadInputTokens`. If any link
 * breaks, the second identical request reports a zero cache read.
 *
 * ## Caching is a NO-OP on the Claude Max OAuth path — read this first
 *
 * The Claude Max OAuth path does not honour cache directives, and the OSS CLI
 * defaults to routing through a local CLIProxyAPI on exactly that path. Caching
 * therefore engages only against a **direct API key or a gateway** — which is
 * what this test uses, and why it is gated on a real `ANTHROPIC_API_KEY` rather
 * than on whatever the CLI happens to be wired to.
 *
 * This is not a footnote: it is the single most likely reason a deployment sees
 * no cache benefit, and it is precisely what the new
 * `cortex.harness.agent.cache_read_tokens` metric exposes at runtime — a
 * flat-zero read counter beside a non-zero write counter is the signature of an
 * endpoint that is billing for cache writes and serving no reads.
 *
 * Gated on `ANTHROPIC_API_KEY`; skipped otherwise. `ANTHROPIC_BASE_URL`
 * optionally points at a gateway instead of the public API.
 */

import { describe, expect, it } from "bun:test";
import { jsonSchema, tool as aiTool } from "ai";

import { makeSession } from "../__fixtures__/session.js";
import { createConfiguredAiSdkProvider } from "../ai-sdk.js";
import { DEFAULT_PROMPT_CACHE, promptCacheProviderOptions } from "../prompt-cache.js";
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
 * cache directive as request-level `providerOptions`. The provider emits a
 * single top-level `cache_control` from it and the server places the breakpoint
 * on the last cacheable block, so tools + system are cached without the harness
 * hand-marking blocks.
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
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    providerOptions: promptCacheProviderOptions(DEFAULT_PROMPT_CACHE),
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
