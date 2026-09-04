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
 * ## What the Anthropic namespace does, and where the marker must go
 *
 * The options go on the LAST MESSAGE of the request, never on the request
 * itself. Both placements cache the same bytes — one breakpoint at the end of
 * the messages covers the whole prefix (tools → system → history), because the
 * cache keys on a prefix — but only the message placement survives an
 * intermediary.
 *
 * A REQUEST-level `cacheControl` makes the provider emit a top-level
 * `cache_control` field instead of a per-block marker, and the server then
 * places the breakpoint itself. That is one fewer thing for the harness to get
 * right, and it is why this module used to do it. It is also invisible: an
 * intermediary that counts breakpoints to stay under Anthropic's cap of four
 * counts BLOCKS, so a top-level field is a breakpoint nothing on the way
 * upstream can see. CLIProxyAPI — what the OSS CLI routes through on the Claude
 * OAuth path — injects up to four block markers of its own and trims to four by
 * that blind count, so the harness's invisible fifth breakpoint made every
 * request past a thread's first turn fail with `A maximum of 4 blocks with
 * cache_control may be provided. Found 5.` (HTTP 400, non-retryable — the thread
 * is wedged, because the next turn rebuilds the same shape).
 *
 * A marker on a message block is counted, trimmed, and reasoned about by every
 * hop. Keep it there. {@link withPromptCacheBreakpoint} is the only writer.
 *
 * ## Which vendors need a marker at all
 *
 * Only two of them, and both take it on a message:
 *
 *  - **Anthropic** — `anthropic.cacheControl`. Fully opt-in: no marker, no
 *    caching, at full price.
 *  - **Amazon Bedrock** — `bedrock.cachePoint`. Also fully opt-in.
 *
 * The OpenAI family caches prefixes server-side, unprompted, and exposes no
 * breakpoint to place (`promptCacheKey` and `promptCacheRetention` are request
 * settings for affinity and retention, not placement — a separate concern from
 * this policy). Gemini caches implicitly by default, and its explicit mode is a
 * cache RESOURCE created out of band and referenced by name, which is not a
 * marker and does not fit a ttl policy.
 *
 * So both markers ride together on the one chosen message. A provider reads only
 * its own namespace, thus the pair is free to whichever vendor is not serving
 * the call, and the placement never learns which one that is.
 *
 * The asymmetry worth remembering: under-marking silently costs money, while
 * over-marking hard-fails. Anthropic answers 400 past four breakpoints, and the
 * legacy Bedrock integration answers 400 on a top-level `cache_control`. Every
 * failure in this area comes from asking for too much.
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
 * ## What the cache-token metrics do and do not prove
 *
 * Caching DOES engage on the Claude OAuth path the OSS CLI routes through a
 * local CLIProxyAPI: measured, 2050-2151 cache-read tokens on the turns after
 * the first. An earlier note here claimed that path ignores cache directives
 * outright. It does not.
 *
 * But a read there is not evidence that OUR breakpoint earned it. While cloaking
 * — which is what that path does — the proxy places breakpoints of its own on
 * the system block, the first user message, the system message it relocates, and
 * the last message. Those cache the prefix whatever the harness sends: with
 * `promptCache: "off"` and no marker of ours on the wire, a repeat request still
 * read 1902 tokens back.
 *
 * So on that path `cache_read_tokens` (`loop/metrics.ts`) reports whether the
 * deployment gets caching at all, which is what the counter is for. It does not
 * attribute the read, and it cannot tell a working harness breakpoint from a
 * proxy that is quietly doing the work. Against a direct API key or a gateway,
 * where nothing injects markers, the counter does mean exactly that — and a
 * flat-zero read counter beside a non-zero write counter is still the signature
 * of an endpoint billing for writes and serving no reads.
 */

import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";

import type { ModelMessage, PromptCachePolicy, ProviderOptions } from "./types.js";

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
 * Amazon Bedrock's cache marker, from the Converse API's `CachePointBlock`:
 * `type` is required and its only valid value is `default`; `ttl` is optional
 * and accepts exactly `5m` or `1h`, the same pair `PromptCachePolicy` offers.
 *
 * Declared here rather than imported because `@ai-sdk/amazon-bedrock` exports no
 * type for it — `BedrockProviderOptions` covers the request-level options only,
 * and the provider passes a `cachePoint` value through to AWS verbatim. Thus a
 * wrong shape here reaches the wire unchecked, and this declaration is the only
 * guard. Refer to the CachePointBlock page of the Bedrock API reference.
 */
interface BedrockCacheOptions {
    readonly cachePoint: { readonly type: "default"; readonly ttl?: "5m" | "1h" };
}

/**
 * Translate a neutral cache policy into provider wire options.
 *
 * Returns `undefined` for `"off"` so the caller can leave the bag entirely unset
 * rather than sending an empty one.
 *
 * Both vendors that take an explicit marker get one, in their own namespace. A
 * provider reads only its own key, so the pair costs nothing to whichever one is
 * not serving the call, and the placement needs no idea which vendor it is
 * talking to. The two shapes differ in more than spelling: Anthropic marks the
 * last content block of the message, while Bedrock appends a `cachePoint` block
 * after it. Both end up at the same position in the prefix.
 *
 * The `satisfies` clauses are the point of naming the vendor types at all. This
 * bag is a `Record<string, JSONObject>`, thus nothing here is checked by
 * default, and a renamed key would compile and silently stop caching —
 * `cacheControl` has already been renamed once, and the provider still accepts
 * `cache_control` as its alias.
 *
 * CAUTION: this is the marker's VALUE, not its placement. Attaching it to a
 * `ChatRequest` emits the invisible top-level field the module header warns
 * about. Place it with {@link withPromptCacheBreakpoint}.
 */
export function promptCacheProviderOptions(policy: PromptCachePolicy): ProviderOptions | undefined {
    if (policy === "off") return undefined;
    const anthropic = { cacheControl: { type: "ephemeral", ttl: policy.ttl } } satisfies AnthropicProviderOptions;
    const bedrock = { cachePoint: { type: "default", ttl: policy.ttl } } satisfies BedrockCacheOptions;
    return { anthropic, bedrock };
}

/**
 * Every namespace that can carry a breakpoint, and the key it carries it under.
 *
 * The writer and the stripper both read this list, thus they cannot drift apart,
 * and the one-breakpoint invariant covers each vendor rather than only the one
 * that happens to be serving the call. `@ai-sdk/amazon-bedrock` reads either
 * `bedrock` or `amazonBedrock`; its own documentation uses `bedrock`.
 */
const BREAKPOINT_SITES: readonly (readonly [namespace: string, key: string])[] = [
    ["anthropic", "cacheControl"],
    ["bedrock", "cachePoint"],
];

/**
 * Whether a message can HOST the breakpoint — that is, whether the marker put on
 * it actually reaches the wire.
 *
 * The Anthropic provider resolves a message-level marker onto the message's last
 * content part. A thinking block cannot carry `cache_control`, so a marker on an
 * assistant message that ends in one is dropped by the provider: no error, no
 * breakpoint, and a silent cache miss on every call after it. Walking back past
 * such a message is what the server-side placement did for us before, so this
 * keeps the behaviour rather than introducing a new failure mode.
 *
 * An empty content array hosts nothing either — there is no last part to mark.
 * The content is read as `unknown` because the four message roles carry four
 * different part unions and this predicate cares about exactly one field.
 */
function canHostBreakpoint(message: ModelMessage): boolean {
    const content: unknown = message.content;
    if (typeof content === "string") return content.length > 0;
    if (!Array.isArray(content)) return false;
    const last: unknown = content.at(-1);
    if (typeof last !== "object" || last === null) return false;
    return (last as { readonly type?: unknown }).type !== "reasoning";
}

/** The index of the last message that can host the breakpoint, or `-1` when none can. */
function lastHostIndex(messages: readonly ModelMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message !== undefined && canHostBreakpoint(message)) return i;
    }
    return -1;
}

/** Whether this message already carries a cache marker in ANY breakpoint namespace. */
function carriesBreakpoint(message: ModelMessage): boolean {
    return BREAKPOINT_SITES.some(([namespace, key]) => message.providerOptions?.[namespace]?.[key] !== undefined);
}

/** The same message with each namespace of `options` merged into its own bag. */
function withBreakpoint<M extends ModelMessage>(message: M, options: ProviderOptions): M {
    const merged: Record<string, Record<string, unknown>> = { ...message.providerOptions };
    for (const [namespace] of BREAKPOINT_SITES) {
        const marker = options[namespace];
        if (marker === undefined) continue;
        merged[namespace] = { ...message.providerOptions?.[namespace], ...marker };
    }
    return { ...message, providerOptions: merged as NonNullable<M["providerOptions"]> };
}

/** The same message with every marker removed, and each namespace dropped when it held nothing else. */
function withoutBreakpoint<M extends ModelMessage>(message: M): M {
    if (!carriesBreakpoint(message)) return message;
    const remaining: Record<string, Record<string, unknown>> = { ...message.providerOptions };
    for (const [namespace, key] of BREAKPOINT_SITES) {
        const bag = remaining[namespace];
        if (bag?.[key] === undefined) continue;
        const { [key]: _dropped, ...rest } = bag;
        if (Object.keys(rest).length === 0) delete remaining[namespace];
        else remaining[namespace] = rest;
    }
    return { ...message, providerOptions: remaining as NonNullable<M["providerOptions"]> };
}

/**
 * Place the request's ONE cache breakpoint, on the last message that can host it.
 *
 * Returns a copy — the caller's array is the transcript the loop keeps pushing
 * onto and the host later persists, and a marker written into it would ride into
 * the stored thread and come back on every later turn, one more breakpoint per
 * turn until the request is refused. Only the request-shaped copy carries one.
 *
 * The placement is deliberately ROLLING, not pinned to the end of the stable
 * prefix: within one run the loop appends an assistant reply and its tool results
 * on every iteration, and a breakpoint that advances with them lets iteration N+1
 * read back everything iteration N wrote. A pinned breakpoint would re-process
 * the whole tool transcript uncached on every iteration, which is the opposite of
 * what an agent loop needs.
 *
 * A marker already on any other message is REMOVED — the invariant is exactly one
 * breakpoint per request, and a stored message that carries one from an older
 * build (`memory/ai-sdk-message-storage.ts` reads `cache_control` back off a
 * stored block) would otherwise spend a slot that the harness never budgeted.
 * `"off"` strips and places nothing, so turning caching off really does send no
 * directive at all.
 */
export function withPromptCacheBreakpoint<M extends ModelMessage>(messages: readonly M[], policy: PromptCachePolicy): readonly M[] {
    const options = promptCacheProviderOptions(policy);
    const target = options === undefined ? -1 : lastHostIndex(messages);
    if (target < 0 && !messages.some(carriesBreakpoint)) return messages;
    return messages.map((message, index) => (index === target && options !== undefined ? withBreakpoint(message, options) : withoutBreakpoint(message)));
}
