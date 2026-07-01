/**
 * Shared search configuration — vector store, embedder, and index naming.
 *
 * Used by both write-time workspaces (sandbox, data-profile) and
 * read-time workspaces (chat, workflow agents) so they share the
 * same persistent per-analysis pgvector index.
 */

import type { Pool } from "pg";

import { createVectorStore } from "../state/vector-store.js";
import { unwrapOrThrow } from "../lib/result.js";
import { createEmbeddingProvider } from "../providers/embedding.js";
import type { ResolveBilling } from "../billing/resolver.js";
import type { AgentSession } from "../auth/types.js";

/** Derive the vector index name for an analysis. */
export function searchIndexName(resourceId: string): string {
    return `search_${resourceId.replace(/-/g, "_")}`;
}

/**
 * Build a session-bound embedder. The returned function is a thin wrapper
 * around the harness `EmbeddingProvider` (billing assembled from the session
 * by the provider's resolver) — write-side callers (data-profile, build-deps) thread
 * the per-run session through so embeddings are attributed.
 */
export function createEmbedder(cfg: {
    embeddingModel: string;
    baseURL: string;
    token: string;
    resolveBilling: ResolveBilling;
}): (text: string, session: AgentSession) => Promise<number[]> {
    if (!cfg.baseURL || !cfg.token) {
        throw new Error("createEmbedder: baseURL and token must be set");
    }
    const provider = createEmbeddingProvider({
        baseURL: cfg.baseURL,
        token: cfg.token,
        model: cfg.embeddingModel,
        resolveBilling: cfg.resolveBilling,
    });
    return async (text, session) => {
        const [vec] = unwrapOrThrow(await provider.embed([text], session));
        if (!vec) throw new Error("createEmbedder: empty embedding response");
        return vec;
    };
}

const _ensuredIndexes = new Set<string>();

/**
 * Ensure the per-analysis pgvector index exists and has an HNSW index
 * attached. Idempotent across the process lifetime and across concurrent
 * replicas (`CREATE … IF NOT EXISTS`).
 */
export async function ensureSearchIndex(pool: Pool, resourceId: string): Promise<void> {
    const name = searchIndexName(resourceId);
    if (_ensuredIndexes.has(name)) return;
    const store = createVectorStore(pool);
    unwrapOrThrow(
        await store.createIndex({
            indexName: name,
            dimension: 1536,
            metric: "cosine",
        }),
    );
    unwrapOrThrow(
        await store.buildIndex({
            indexName: name,
            metric: "cosine",
            indexConfig: { type: "hnsw" },
        }),
    );
    _ensuredIndexes.add(name);
}
