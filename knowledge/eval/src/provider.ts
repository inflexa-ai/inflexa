/**
 * The model connection of the evaluation: one `ChatProvider` of the harness
 * over the endpoint the campaign names. Three forms:
 *
 *   --provider cliproxy              the local Inflexa proxy (Anthropic wire, the proxy key)
 *   --provider anthropic             an Anthropic endpoint, key from --api-key-env
 *   --provider openai-compatible     any OpenAI-compatible endpoint (GLM, Qwen, ...), key from --api-key-env
 *   --provider-order a,b             OpenRouter only: the upstream providers to try, in order, then the rest
 *   --request-timeout-ms n           the silent-interval bound of one request, which also raises the plan deadline
 *
 * The small target models connect through the OpenAI-compatible form, the same
 * wire the direct connection mode of the CLI uses, thus a run here exercises
 * the same tool-calling path as a run in the product.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { createConfiguredAiSdkProvider, createNoopBillingResolver, createNoopLogger, type ChatProvider } from "@inflexa-ai/harness";

export interface ModelConnection {
    readonly provider: "cliproxy" | "anthropic" | "openai-compatible";
    readonly model: string;
    readonly baseUrl?: string;
    readonly apiKeyEnv?: string;
    readonly name?: string;
    /** The upstream providers of an OpenRouter model, in the order to try. */
    readonly providerOrder?: readonly string[];
    /**
     * The silent-interval bound of one request. The plan deadline of the
     * harness is the maximum of its 600 s floor and this value, thus a slow
     * model with long reasoning gets the time to submit a plan.
     */
    readonly requestTimeoutMs?: number;
}

/**
 * A fetch that adds the routing preference of OpenRouter to each request: the
 * upstream providers to try, in order, with the fallback to the rest. OpenRouter
 * reads the preference from the request body, and the SDK gives no hook for an
 * extra body field, thus the wrapper edits the body. The preference pins the
 * quantization of a campaign, and it skips an upstream that answers 429.
 */
function orderedFetch(order: readonly string[]): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return (input, init) => {
        if (typeof init?.body !== "string") return fetch(input, init);
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return fetch(input, { ...init, body: JSON.stringify({ ...body, provider: { order, allow_fallbacks: true } }) });
    };
}

async function proxyKey(): Promise<string> {
    const text = await Bun.file(join(homedir(), ".local", "share", "inflexa", "cliproxy", "config.yaml")).text();
    const key = text.match(/^api-keys:\s*\n\s*-\s*"([^"]+)"/m)?.[1];
    if (!key) throw new Error("the cliproxy config holds no api-keys entry");
    return key;
}

export async function buildProvider(connection: ModelConnection): Promise<ChatProvider> {
    const resolveBilling = createNoopBillingResolver();
    const logger = createNoopLogger();
    if (connection.provider === "cliproxy") {
        const port = Bun.env.INFLEXA_CLIPROXY_PORT ?? "8317";
        return createConfiguredAiSdkProvider({
            resolveBilling,
            logger,
            config: {
                kind: "anthropic",
                baseURL: connection.baseUrl ?? `http://localhost:${port}/v1`,
                apiKey: await proxyKey(),
                model: connection.model,
                capabilities: { toolCalling: true, imageToolResults: false },
            },
        });
    }
    const apiKey = connection.apiKeyEnv ? Bun.env[connection.apiKeyEnv] : undefined;
    if (!apiKey) throw new Error(`the key variable ${connection.apiKeyEnv ?? "(none)"} is not set`);
    if (connection.provider === "anthropic") {
        return createConfiguredAiSdkProvider({
            resolveBilling,
            logger,
            config: { kind: "anthropic", ...(connection.baseUrl ? { baseURL: connection.baseUrl } : {}), apiKey, model: connection.model, capabilities: { toolCalling: true, imageToolResults: true } },
        });
    }
    if (!connection.baseUrl) throw new Error("an openai-compatible connection needs --base-url");
    return createConfiguredAiSdkProvider({
        resolveBilling,
        logger,
        config: {
            kind: "openai-compatible",
            name: connection.name ?? "openai-compatible",
            baseURL: connection.baseUrl,
            apiKey,
            model: connection.model,
            ...(connection.providerOrder ? { fetch: orderedFetch(connection.providerOrder) } : {}),
            ...(connection.requestTimeoutMs ? { requestTimeoutMs: connection.requestTimeoutMs } : {}),
            capabilities: { toolCalling: true, imageToolResults: false },
        },
    });
}

/** The text of one assistant reply, whatever the content shape. */
export function replyText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
        .map((part) => part.text)
        .join("\n");
}
