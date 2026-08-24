/**
 * Minimal pgvector store — just the surface the harness write-side needs.
 *
 * Schema:
 *   - `id SERIAL PRIMARY KEY`
 *   - `vector_id TEXT UNIQUE NOT NULL`
 *   - `embedding vector(${dimension})`
 *   - `metadata JSONB DEFAULT '{}'::jsonb`
 * Existing per-analysis `search_{...}` tables continue to work; the read-side
 * (`tools/workspace/workspace-search.ts`) already speaks `vector_id`.
 *
 * Identifier guard: `indexName` is interpolated into SQL — only allow the
 * `search_{snake}` shape we ever produce.
 */

import { okAsync, ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";

/**
 * The identifier shape and length the harness may interpolate into a statement.
 * An identifier cannot be a bind parameter, so a name reaching SQL has to be
 * checked rather than bound, and lower-snake is the whole of what the harness ever
 * derives. The bound is as load-bearing as the shape: Postgres keeps only the
 * first 63 bytes of an identifier and truncates the rest silently, so two longer
 * names sharing a 63-byte prefix resolve to one table — a write that lands in
 * another resource's index, and a drop that takes it. The shape is ASCII-only, so
 * a name that matches it has one byte per character and `length` is the byte count
 * the limit is measured in.
 */
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_SQL_IDENTIFIER_BYTES = 63;

/**
 * Whether `name` may be interpolated into a statement as an identifier. Shared
 * with the reclaim side, which guards the same derived names against the same
 * shape — one invariant, one place to read it.
 */
export function isSqlIdentifier(name: string): boolean {
    return SQL_IDENTIFIER.test(name) && name.length <= MAX_SQL_IDENTIFIER_BYTES;
}

export interface CreateIndexInput {
    readonly indexName: string;
    readonly dimension: number;
    readonly metric?: "cosine" | "l2" | "ip";
}

export interface BuildIndexInput {
    readonly indexName: string;
    readonly metric?: "cosine" | "l2" | "ip";
    readonly indexConfig: { readonly type: "hnsw" };
}

export interface UpsertInput {
    readonly indexName: string;
    readonly vectors: readonly number[][];
    readonly metadata?: readonly Record<string, unknown>[];
    readonly ids?: readonly string[];
}

/**
 * A narrow delete surface: every entry of one index whose metadata `type` is named.
 *
 * `type` is the only dimension a caller may delete along, deliberately. The index holds
 * several independently-owned tiers in one table, and a writer rebuilding its own tier
 * has to be unable to reach another's — a general predicate would make that a review
 * question rather than a type error.
 */
export interface DeleteByTypeInput {
    readonly indexName: string;
    readonly types: readonly string[];
}

export interface QueryInput {
    readonly indexName: string;
    readonly queryVector: readonly number[];
    readonly topK: number;
    readonly filter?: Record<string, unknown>;
}

export interface QueryResult {
    readonly id: string;
    readonly score: number;
    readonly metadata: Record<string, unknown>;
}

export interface VectorStore {
    createIndex(input: CreateIndexInput): ResultAsync<void, DbError>;
    buildIndex(input: BuildIndexInput): ResultAsync<void, DbError>;
    upsert(input: UpsertInput): ResultAsync<void, DbError>;
    deleteByType(input: DeleteByTypeInput): ResultAsync<void, DbError>;
    query(input: QueryInput): ResultAsync<QueryResult[], DbError>;
}

function assertIdent(name: string): void {
    if (!isSqlIdentifier(name)) {
        throw new Error(`vector-store: unsafe index name "${name}"`);
    }
}

function toVectorLiteral(v: readonly number[]): string {
    return `[${v.join(",")}]`;
}

export function createVectorStore(pool: Pool): VectorStore {
    return {
        createIndex({ indexName, dimension }) {
            assertIdent(indexName);
            return tryMutation("vectorStore.createIndex", async () => {
                await pool.query(
                    `CREATE TABLE IF NOT EXISTS "${indexName}" (
             id SERIAL PRIMARY KEY,
             vector_id TEXT UNIQUE NOT NULL,
             embedding vector(${dimension}),
             metadata JSONB DEFAULT '{}'::jsonb
           )`,
                );
            });
        },

        buildIndex({ indexName, indexConfig }) {
            assertIdent(indexName);
            if (indexConfig.type !== "hnsw") {
                throw new Error(`vector-store: unsupported index type "${indexConfig.type}"`);
            }
            // m/ef_construction default to 8/32.
            return tryMutation("vectorStore.buildIndex", async () => {
                await pool.query(
                    `CREATE INDEX IF NOT EXISTS "${indexName}_vector_idx"
           ON "${indexName}"
           USING hnsw (embedding vector_cosine_ops)
           WITH (m = 8, ef_construction = 32)`,
                );
            });
        },

        upsert({ indexName, vectors, metadata, ids }) {
            assertIdent(indexName);
            if (vectors.length === 0) return okAsync(undefined);
            const finalIds = ids ?? vectors.map(() => crypto.randomUUID());
            return tryMutation("vectorStore.upsert", async () => {
                for (let i = 0; i < vectors.length; i++) {
                    const vec = toVectorLiteral(vectors[i]!);
                    const meta = JSON.stringify(metadata?.[i] ?? {});
                    await pool.query(
                        `INSERT INTO "${indexName}" (vector_id, embedding, metadata)
             VALUES ($1, $2::vector, $3::jsonb)
             ON CONFLICT (vector_id)
             DO UPDATE SET embedding = $2::vector, metadata = $3::jsonb`,
                        [finalIds[i], vec, meta],
                    );
                }
            });
        },

        deleteByType({ indexName, types }) {
            assertIdent(indexName);
            if (types.length === 0) return okAsync(undefined);
            return tryMutation("vectorStore.deleteByType", async () => {
                await pool.query(`DELETE FROM "${indexName}" WHERE metadata->>'type' = ANY($1::text[])`, [[...types]]);
            });
        },

        query({ indexName, queryVector, topK, filter }) {
            assertIdent(indexName);
            const literal = toVectorLiteral(queryVector);
            const values: unknown[] = [literal, topK];
            let where = "";
            if (filter && Object.keys(filter).length > 0) {
                values.push(JSON.stringify(filter));
                where = `WHERE metadata @> $3::jsonb`;
            }
            return tryQuery("vectorStore.query", async () => {
                const result = await pool.query<{
                    id: string;
                    score: number;
                    metadata: Record<string, unknown>;
                }>(
                    `SELECT vector_id AS id,
                  1 - (embedding <=> $1::vector) AS score,
                  metadata
           FROM "${indexName}"
           ${where}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
                    values,
                );
                return result.rows;
            });
        },
    };
}
