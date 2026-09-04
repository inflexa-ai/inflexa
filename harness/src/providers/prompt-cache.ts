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
 * Translate a neutral cache policy into provider wire options.
 *
 * Returns `undefined` for `"off"` so the caller can leave the bag entirely unset
 * rather than sending an empty one.
 *
 * CAUTION: this is the marker's VALUE, not its placement. Attaching it to a
 * `ChatRequest` emits the invisible top-level field the module header warns
 * about. Place it with {@link withPromptCacheBreakpoint}.
 */
export function promptCacheProviderOptions(policy: PromptCachePolicy): ProviderOptions | undefined {
    if (policy === "off") return undefined;
    return { anthropic: { cacheControl: { type: "ephemeral", ttl: policy.ttl } } };
}

/**
 * The `anthropic` namespace key that carries the marker. Named once so the
 * writer and the stripper cannot drift apart.
 */
const CACHE_CONTROL_KEY = "cacheControl";
const ANTHROPIC = "anthropic";

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

/** Whether this message already carries a cache marker in the anthropic namespace. */
function carriesBreakpoint(message: ModelMessage): boolean {
    return message.providerOptions?.[ANTHROPIC]?.[CACHE_CONTROL_KEY] !== undefined;
}

/** The same message with the marker added to its anthropic namespace. */
function withBreakpoint<M extends ModelMessage>(message: M, options: ProviderOptions): M {
    return {
        ...message,
        providerOptions: {
            ...message.providerOptions,
            [ANTHROPIC]: { ...message.providerOptions?.[ANTHROPIC], ...options[ANTHROPIC] },
        },
    };
}

/** The same message with the marker removed, and the namespace dropped when it held nothing else. */
function withoutBreakpoint<M extends ModelMessage>(message: M): M {
    if (!carriesBreakpoint(message)) return message;
    const { [CACHE_CONTROL_KEY]: _dropped, ...rest } = message.providerOptions?.[ANTHROPIC] ?? {};
    const { [ANTHROPIC]: _namespace, ...others } = message.providerOptions ?? {};
    return {
        ...message,
        providerOptions: Object.keys(rest).length === 0 ? others : { ...others, [ANTHROPIC]: rest },
    };
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
