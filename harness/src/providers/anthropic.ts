/**
 * Compatibility entry point for Anthropic-backed chat.
 *
 * The production provider path is AI SDK-backed; this wrapper preserves the
 * old factory name for embedders while returning the new `ChatProvider` seam.
 */

import type { ResolveBilling } from "../billing/resolver.js";
import type { Logger } from "../lib/logger.js";
import { createConfiguredAiSdkProvider } from "./ai-sdk.js";
import type { ChatProvider, FetchLike } from "./types.js";

export interface AnthropicProviderDeps {
    readonly baseURL?: string;
    readonly token: string;
    readonly model: string;
    readonly resolveBilling: ResolveBilling;
    readonly fetch?: FetchLike;
    readonly logger?: Logger;
}

/**
 * Convenience over the `anthropic` arm of the public `AiSdkProviderConfig`
 * union: it takes the Anthropic connection fields directly (`token` as the api
 * key) and delegates to `createConfiguredAiSdkProvider`. The same construction
 * contract holds — the `model` is bound into the returned provider.
 */
export function createAnthropicProvider(deps: AnthropicProviderDeps): ChatProvider {
    return createConfiguredAiSdkProvider({
        resolveBilling: deps.resolveBilling,
        logger: deps.logger,
        config: {
            kind: "anthropic",
            baseURL: deps.baseURL,
            apiKey: deps.token,
            model: deps.model,
            fetch: deps.fetch,
            capabilities: { toolCalling: true },
        },
    });
}
