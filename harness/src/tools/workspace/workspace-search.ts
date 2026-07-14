/**
 * workspaceSearch tool — vector semantic search over the analysis workspace.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): the pgvector `Pool` and the
 * `EmbeddingProvider` are captured at construction; `execute` closes over
 * them — no ambient lookups, no global pool accessor.
 *
 * The per-analysis index is the `search_{analysisId}` table written by the
 * workflow's write-time indexing. A query embeds the search text and ranks
 * rows by cosine similarity. "Nothing indexed yet" (the index table does not
 * exist) is an expected outcome — an empty result list, not an error.
 */

import { err, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import type { EmbeddingProvider } from "../../providers/types.js";
import { scopeResource } from "../../auth/types.js";
import { tryQuery } from "../../lib/db-result.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { defineTool } from "../define-tool.js";

/** pgvector / Postgres "undefined_table" — the index has no rows indexed yet. */
const UNDEFINED_TABLE = "42P01";

/** True when a captured driver cause is the "undefined_table" SQLSTATE. */
function isUndefinedTable(cause: unknown): boolean {
    return !!cause && typeof cause === "object" && (cause as { code?: unknown }).code === UNDEFINED_TABLE;
}

function indexName(analysisId: string): string {
    const name = `search_${analysisId.replace(/-/g, "_")}`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`workspaceSearch: unusable analysis id "${analysisId}"`);
    }
    return name;
}

export function createWorkspaceSearchTool(pool: Pool, embedding: EmbeddingProvider) {
    return defineTool({
        id: "workspace_search",
        description:
            "Semantic search over the analysis workspace. Returns ranked file paths " +
            "with descriptions and metadata; read a file separately to see its " +
            "contents. Indexed entries are exactly four types, and `type` restricts " +
            'results to one of them: "input" (staged input data files — their ' +
            'descriptions come from the data profiler), "output" (files a step ' +
            'produced), "summary" (a step\'s summary), "synthesis" (a run\'s ' +
            "literature-grounded synthesis).",
        inputSchema: z.object({
            query: z.string().min(1).describe("What to search for, in natural language"),
            type: z
                .enum(["input", "output", "summary", "synthesis"])
                .optional()
                .describe('Restrict results to one entry type: "input", "output", "summary", or "synthesis"'),
            limit: z.number().int().min(1).max(50).default(8).describe("Maximum number of results to return"),
        }),
        execute: async ({ query, type, limit }, ctx) => {
            const [vector] = unwrapOrThrow(await embedding.embed([query], ctx.session));
            if (!vector) return ok({ results: [] });

            const table = indexName(scopeResource(ctx.session.scope).resourceId);
            const literal = `[${vector.join(",")}]`;
            const values: unknown[] = [literal, limit];
            let filter = "";
            if (type) {
                values.push(type);
                filter = `WHERE metadata->>'type' = $3`;
            }

            const rows = unwrapOrThrow(
                await tryQuery("workspaceSearch.query", async () => {
                    const result = await pool.query<{
                        id: string;
                        score: number;
                        metadata: unknown;
                    }>(
                        `SELECT vector_id AS id,
                    1 - (embedding <=> $1::vector) AS score,
                    metadata
             FROM "${table}"
             ${filter}
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
                        values,
                    );
                    return result.rows;
                }).orElse((e) =>
                    // "Nothing indexed yet" — the per-analysis index table does not
                    // exist. That is absence, not a failure: recover into ok([]).
                    isUndefinedTable(e.cause) ? okAsync([]) : err(e),
                ),
            );
            return ok({
                results: rows.map((r) => ({
                    id: r.id,
                    score: r.score,
                    metadata: r.metadata,
                })),
            });
        },
    });
}
