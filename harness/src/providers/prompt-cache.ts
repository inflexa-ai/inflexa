/**
 * Prompt-cache policy → provider wire options.
 *
 * This is the **only** place in the harness that names a vendor for caching.
 * Everything upstream — `PromptCachePolicy`, `ChatUsage`, `RunAgentOptions` —
 * speaks the neutral harness concept; this module translates it once, at the
 * provider seam, so the loop never learns which vendor it is talking to.
 *
 * ## Why the emitted options are safe on every provider
 *
 * The AI SDK's `providerOptions` is a namespaced bag: each provider reads only
 * `providerOptions[<its own name>]` and ignores every other key
 * (`parseProviderOptions` in `@ai-sdk/provider-utils` returns `undefined` when
 * its namespace is absent). So the `anthropic` namespace is inert — not an
 * error — on an OpenAI-compatible model, which is exactly what we want: that
 * family does automatic server-side prefix caching and needs no directive.
 *
 * ## What the Anthropic namespace does
 *
 * A request-level `cacheControl` makes the provider emit a single top-level
 * `cache_control` marker; the server then places the breakpoint on the last
 * cacheable block, so the whole prefix (tools → system → history) is cached
 * without the harness hand-placing per-block markers.
 *
 * ## Cache defeaters — what silently kills the hit rate
 *
 * The cache keys on an *exact prefix*. Anything that perturbs the head of the
 * request invalidates everything after it. One known defeater remains in this
 * codebase, flagged at its own site as a separate change:
 *
 *  1. `runAgent`'s forced wrap-up swaps the tool set to `{}` — tools sit at the
 *     very front of the prefix, so that one call reads nothing back and rewrites
 *     the cache from scratch (`loop/run-agent.ts`).
 *
 * `loadRecent`'s history eviction used to be a second defeater — it advanced the
 * window one turn per turn, shifting the message prefix every request. It now
 * evicts in whole blocks so the prefix holds still between block boundaries
 * (`memory/thread-history.ts`).
 *
 * A sandbox agent's system prompt is NOT one of them: it is a pure function of
 * its agent type, byte-identical across every step of every run, and the per-step
 * paths ride in the step's briefing instead (`agents/sandbox/shared.ts`,
 * `prompts/briefing.ts`). Keep it that way — one interpolated id or path there
 * makes every step's ~20k-char prefix unique.
 *
 * ## Where caching is a no-op regardless
 *
 * The Claude Max OAuth path does not honour cache directives, and the OSS CLI
 * defaults to routing through a local CLIProxyAPI on exactly that path. Caching
 * only engages against a direct API key or a gateway. The cache-token metrics
 * (`loop/metrics.ts`) are what tell the two apart at runtime — a flat-zero
 * `cache_read_tokens` counter is the symptom.
 */

import type { PromptCachePolicy, ProviderOptions } from "./types.js";

/**
 * The default policy: cache with the 5-minute TTL.
 *
 * A cache write costs a premium over a plain input token and only pays for
 * itself once something reads it back, so caching is worth it exactly when a
 * shared prefix is re-sent within the TTL. An agent loop always re-sends: every
 * iteration replays the same tools + system + the whole transcript so far, and
 * even a two-iteration run breaks even. The 5m TTL covers a live loop; `1h` is
 * for hosts that also want the *next* turn on a thread to land warm, and costs
 * more per write. One-shot LLM calls should stay `"off"` — they pay the write
 * premium for a cache nothing ever reads.
 */
export const DEFAULT_PROMPT_CACHE: PromptCachePolicy = { ttl: "5m" };

/**
 * Translate a neutral cache policy into provider wire options.
 *
 * Returns `undefined` for `"off"` so the caller can leave `providerOptions`
 * entirely unset rather than sending an empty bag.
 */
export function promptCacheProviderOptions(policy: PromptCachePolicy): ProviderOptions | undefined {
    if (policy === "off") return undefined;
    return { anthropic: { cacheControl: { type: "ephemeral", ttl: policy.ttl } } };
}
