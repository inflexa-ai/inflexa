/**
 * Compatibility entry point for Anthropic-backed chat.
 *
 * The production provider path is AI SDK-backed; this wrapper preserves the
 * old factory name for embedders while returning the new `ChatProvider` seam.
 */

import type { ResolveBilling } from "../billing/resolver.js";
import { createConfiguredAiSdkProvider } from "./ai-sdk.js";
import type { ChatProvider, FetchLike } from "./types.js";

export interface AnthropicProviderDeps {
    readonly baseURL?: string;
    readonly token: string;
    readonly model: string;
    readonly resolveBilling: ResolveBilling;
    readonly fetch?: FetchLike;
}

export function createAnthropicProvider(deps: AnthropicProviderDeps): ChatProvider {
    return createConfiguredAiSdkProvider({
        resolveBilling: deps.resolveBilling,
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
