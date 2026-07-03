/**
 * Embedding provider.
 *
 * The ONLY file in the harness that imports `openai`. The SDK client is
 * pointed at the billing-gateway base URL; per-call billing headers are assembled
 * from the `Session`. Embeds with OpenAI `text-embedding-3-small`.
 */

import OpenAI from "openai";
import { ResultAsync, err, ok, okAsync, type Result } from "neverthrow";

import { scopeWorkloadId } from "../auth/types.js";
import type { ResolveBilling } from "../billing/resolver.js";
import { type ProviderError, toProviderError } from "./errors.js";
import type { EmbeddingProvider, FetchLike } from "./types.js";
import type { AgentSession } from "../auth/types.js";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
/** Vector width of the default model — `text-embedding-3-small` emits 1536-dim vectors. */
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProviderDeps {
    /** Billing-gateway base URL — all embedding traffic is routed through it. */
    readonly baseURL: string;
    /** API token presented to the billing gateway. */
    readonly token: string;
    /** Embedding model id. Defaults to `text-embedding-3-small`. */
    readonly model?: string;
    /**
     * Vector width the configured model emits, advertised on the returned
     * provider (see {@link EmbeddingProvider.dimensions}). Defaults to the
     * default model's 1536 — a host wiring a non-default `model` must supply
     * the matching width or the per-analysis index is created at the wrong size.
     */
    readonly dimensions?: number;
    /** Resolves the billing attribution map at the call site. */
    readonly resolveBilling: ResolveBilling;
    /**
     * `fetch` override. Production omits it (the SDK's default is used);
     * tests inject a fake to feed a recorded response.
     */
    readonly fetch?: FetchLike;
}

export function createEmbeddingProvider(deps: EmbeddingProviderDeps): EmbeddingProvider {
    const client = new OpenAI({
        baseURL: deps.baseURL,
        apiKey: deps.token,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const model = deps.model ?? DEFAULT_EMBEDDING_MODEL;
    const dimensions = deps.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

    function embed(texts: readonly string[], session: AgentSession): ResultAsync<number[][], ProviderError> {
        if (texts.length === 0) return okAsync([]);

        const workload = `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
        const run = async (): Promise<Result<number[][], ProviderError>> => {
            try {
                const headers = await deps.resolveBilling(session);
                const response = await client.embeddings.create({ model, input: [...texts], encoding_format: "float" }, { headers });
                // The API does not guarantee response order; re-key by `index`.
                const rows = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
                return ok(rows);
            } catch (e) {
                return err(toProviderError(e, workload));
            }
        };
        return new ResultAsync(run());
    }

    return { embed, dimensions };
}
