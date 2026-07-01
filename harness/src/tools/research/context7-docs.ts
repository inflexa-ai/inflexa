/**
 * Context7 documentation lookup tools for sandbox agents.
 *
 * Wraps the Context7 REST API to let agents look up current package
 * documentation and code examples at runtime. Two-step flow:
 * 1. resolveLibraryId — find the Context7 library ID for a package name
 * 2. queryDocs — query documentation for a resolved library
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";

const CONTEXT7_BASE = "https://context7.com/api/v1";

type ResolveLibraryIdOutput = { found: false } | { found: true; libraryId: string; name: string; description: string };

type QueryDocsOutput = { found: false } | { found: true; documentation: string };

export const resolveLibraryIdTool = defineTool({
    id: "resolve_library_id",
    description:
        "Resolve a package name (e.g., 'scanpy', 'DESeq2', 'scikit-learn') to a Context7 library ID. Call this BEFORE queryDocs to get the library ID needed for documentation lookup. Returns matching libraries ranked by relevance.",
    inputSchema: z.object({
        libraryName: z.string().describe("Package or library name to search for (e.g., 'scanpy', 'pysam', 'lifelines')."),
        query: z.string().describe("What you need help with — used to rank results by relevance (e.g., 'how to run differential expression')."),
    }),
    execute: async ({ libraryName, query }): Promise<Result<ResolveLibraryIdOutput, ToolError>> => {
        const result = await apiFetch<{
            results?: Array<{ id: string; name: string; description?: string }>;
        }>(`${CONTEXT7_BASE}/search?query=${encodeURIComponent(libraryName)}&topic=${encodeURIComponent(query)}`, { maxRetries: 1 });

        if (result.isErr()) throw new Error(`Context7 search failed: ${describeApiError(result.error)}`);

        const best = (result.value.results ?? [])[0];
        // No match is an expected outcome — a `found: false` data variant.
        if (!best) return ok({ found: false as const });

        return ok({
            found: true as const,
            libraryId: best.id,
            name: best.name,
            description: best.description ?? "",
        });
    },
});

export const queryDocsTool = defineTool({
    id: "query_docs",
    description:
        "Query up-to-date documentation and code examples for a library. You must call resolve-library-id first to get the libraryId. Use this to verify function signatures, parameters, and usage patterns before writing code.",
    inputSchema: z.object({
        libraryId: z.string().describe("Context7 library ID from resolve-library-id (e.g., '/scverse/scanpy')."),
        query: z.string().describe("Specific question about the library (e.g., 'rank_genes_groups function parameters and usage')."),
    }),
    execute: async ({ libraryId, query }): Promise<Result<QueryDocsOutput, ToolError>> => {
        const result = await apiFetch<{ content?: string }>(
            `${CONTEXT7_BASE}/docs?libraryId=${encodeURIComponent(libraryId)}&query=${encodeURIComponent(query)}`,
            { maxRetries: 1 },
        );

        if (result.isErr()) throw new Error(`Context7 query failed: ${describeApiError(result.error)}`);

        const documentation = result.value.content ?? "";
        // No documentation for the query is an expected outcome.
        if (!documentation) return ok({ found: false as const });

        return ok({ found: true as const, documentation });
    },
});
