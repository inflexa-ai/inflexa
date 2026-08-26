/**
 * Provider seam — shared AI SDK-backed types.
 *
 * The harness talks to LLMs and embedding models through narrow,
 * vendor-neutral interfaces. Every call carries an `AgentSession`; billing
 * attribution is resolved lazily at the provider wire boundary.
 */

import type { FinishReason, LanguageModel, ModelMessage, ToolSet } from "ai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { TokenUsageField } from "../contracts/usage.js";
import type { ProviderError } from "./errors.js";

export type { FinishReason, LanguageModel, ModelMessage, ProviderOptions, ToolSet };

export interface ProviderCapabilities {
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
     * Whether the wire can carry a picture inside a user message. The loop uses
     * this placement only when the tool result cannot carry the picture. The tool
     * result then keeps its JSON text, and one user message after the tool message
     * of the round carries the bytes. Absent means "cannot carry", never
     * "unknown".
     */
    readonly imageUserMessages?: boolean;
}

export interface ChatRequest {
    readonly system: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: ToolSet;
    readonly toolChoice?: "auto" | "none" | "required" | { readonly type: "tool"; readonly toolName: string };
    readonly providerOptions?: ProviderOptions;
    /**
     * How deep the model reasons on this call. Absent sends no directive, thus
     * the model applies its own default. Refer to `ReasoningPolicy`.
     */
    readonly reasoning?: ReasoningPolicy;
}

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
export interface ChatUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly reasoningTokens?: number;
}

// Every count reported here is folded by the loop and published on the wire as
// `TokenUsageRollup`, whose fields `TOKEN_USAGE_FIELDS` enumerates. The rollup
// lives in `contracts/`, which may not import this module, so the pin between
// the two sits on this side of the boundary. Key-set equality in both
// directions: a count added here with no home on the wire is as much a drift as
// one added there and never reported.
type _AssertChatUsageFields = Exclude<keyof ChatUsage, TokenUsageField> | Exclude<TokenUsageField, keyof ChatUsage> extends never ? true : never;
const _assertChatUsageFields: _AssertChatUsageFields = true;

export interface ChatResponse {
    readonly message: Extract<ModelMessage, { role: "assistant" }>;
    /**
     * The terminal reason for this reply. `"aborted"` is produced ONLY by the
     * streaming wrapper (`createStreamingChat`), which resolves a client abort
     * with the partial assistant text assembled from the deltas it already
     * forwarded. The non-streaming `ChatProvider.chat` never yields `"aborted"`:
     * it propagates a client abort as a throw, because durable workflow loops —
     * the non-streaming provider's callers — record cancellation only when it
     * surfaces as a thrown exception.
     */
    readonly finishReason: FinishReason | "aborted";
    readonly rawFinishReason?: string;
    readonly usage?: ChatUsage;
    /**
     * The id of the model this provider instance is bound to — what the caller
     * asked for. Absent when the binding names no id.
     */
    readonly requestedModelId?: string;
    /**
     * The model id the provider itself reported as having answered. Absent
     * whenever the provider reported none — it is NEVER filled in from
     * `requestedModelId`, because a claim about which model answered is only
     * worth anything when the endpoint actually made it.
     *
     * A value differing from `requestedModelId` is not an error: the pair exists
     * so a consumer can observe an endpoint or proxy serving a different model
     * version than the one configured. Treat the comparison as best-effort
     * diagnostics, never as an invariant.
     */
    readonly servedModelId?: string;
}

export type ChatStreamEvent = { readonly type: "text-delta"; readonly text: string } | { readonly type: "done"; readonly response: ChatResponse };

export interface AgentChat {
    readonly capabilities: ProviderCapabilities;
    chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal): ResultAsync<ChatResponse, ProviderError>;
}

export interface ChatProvider extends AgentChat {
    chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;
    /**
     * The request-timeout limit that this provider enforces, in milliseconds, or
     * absent when it enforces none. The value bounds each silent interval of a
     * request attempt: the wait until the response starts, and each gap between
     * two content chunks of a stream. A consumer that scales a deadline reads this
     * value from the provider instance, not from a harness constant.
     */
    readonly requestTimeoutMs?: number;
}

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

export interface EmbeddingProvider {
    /**
     * Width of every vector `embed` returns. The write-side index paths create
     * each per-analysis pgvector index at exactly this width (`ensureSearchIndex`),
     * so the provider — not a harness constant — is the single source of the
     * dimension. A provider advertising a width its model does not emit fails at
     * the vector upsert, not here.
     */
    readonly dimensions: number;
    embed(texts: readonly string[], session: AgentSession): ResultAsync<number[][], ProviderError>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
