/**
 * Embedding provider.
 *
 * The ONLY file in the harness that imports `openai`. The SDK client is
 * pointed at the gateway base URL of the host; the optional request headers
 * hook of the host gives the headers of each attempt. Embeds with OpenAI
 * `text-embedding-3-small`.
 */

import OpenAI from "openai";
import { ResultAsync, err, ok, okAsync, type Result } from "neverthrow";

import { scopeWorkloadId } from "../auth/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { createRetry, failureOf, headersForAttempt, type HookCall } from "./ai-sdk.js";
import { DEFAULT_SUSPEND_ON, type ProviderError, type SuspendOn } from "./errors.js";
import type { ResolveRequestHeaders } from "./request-headers.js";
import type { EmbeddingProvider, FetchLike } from "./types.js";
import type { AgentSession } from "../auth/types.js";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
/** Vector width of the default model — `text-embedding-3-small` emits 1536-dim vectors. */
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
/**
 * The retries of one embed call: the default count of the OpenAI client. The
 * harness envelope owns them, and the client makes one attempt, thus the
 * request headers hook runs before each attempt and a mapped status is never
 * retried.
 */
const EMBEDDING_MAX_RETRIES = 2;

export interface EmbeddingProviderDeps {
    /** Gateway base URL — all embedding traffic is routed through it. */
    readonly baseURL: string;
    /** API token presented to the gateway. */
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
    readonly resolveRequestHeaders?: ResolveRequestHeaders;
    /** Absent, the provider uses `DEFAULT_SUSPEND_ON`. */
    readonly suspendOn?: SuspendOn;
    /** Diagnostics sink for the retry envelope. Defaults to a no-op. */
    readonly logger?: Logger;
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
        maxRetries: 0,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const model = deps.model ?? DEFAULT_EMBEDDING_MODEL;
    const dimensions = deps.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    const suspendOn = deps.suspendOn ?? DEFAULT_SUSPEND_ON;
    const logger = deps.logger ?? createNoopLogger();

    function embed(texts: readonly string[], session: AgentSession): ResultAsync<number[][], ProviderError> {
        if (texts.length === 0) return okAsync([]);

        const workload = `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
        const run = async (): Promise<Result<number[][], ProviderError>> => {
            const hookCall: HookCall = { unsettled: false };
            const retry = createRetry(undefined, logger, EMBEDDING_MAX_RETRIES, suspendOn, hookCall);
            try {
                const response = await retry(async () => {
                    const headers = await headersForAttempt(deps.resolveRequestHeaders, session, hookCall);
                    return await client.embeddings.create({ model, input: [...texts], encoding_format: "float" }, { headers });
                });
                // The API does not guarantee response order; re-key by `index`.
                const rows = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
                return ok(rows);
            } catch (e) {
                // A rejection of the hook is a defect of the host, and it passes through with no change.
                if (hookCall.unsettled) throw e;
                return err(failureOf(e, workload, suspendOn));
            }
        };
        return new ResultAsync(run());
    }

    return { embed, dimensions };
}
