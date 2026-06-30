/**
 * Provider seam — shared types.
 *
 * The harness talks to LLMs and embedding models through two narrow,
 * vendor-neutral interfaces (`ChatProvider`, `EmbeddingProvider`). Every
 * call carries an `AgentSession` — the conduit identity view both bundles
 * (`RequestSession`, `RunSession`) satisfy (see `harness/auth/types.ts`), so
 * the same provider serves a live request and a durable workflow run. The
 * session carries no billing headers; those are resolved lazily at the call
 * site (`harness/billing/resolver.ts`).
 *
 * The chat message shape is Anthropic-native: `Message` is re-exported
 * from the Anthropic SDK and is the harness's lingua franca (see the harness-providers spec).
 */

import type { Message, MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/messages";
import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { ProviderError } from "./errors.js";

export type { Message };

/**
 * An Anthropic-shaped chat request, minus the fields the provider owns:
 * `model` is a construction-time dependency of the provider, `stream` is
 * forced on (both `chat` and `chatStream` issue streaming wire calls), and
 * `max_tokens` is the provider's per-model output cap (`maxOutputTokens`).
 */
export type ChatRequest = Omit<MessageCreateParamsBase, "model" | "stream" | "max_tokens">;

/**
 * A thin transport envelope for streamed chat output. NOT a message
 * representation — the `Message` carried by `done` is Anthropic-shaped
 * (see the harness-providers spec).
 */
export type ChatStreamEvent = { readonly type: "text-delta"; readonly text: string } | { readonly type: "done"; readonly message: Message };

/**
 * The chat seam the agent loop runs on: one request in, one complete
 * `Message` out. `runAgent` is streaming-agnostic — it only ever calls
 * `chat`. A `ChatProvider` IS an `AgentChat` (its `chat` collapses the
 * stream silently); `createStreamingChat` builds a second `AgentChat` that
 * collapses *and* forwards token deltas. The loop never knows which it got.
 *
 * `chat` is Result-returning: `err` is a `ProviderError`, never thrown.
 * Control-flow exceptions (a client abort) are the sole exception — they are
 * thrown verbatim, outside the error channel.
 */
export interface AgentChat {
    chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal): ResultAsync<Message, ProviderError>;
}

/**
 * The full LLM chat provider — an `AgentChat` plus the raw `chatStream`
 * primitive. `chat` collapses the stream to a complete, cacheable `Message`
 * via the SDK's `finalMessage()` (Result-returning); `chatStream` yields
 * token deltas and STAYS a throwing `AsyncIterable`. Both issue streaming
 * wire calls. `createAnthropicProvider` returns a `ChatProvider`; the agent
 * loop only depends on the `AgentChat` subset.
 */
export interface ChatProvider extends AgentChat {
    chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;
}

/**
 * The embedding seam. `embed` is Result-returning: `err` is a
 * `ProviderError`, never thrown (it takes no `AbortSignal`).
 */
export interface EmbeddingProvider {
    embed(texts: readonly string[], session: AgentSession): ResultAsync<number[][], ProviderError>;
}

/**
 * The `fetch` shape the provider SDKs accept. Production passes the global
 * `fetch`; tests inject a fake to replay recorded responses.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
