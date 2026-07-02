/**
 * Config-driven embedding-mode resolution: pick the right {@link EmbeddingProvider}
 * realization for the current `config.embedding.mode`, or fail with a precise,
 * user-actionable error. Mirrors the proxy setup's "config decides which backend"
 * pattern — the caller (a future `assembleCoreRuntime` wiring) gets a ready-to-
 * inject provider or a reason to surface to the user.
 *
 * Modes:
 * - `local`   → {@link createLocalEmbeddingProvider} (in-process bge-small GGUF).
 * - `api-key` → harness `createEmbeddingProvider` (OpenAI-shaped, routed through
 *   the local CLIProxyAPI gateway at `env.cliproxyApiUrl` with the noop billing
 *   resolver — the CLI's local mode does no attribution).
 * - `off`     → error: embeddings are not configured (the default until setup).
 */

import { err, ok, type Result } from "neverthrow";

import { createEmbeddingProvider, createNoopBillingResolver, type EmbeddingProvider } from "@inflexa-ai/harness";

import type { Config } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { createLocalEmbeddingProvider } from "./local-provider.ts";

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
        return err({
            type: "embeddings_not_configured",
            message: "Embeddings are not configured. Run `inflexa setup --embeddings local` to enable local embeddings.",
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
        return ok(createLocalEmbeddingProvider({ modelPath }));
    }

    // `api-key`: route through the local CLIProxyAPI gateway using the user's
    // configured key. The CLI's local mode does no billing attribution, so the
    // noop resolver is the correct `ResolveBilling` realization here.
    const apiKey = config.embedding.apiKey;
    if (!apiKey) {
        return err({
            type: "api_key_missing",
            message: "API-key embedding mode is set but no API key is configured. Run `inflexa setup --embeddings api-key`.",
        });
    }
    return ok(
        createEmbeddingProvider({
            baseURL: env.cliproxyApiUrl,
            token: apiKey,
            resolveBilling: createNoopBillingResolver(),
        }),
    );
}
