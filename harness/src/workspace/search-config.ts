/**
 * Shared search configuration — vector index naming and creation.
 *
 * Used by both write-time workspaces (sandbox, data-profile) and
 * read-time workspaces (chat, workflow agents) so they share the
 * same persistent per-analysis pgvector index.
 */

import type { Pool } from "pg";

import { createVectorStore } from "../state/vector-store.js";
import { unwrapOrThrow } from "../lib/result.js";

/** Derive the vector index name for an analysis. */
export function searchIndexName(resourceId: string): string {
    return `search_${resourceId.replace(/-/g, "_")}`;
}

const _ensuredIndexes = new Set<string>();

/**
 * Ensure the per-analysis pgvector index exists and has an HNSW index
 * attached. Idempotent across the process lifetime and across concurrent
 * replicas (`CREATE … IF NOT EXISTS`).
 *
 * `dimensions` is the wired `EmbeddingProvider.dimensions` — the provider is
 * the single source of the vector width, so indexes created here always match
 * what the write-side embedder emits. A pre-existing index created at another
 * width is left as-is (`IF NOT EXISTS`); the mismatch surfaces at the vector
 * upsert. Per-analysis dimension tracking / re-embedding on a provider switch
 * is a deliberate non-feature for now.
 */
export async function ensureSearchIndex(pool: Pool, resourceId: string, dimensions: number): Promise<void> {
    const name = searchIndexName(resourceId);
    if (_ensuredIndexes.has(name)) return;
    const store = createVectorStore(pool);
    unwrapOrThrow(
        await store.createIndex({
            indexName: name,
            dimension: dimensions,
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
