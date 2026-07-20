/**
 * Config-driven embedding-mode resolution: pick the right {@link EmbeddingProvider}
 * realization for the current `config.embedding.mode`, or fail with a precise,
 * user-actionable error. Mirrors the proxy setup's "config decides which backend"
 * pattern — the caller (`bootHarnessRuntime`, the harness composition root) gets a
 * ready-to-inject provider or a reason to surface to the user.
 *
 * Modes:
 * - `local`   → {@link createLocalEmbeddingProvider} (in-process bge-small GGUF).
 * - `api-key` → harness `createEmbeddingProvider` (OpenAI-shaped), connecting
 *   DIRECTLY to the configured endpoint — never through the chat proxy, which
 *   fronts OAuth chat providers and serves no embeddings route. The noop billing
 *   resolver applies: the CLI's local mode does no attribution.
 * - `off`     → error: embeddings are not configured (the default until setup).
 */

import { err, ok, type Result } from "neverthrow";

import { createEmbeddingProvider, createNoopBillingResolver, type EmbeddingProvider } from "@inflexa-ai/harness";

import type { Config } from "../../lib/config.ts";
import { createLocalEmbeddingProvider } from "./local-provider.ts";

/**
 * Where `api-key` mode connects when `embedding.baseURL` is unset. OpenAI's own
 * endpoint, because the mode's model default (`text-embedding-3-small`, via the
 * harness provider) is an OpenAI model — the two defaults only make sense together.
 * Exported so the config UI can seed its base-URL prompt from the same value it resolves against.
 */
export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";

/**
 * The width `api-key` mode ends up at when `embedding.dimensions` is unset — mirrors the harness
 * provider's own default for `text-embedding-3-small`. Not consulted by {@link resolveEmbedder} (it
 * passes `dimensions` through and lets the harness apply its default); it exists so the config UI can
 * SUGGEST the same number it would otherwise get, instead of prompting against a blank.
 */
export const DEFAULT_API_EMBEDDING_DIMENSIONS = 1536;

/**
 * The model `api-key` mode ends up on when `embedding.model` is unset — mirrors the harness provider's
 * own default. Like {@link DEFAULT_API_EMBEDDING_DIMENSIONS}, it is not consulted by
 * {@link resolveEmbedder} (the harness applies its default); it exists so the setup prompt can pre-fill
 * the exact model the config would otherwise resolve to.
 */
export const DEFAULT_API_EMBEDDING_MODEL = "text-embedding-3-small";

export type EmbeddingResolveError =
    | { readonly type: "embeddings_not_configured"; readonly message: string }
    | { readonly type: "local_model_missing"; readonly message: string }
    | { readonly type: "api_key_missing"; readonly message: string };

/**
 * Resolve the embedder for `config`. Returns a ready-to-inject
 * {@link EmbeddingProvider} on the ok channel, or a {@link EmbeddingResolveError}
 * naming exactly what is missing on the error channel.
 */
export function resolveEmbedder(config: Config): Result<EmbeddingProvider, EmbeddingResolveError> {
    const { mode } = config.embedding;

    if (mode === "off") {
        // `mode` is inferred from a lone `apiKey`/`modelPath` (see the embedding schema in lib/config.ts),
        // so reaching `off` WITH a backend field set means the user wrote an EXPLICIT `mode: "off"` beside
        // it — name that contradiction instead of claiming nothing is configured.
        const strandedField =
            config.embedding.apiKey !== undefined ? "embedding.apiKey" : config.embedding.modelPath !== undefined ? "embedding.modelPath" : null;
        return err({
            type: "embeddings_not_configured",
            message:
                strandedField !== null
                    ? `Embeddings are switched off: ${strandedField} is set but embedding.mode is explicitly "off". Remove the mode override (it is inferred from ${strandedField}), or set it to ${strandedField === "embedding.apiKey" ? '"api-key"' : '"local"'}.`
                    : "Embeddings are not configured. Run `inflexa setup --embeddings local` to enable local embeddings.",
        });
    }

    if (mode === "local") {
        const modelPath = config.embedding.modelPath;
        // The GGUF path is required for local mode — setup writes it, but a
        // hand-edited config or a fresh install without setup leaves it unset.
        if (!modelPath) {
            return err({
                type: "local_model_missing",
                message: "Local embedding mode is set but no model path is configured. Run `inflexa setup --embeddings local`.",
            });
        }
        // `dimensions` is set only for a custom GGUF (setup measures and records its real width); the
        // built-in bge-small records none and the provider defaults to 384. Passing it through is what
        // lets a user's own local model of a different width size the index correctly.
        return ok(createLocalEmbeddingProvider({ modelPath, dimensions: config.embedding.dimensions }));
    }

    // `api-key`: connect directly to the configured OpenAI-compatible endpoint.
    // The CLI's local mode does no billing attribution, so the noop resolver is
    // the correct `ResolveBilling` realization here. `model`/`dimensions` fall
    // through to the harness defaults (text-embedding-3-small / 1536) when unset;
    // a custom `model` needs a matching `dimensions` or the boot probe rejects it.
    const apiKey = config.embedding.apiKey;
    if (!apiKey) {
        return err({
            type: "api_key_missing",
            message: "API-key embedding mode is set but no API key is configured. Run `inflexa setup --embeddings api-key`.",
        });
    }
    return ok(
        createEmbeddingProvider({
            baseURL: config.embedding.baseURL ?? DEFAULT_API_BASE_URL,
            token: apiKey,
            model: config.embedding.model,
            dimensions: config.embedding.dimensions,
            resolveBilling: createNoopBillingResolver(),
        }),
    );
}
