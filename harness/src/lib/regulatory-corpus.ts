/**
 * Helpers for the FDA/ICH regulatory corpus stored in cortex_regulatory_chunks.
 *
 * Three responsibilities:
 *  1. chunkText — split a normalized document into (~1000-token, 200-token-overlap)
 *     chunks, preserving section headings where the doc uses `## Heading` markers.
 *  2. upsertChunks — replace-by-(source, doc_id) write of a document's chunks +
 *     embeddings + metadata.
 *  3. searchByEmbedding — top-K cosine similarity over the corpus, with optional
 *     source / indication / modality filters.
 *
 * Embedding dim is 1536 (openai/text-embedding-3-small). The schema's vector
 * column is fixed at vector(1536) — passing other-dim arrays will fail at
 * insert time.
 */

import { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import { tryMutation, tryQuery, withTransaction, type DbError } from "./db-result.js";

export interface ChunkOptions {
    maxTokens?: number; // default 1000
    overlapTokens?: number; // default 200
}

export interface RawChunk {
    section: string | null;
    index: number;
    text: string;
}

/**
 * Split `text` into overlapping chunks bounded by `maxTokens` (word-count
 * approximation), respecting `## Heading` section boundaries where present.
 *
 * When the document has `## Heading` markers the text is split at those
 * boundaries first; each resulting section is then sliced into fixed-size
 * windows with the requested overlap. Sections with no body content are
 * silently skipped.
 *
 * When no `## Heading` markers are present the entire text is treated as a
 * single anonymous section (section: null).
 *
 * The returned chunks have globally monotone `index` values so consumers
 * can reassemble the document order without inspecting section names.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): RawChunk[] {
    const maxTokens = opts.maxTokens ?? 1000;
    const overlapTokens = opts.overlapTokens ?? 200;

    // Normalise so every `## Heading` is preceded by `\n`, then split.
    // This ensures a heading at position 0 (no preceding newline) is caught
    // the same way as headings mid-document.
    const normalised = text.startsWith("##") ? `\n${text}` : text;
    const parts = normalised.split(/\n##\s+/);

    // parts[0] is always the lead-in text before the first heading (may be
    // empty when the document opens with a heading).
    const sections =
        parts.length > 1
            ? parts.map((p, i) => {
                  if (i === 0) return { heading: null as string | null, body: p };
                  const nl = p.indexOf("\n");
                  if (nl === -1) return { heading: p.trim(), body: "" };
                  return { heading: p.slice(0, nl).trim(), body: p.slice(nl + 1) };
              })
            : [{ heading: null as string | null, body: text }];

    const out: RawChunk[] = [];
    let globalIdx = 0;

    for (const sec of sections) {
        const tokens = sec.body.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;

        // Slide a window of maxTokens tokens with advance = maxTokens - overlapTokens.
        // The last window may be shorter than maxTokens (trailing partial slice).
        const advance = Math.max(1, maxTokens - overlapTokens);
        let i = 0;
        while (i < tokens.length) {
            const slice = tokens.slice(i, i + maxTokens).join(" ");
            out.push({ section: sec.heading, index: globalIdx++, text: slice });
            // If this window didn't fill maxTokens it was the final slice.
            if (i + maxTokens >= tokens.length) break;
            i += advance;
        }
    }
    return out;
}

export interface ChunkRow {
    source: "FDA-CDER" | "FDA-CBER" | "ICH";
    doc_id: string;
    doc_title: string;
    doc_url: string;
    chunks: Array<RawChunk & { embedding: number[] }>;
    metadata: Record<string, unknown>;
}

/**
 * Replace-by-(source, doc_id): delete all existing chunks for the document
 * then insert the new set in a single transaction.
 *
 * Embedding dimension is validated before the transaction opens — a mismatch
 * is a programmer/data error, thrown verbatim (no DB touched, nothing to roll
 * back), not a `DbError`.
 */
export function upsertChunks(pool: Pool, row: ChunkRow): ResultAsync<void, DbError> {
    for (const ch of row.chunks) {
        if (ch.embedding.length !== 1536) {
            throw new Error(`chunk embedding dim ${ch.embedding.length} != 1536 ` + `(source=${row.source} doc_id=${row.doc_id} index=${ch.index})`);
        }
    }

    return withTransaction(pool, "regulatoryCorpus.upsertChunks", (client) =>
        tryMutation("regulatoryCorpus.upsertChunks", async () => {
            await client.query("DELETE FROM cortex_regulatory_chunks WHERE source = $1 AND doc_id = $2", [row.source, row.doc_id]);

            for (const ch of row.chunks) {
                await client.query(
                    `INSERT INTO cortex_regulatory_chunks
           (source, doc_id, doc_title, doc_url, section, chunk_index, chunk_text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)`,
                    [row.source, row.doc_id, row.doc_title, row.doc_url, ch.section, ch.index, ch.text, `[${ch.embedding.join(",")}]`, row.metadata],
                );
            }
        }),
    );
}

export interface SearchFilters {
    source?: "FDA-CDER" | "FDA-CBER" | "ICH";
    topK?: number;
}

export interface SearchHit {
    source: string;
    doc_id: string;
    doc_title: string;
    doc_url: string;
    section: string | null;
    excerpt: string;
    score: number;
}

/**
 * Top-K cosine similarity search over cortex_regulatory_chunks.
 *
 * Uses pgvector's `<=>` (cosine distance) operator. Score is `1 - distance`
 * so higher scores = more similar. The `source` filter narrows results to
 * a single corpus subset (FDA-CDER, FDA-CBER, or ICH).
 *
 * Embedding dimension is validated before the query. Indication/modality
 * filters are intentionally absent — the ingestion pipeline does not yet
 * tag those keys on chunk metadata, and a filter that always returns zero
 * rows would silently defeat consumer expectations.
 */
export function searchByEmbedding(pool: Pool, embedding: number[], filters: SearchFilters = {}): ResultAsync<SearchHit[], DbError> {
    if (embedding.length !== 1536) {
        throw new Error(`query embedding dim ${embedding.length} != 1536`);
    }

    const topK = filters.topK ?? 8;
    const wheres: string[] = [];
    const params: unknown[] = [`[${embedding.join(",")}]`];

    if (filters.source) {
        params.push(filters.source);
        wheres.push(`source = $${params.length}`);
    }

    const whereClause = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    params.push(topK);

    const sql = `
    SELECT source, doc_id, doc_title, doc_url, section, chunk_text,
           1 - (embedding <=> $1::vector) AS score
    FROM cortex_regulatory_chunks
    ${whereClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $${params.length}
  `;

    return tryQuery("regulatoryCorpus.searchByEmbedding", async () => {
        const res = await pool.query<{
            source: string;
            doc_id: string;
            doc_title: string;
            doc_url: string;
            section: string | null;
            chunk_text: string;
            score: string;
        }>(sql, params);

        return res.rows.map((r) => ({
            source: r.source,
            doc_id: r.doc_id,
            doc_title: r.doc_title,
            doc_url: r.doc_url,
            section: r.section,
            excerpt: r.chunk_text,
            score: Number(r.score),
        }));
    });
}
