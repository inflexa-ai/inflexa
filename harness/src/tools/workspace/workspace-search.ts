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
import type { QueryConfig } from "pg";
import { z } from "zod";

import type { EmbeddingProvider } from "../../providers/types.js";
import { scopeResource } from "../../auth/types.js";
import { tryQuery } from "../../lib/db-result.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { defineTool, type Tool } from "../define-tool.js";

/** pgvector / Postgres "undefined_table" — the index has no rows indexed yet. */
const UNDEFINED_TABLE = "42P01";

/** True when a captured driver cause is the "undefined_table" SQLSTATE. */
const UndefinedTableCause = z.object({ code: z.literal(UNDEFINED_TABLE) });

function isUndefinedTable(cause: unknown): boolean {
    return UndefinedTableCause.safeParse(cause).success;
}

function indexName(analysisId: string): string {
    const name = `search_${analysisId.replaceAll("-", "_")}`;
    if (!isSqlIdentifier(name)) {
        throw new Error(`workspaceSearch: unusable analysis id "${analysisId}"`);
    }
    return name;
}

function isSqlIdentifier(name: string): boolean {
    if (name.length === 0) return false;
    const isLetterOrUnderscore = (char: string): boolean => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
    const isWordChar = (char: string): boolean => isLetterOrUnderscore(char) || (char >= "0" && char <= "9");
    return isLetterOrUnderscore(name.charAt(0)) && Array.from(name).every(isWordChar);
}

/** Entry types that address a pattern spanning many files, never a single one. */
const PATTERN_TYPES = new Set(["input-group", "input-dimension", "input-kind"]);

/**
 * The workspace path a hit addresses, or `undefined` for a pattern entry. Resolved here,
 * once, across every index era — group/dimension/kind entries and previous-era entity
 * entries (`entity` in metadata) are patterns; everything else is a file whose path is
 * stamped in metadata or, on rows older than the stamp, is the id minus the resource
 * segment. The consumer branches on presence, nothing else.
 */
export function fileTargetOf(id: string, metadata: unknown): string | undefined {
    const meta = parseUnknownRecord(metadata) ?? {};
    const type = typeof meta.type === "string" ? meta.type : undefined;
    if (type !== undefined && PATTERN_TYPES.has(type)) return undefined;
    if (type === "input" && meta.entity !== undefined) return undefined;
    if (typeof meta.path === "string") return meta.path;
    if (!id.startsWith("/")) return id;
    const afterResource = id.indexOf("/", 1);
    return afterResource === -1 ? id : id.slice(afterResource + 1);
}

/** One search-hit row, as the pgvector SELECT returns it. */
type SearchHitRow = { id: string; score: number; metadata: unknown };

/** One ranked entry the tool returns: the row plus the workspace path it addresses. */
type WorkspaceSearchHit = { id: string; score: number; path: string | undefined; metadata: unknown };

type WorkspaceSearchOutput = { results: WorkspaceSearchHit[] };

const WorkspaceSearchInputSchema = z.object({
    query: z.string().min(1).describe("What to search for, in natural language"),
    type: z
        .enum(["input-group", "input-dimension", "input", "input-kind", "output", "summary", "synthesis"])
        .optional()
        .describe('Restrict results to one entry type: "input-group", "input-dimension", "input", "input-kind", "output", "summary", or "synthesis"'),
    limit: z.number().int().min(1).max(50).default(8).describe("Maximum number of results to return"),
});

/** What the workspace search reads of the pool: its one row-reading query. A real `Pool` satisfies it. */
export type WorkspaceSearchQuerier = {
    query(queryTextOrConfig: string | QueryConfig, values?: unknown[]): Promise<{ rows: SearchHitRow[]; rowCount: number | null }>;
};

export function createWorkspaceSearchTool(
    pool: WorkspaceSearchQuerier,
    embedding: EmbeddingProvider,
): Tool<z.infer<typeof WorkspaceSearchInputSchema>, WorkspaceSearchOutput> {
    return defineTool({
        id: "workspace_search",
        description:
            "Semantic search over the analysis workspace. Returns ranked entries with descriptions " +
            "and metadata; read a file separately to see its contents. The nearest entries always come back, up to " +
            "`limit`, with no relevance cut: `score` is the cosine similarity to the query, and a low score is a weak match, " +
            "not a hit. An empty `results` list means that nothing of that type is indexed yet. `type` restricts results to one " +
            'entry type: "input-group" (a GROUP of input data the data profiler declared, carrying its ' +
            'derived count, its display pattern, and its slots), "input-dimension" (something that VARIES ' +
            "across the dataset — subject, timepoint, batch — with the observations evidencing it), " +
            '"input" (one input file the profiler annotated individually, or, on a profile of the ' +
            'previous era, one entity the dataset is about), "output" (files a step produced), ' +
            '"summary" (a step\'s summary), "synthesis" (a run\'s literature-grounded synthesis), ' +
            '"input-kind" (a repeating set, on a profile of the previous era). ' +
            "A hit carrying `path` is a FILE — read that path to see its contents. A hit without " +
            "`path` is a PATTERN spanning many files (a group, a dimension, an entity): use its " +
            "metadata, e.g. search input-group for a group's display pattern, then list the tree for " +
            "its members. Most input files carry no entry of their own — find them through their " +
            "group and the listing tools.",
        inputSchema: WorkspaceSearchInputSchema,
        describeCall: ({ query, type }) => (type === undefined ? query : `${query} (${type})`),
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
                    const result = await pool.query(
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
                results: rows.map((r) => {
                    const path = fileTargetOf(r.id, r.metadata);
                    return {
                        id: r.id,
                        score: r.score,
                        path,
                        metadata: r.metadata,
                    };
                }),
            });
        },
    });
}
