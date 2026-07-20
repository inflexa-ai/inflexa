/**
 * Remote embedding-model discovery for the `api-key` backend: list what the configured
 * OpenAI-compatible endpoint actually serves, so the user picks a real id instead of typing one from
 * memory (a typo'd model surfaces only as a failed embed, late).
 *
 * Deliberately NOT reusing `modules/proxy/models.ts`: that module lists the local CLIProxyAPI's CHAT
 * models and is hardwired to `env.cliproxyApiUrl`, whereas the api-key embedding backend talks DIRECTLY
 * to a user-supplied endpoint (never through the chat proxy, which serves no embeddings route). Same
 * wire shape, different host and credential — so this fetch is its own thing rather than a parameter
 * bolted onto the proxy's.
 */

import { z } from "zod";
import { err, ok, type Result } from "neverthrow";

/** The OpenAI-compatible `/models` payload; only `id` is load-bearing for the picker. */
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/** Why a listing could not be produced. Every variant is caller-degradable to free-text model entry. */
export type EmbeddingModelListError =
    | { readonly type: "invalid_url"; readonly detail: string }
    | { readonly type: "unreachable"; readonly detail: string }
    | { readonly type: "http_error"; readonly status: number }
    | { readonly type: "no_models" };

/**
 * Loopback hosts the api key may travel to over cleartext http. `new URL` normalizes an IPv6 literal
 * with its brackets kept, so the v6 loopback presents as `[::1]`, not `::1`.
 */
function isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * An OpenAI-compatible `/models` listing carries no "this is an embedding model" flag — the payload is
 * ids (plus optional `created`/`owned_by`) — so the id string is the only signal available. Matching
 * `embed` catches the ecosystem's conventional naming (`text-embedding-3-small`, `nomic-embed-text`,
 * `bge-*-embed`).
 *
 * An over-narrow match is safe BY CONSTRUCTION rather than by luck: when nothing matches, the listing
 * reports `no_models` and the caller falls back to free-text entry, so a model named unconventionally
 * stays reachable. The failure mode of this heuristic is "you type the id yourself", never "you cannot
 * configure this endpoint".
 */
function isEmbeddingModelId(id: string): boolean {
    return /embed/i.test(id);
}

/**
 * List the endpoint's embedding-capable model ids, sorted for a stable picker order.
 *
 * Never throws: an unparseable or unsafe-transport URL, a dead host, a non-2xx, an
 * unparseable/schema-mismatched body, and an empty or fully-filtered listing all land on the error
 * channel, because the caller's remedy is identical for every one of them — offer free-text entry
 * instead of dead-ending the configuration flow.
 */
export async function listEmbeddingModels(baseURL: string, apiKey: string, signal?: AbortSignal): Promise<Result<string[], EmbeddingModelListError>> {
    // Credential-leak guard, run BEFORE any fetch so the key never leaves the process on a rejected URL:
    // this request carries `Authorization: Bearer <apiKey>`, so a cleartext http:// URL to a non-loopback
    // host would expose the key to anything on the wire. Loopback is exempt because the local inference
    // servers this backend targets (ollama, llama.cpp server) speak plain http by design.
    let parsedURL: URL;
    try {
        parsedURL = new URL(baseURL);
    } catch {
        return err({ type: "invalid_url", detail: `not a valid URL: ${baseURL}` });
    }
    if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
        return err({ type: "invalid_url", detail: `unsupported protocol: ${parsedURL.protocol}` });
    }
    if (parsedURL.protocol === "http:" && !isLoopbackHost(parsedURL.hostname)) {
        return err({ type: "invalid_url", detail: `refusing to send the api key over cleartext http to non-loopback host ${parsedURL.hostname}` });
    }
    // Tolerate a trailing slash on the user-typed base URL, so `…/v1/` does not become `…/v1//models`.
    const url = `${baseURL.replace(/\/+$/, "")}/models`;
    let res: Response;
    // fetch throws on a dead endpoint (or an aborted signal); bridge that throw into the Result channel.
    try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    } catch (cause) {
        return err({ type: "unreachable", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    if (!res.ok) return err({ type: "http_error", status: res.status });
    // jsonWith yields null (never throws) on an unparseable or schema-mismatched body.
    const parsed = await res.jsonWith(modelsSchema);
    if (!parsed) return err({ type: "no_models" });
    const ids = parsed.data
        .map((m) => m.id)
        .filter(isEmbeddingModelId)
        .sort();
    if (ids.length === 0) return err({ type: "no_models" });
    return ok(ids);
}
