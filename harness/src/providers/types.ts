/**
 * Provider seam — shared AI SDK-backed types.
 *
 * The harness talks to LLMs and embedding models through narrow,
 * vendor-neutral interfaces. Every call carries an `AgentSession`; billing
 * attribution is resolved lazily at the provider wire boundary.
 */

import type { TelemetryOptions } from "ai";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { TokenUsageField } from "../contracts/usage.js";
import type { ProviderError } from "./errors.js";

export type { FinishReason, LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

export type { ProviderOptions } from "@ai-sdk/provider-utils";

export type ProviderCapabilities = {
    readonly toolCalling: boolean;
    /**
     * Whether the wire can carry a picture inside a tool result. The loop moves a
     * tool's picture into an image content block on the tool-result message. A
     * wire that renders that block sets this flag. A wire that stringifies the
     * block into text leaves it absent, and the loop then drops the picture and
     * keeps the text, because base64 text floods the context and the model cannot
     * see it. Absent means "cannot carry", never "unknown".
     */
    readonly imageToolResults?: boolean;
    /**
     * The context window of the model in tokens, when the host knows it. A chat
     * thread then compacts at 80% of the window at the latest. Absent means "at
     * least the compaction budget of the agent", thus the budget stays as declared.
     */
    readonly contextWindow?: number;
};

/**
 * Vendor-neutral prompt-cache policy — a harness concept, not a vendor one.
 *
 * `{ ttl }` asks the provider to cache the request prefix (system + tools +
 * message history) for that lifetime; `"off"` sends no cache directive at all.
 * Vendors that cache automatically (the OpenAI-compatible family does prefix
 * caching server-side, unprompted) need no directive, so the policy is a no-op
 * for them rather than an error — see `./prompt-cache.ts`, the single place the
 * harness translates this into vendor wire options.
 */
export type PromptCachePolicy = { readonly ttl: "5m" | "1h" } | "off";

/**
 * How deep a model reasons, in harness-neutral names.
 *
 * This is the `reasoning` call setting of the AI SDK, and the harness passes the
 * value through without a change. Each provider package maps the name onto its
 * own wire shape, and each one holds the table of what its models accept. The
 * Anthropic package selects adaptive thinking with the matching `effort`, and it
 * lowers a level that the model does not accept. The OpenAI-compatible package
 * sends the name as `reasoning_effort`.
 *
 * `"provider-default"` sends no directive, thus the model applies its own
 * default. `"none"` asks for no reasoning. The other names are the ladder from
 * the shallowest depth to the deepest depth.
 *
 * CAUTION: never write `providerOptions.anthropic.effort` or
 * `providerOptions.openai.reasoningEffort` in place of this field. A value on
 * either key turns the per-model table off, and the raw name then reaches the
 * wire. A model that does not accept that name answers 400.
 */
export type ReasoningPolicy = NonNullable<LanguageModelV4CallOptions["reasoning"]>;

/**
 * Token accounting for one chat call, in harness-neutral names.
 *
 * `inputTokens` is the *total* billed prefix — cached and uncached alike — so a
 * cache hit rate is `cacheReadInputTokens / inputTokens`, not a ratio against
 * some separate uncached figure. `cacheCreationInputTokens` is the write that
 * seeds the cache (billed at a premium; it only pays for itself once a later
 * call reads it back).
 *
 * `reasoningTokens` is exactly what the provider reported — never derived from,
 * nor reconciled against, `outputTokens`. Whether reasoning tokens are counted
 * inside the output total varies by provider, so any arithmetic between the two
 * would be a guess dressed as a figure.
 *
 * Every field is optional: a provider that reports no usage at all, or reports
 * totals without a cache breakdown, is legitimate. Absent means "not reported",
 * never "zero".
 */
export type ChatUsage = {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly reasoningTokens?: number;
};

// Every count reported here is folded by the loop and published on the wire as
// `TokenUsageRollup`, whose fields `TOKEN_USAGE_FIELDS` enumerates. The rollup
// lives in `contracts/`, which may not import this module, so the pin between
// the two sits on this side of the boundary. Key-set equality in both
// directions: a count added here with no home on the wire is as much a drift as
// one added there and never reported.
type _AssertChatUsageFields = [Exclude<keyof ChatUsage, TokenUsageField>, Exclude<TokenUsageField, keyof ChatUsage>] extends [never, never] ? true : never;
const _assertChatUsageFields: _AssertChatUsageFields = true;

/** A text delta of the reply that streams to a reader. */
export type ChatStreamEvent = { readonly type: "text-delta"; readonly text: string };

/** The facts of one run that bind a model: the session of its calls, its effort, and whether a reader sees its reply live. */
export type ModelBinding = {
    readonly session: AgentSession;
    /** Absent: the effort of the provider configuration, then `DEFAULT_REASONING`. */
    readonly reasoning?: ReasoningPolicy;
    /**
     * A reader sees the reply as it streams. A live call retries only before its first output part, and a
     * call with no live reader takes its whole reply inside each attempt.
     */
    readonly live: boolean;
    /** Called before the wait of each retry of a request inside the retry envelope. */
    readonly onRetry?: (retry: ModelRetry) => void;
};

/** One retry of a model request inside the retry envelope of the provider. */
export type ModelRetry = {
    /** The id of the request. Each retry of one request carries the same id. */
    readonly requestId: string;
    /** The number of this retry, from 1. */
    readonly attempt: number;
    readonly maxRetries: number;
    /** The wait before the next attempt, in milliseconds. */
    readonly delayMs: number;
    /** The HTTP error status of the failed attempt, 400 or higher. Absent for a failure with no error status. */
    readonly status?: number;
};

/** The model of one run, under the retry envelope of its provider, and the call settings of each request. */
export type BoundModel = {
    readonly model: LanguageModelV4;
    readonly settings: {
        readonly maxOutputTokens?: number;
        readonly reasoning: ReasoningPolicy;
        readonly providerOptions?: ProviderOptions;
    };
    readonly telemetry: TelemetryOptions;
};

/**
 * The model configuration of the harness: one model over one connection. The loop binds it for each run, and
 * the AI SDK drives each request.
 */
export type ChatProvider = {
    readonly capabilities: ProviderCapabilities;
    /**
     * The request-timeout limit that this provider enforces, in milliseconds, or
     * absent when it enforces none. The value bounds each silent interval of a
     * request attempt: the wait until the response starts, and each gap between
     * two content parts of a stream. A consumer that scales a deadline reads this
     * value from the provider instance, not from a harness constant.
     */
    readonly requestTimeoutMs?: number;
    bind(binding: ModelBinding): BoundModel;
};

/**
 * The effective deadline in milliseconds for a provider-bound operation.
 *
 * An explicit value wins. Absent an explicit value, the deadline is the maximum
 * of `floorMs` and the request-timeout limit that the provider advertises. Thus
 * a configured request timeout can raise the floor. It cannot lower the floor.
 */
export function effectiveDeadlineMs(provider: Pick<ChatProvider, "requestTimeoutMs">, floorMs: number, explicitMs?: number): number {
    return explicitMs ?? Math.max(floorMs, provider.requestTimeoutMs ?? 0);
}

export type EmbeddingProvider = {
    /**
     * Width of every vector `embed` returns. The write-side index paths create
     * each per-analysis pgvector index at exactly this width (`ensureSearchIndex`),
     * so the provider — not a harness constant — is the single source of the
     * dimension. A provider advertising a width its model does not emit fails at
     * the vector upsert, not here.
     */
    readonly dimensions: number;
    embed(texts: readonly string[], session: AgentSession): ResultAsync<number[][], ProviderError>;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
