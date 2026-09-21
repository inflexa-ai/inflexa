/**
 * Compatibility entry point for Anthropic-backed chat.
 *
 * The production provider path is AI SDK-backed; this wrapper preserves the
 * old factory name for embedders while returning the new `ChatProvider` seam.
 */

import type { Logger } from "../lib/logger.js";
import { createConfiguredAiSdkProvider, type ProviderHostPolicy } from "./ai-sdk.js";
import type { ChatProvider, FetchLike } from "./types.js";

export interface AnthropicProviderDeps extends ProviderHostPolicy {
    readonly baseURL?: string;
    readonly token: string;
    readonly model: string;
    readonly fetch?: FetchLike;
    readonly logger?: Logger;
    /** Output-token ceiling per request. Defaults to `DEFAULT_MAX_OUTPUT_TOKENS`. */
    readonly maxOutputTokens?: number;
}

/**
 * Convenience over the `anthropic` arm of the public `AiSdkProviderConfig`
 * union: it takes the Anthropic connection fields directly (`token` as the api
 * key) and delegates to `createConfiguredAiSdkProvider`. The same construction
 * contract holds — the `model` is bound into the returned provider.
 */
export function createAnthropicProvider(deps: AnthropicProviderDeps): ChatProvider {
    return createConfiguredAiSdkProvider({
        ...(deps.resolveRequestHeaders !== undefined ? { resolveRequestHeaders: deps.resolveRequestHeaders } : {}),
        ...(deps.suspendOn !== undefined ? { suspendOn: deps.suspendOn } : {}),
        logger: deps.logger,
        config: {
            kind: "anthropic",
            baseURL: deps.baseURL,
            apiKey: deps.token,
            model: deps.model,
            fetch: deps.fetch,
            capabilities: { toolCalling: true },
            ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
        },
    });
}
