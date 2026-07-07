/**
 * Provider seam — shared AI SDK-backed types.
 *
 * The harness talks to LLMs and embedding models through narrow,
 * vendor-neutral interfaces. Every call carries an `AgentSession`; billing
 * attribution is resolved lazily at the provider wire boundary.
 */

import type { FinishReason, LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { ProviderError } from "./errors.js";

export type { FinishReason, LanguageModel, ModelMessage, ProviderOptions, ToolSet };

export interface ProviderCapabilities {
    readonly toolCalling: boolean;
}

export interface ChatRequest {
    readonly system: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: ToolSet;
    readonly toolChoice?: "auto" | "none" | "required" | { readonly type: "tool"; readonly toolName: string };
    readonly providerOptions?: ProviderOptions;
}

export interface ChatResponse {
    readonly message: Extract<ModelMessage, { role: "assistant" }>;
    readonly finishReason: FinishReason;
    readonly rawFinishReason?: string;
}

export type ChatStreamEvent = { readonly type: "text-delta"; readonly text: string } | { readonly type: "done"; readonly response: ChatResponse };

export interface AgentChat {
    readonly capabilities: ProviderCapabilities;
    chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal): ResultAsync<ChatResponse, ProviderError>;
}

export interface ChatProvider extends AgentChat {
    chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;
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
