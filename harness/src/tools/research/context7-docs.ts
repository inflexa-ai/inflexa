/**
 * Context7 documentation lookup tools for sandbox agents.
 *
 * Wraps the Context7 REST API to let agents look up current package
 * documentation and code examples at runtime. Two-step flow:
 * 1. resolveLibraryId — find the Context7 library ID for a package name
 * 2. queryDocs — query documentation for a resolved library
 *
 * Absence policy: the OpenAPI document of Context7 marks no field as nullable,
 * and the sampled payloads carry no explicit `null`. Thus an absent value is an
 * omitted key, and a maybe-absent field carries `.optional()`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";

const CONTEXT7_BASE = "https://context7.com/api/v1";

type ResolveLibraryIdOutput = { found: false } | { found: true; libraryId: string; name: string; description: string };

type QueryDocsOutput = { found: false } | { found: true; documentation: string };

// Raw Context7 wire shapes, validated at the fetch boundary. `id`/`title` stay
// required — they are read without a guard — while genuinely-optional fields
// carry `.optional()` so a partial-but-valid response still parses.
export const Context7SearchResponseSchema = z.object({
    results: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().nullable().optional() })).optional(),
});

// The docs route answers one `snippets` array, and each snippet holds its code in
// `codeList`. There is no single documentation text on the wire, thus the tool
// composes one from the snippets below.
export const Context7DocsResponseSchema = z.object({
    snippets: z.array(
        z.object({
            codeTitle: z.string(),
            codeDescription: z.string(),
            codeId: z.string(),
            codeList: z.array(z.object({ language: z.string(), code: z.string() })),
        }),
    ),
});

type Context7Snippet = z.infer<typeof Context7DocsResponseSchema>["snippets"][number];

/** Render the snippets of one docs answer as a single text, in the layout of the Context7 text route. */
function renderSnippets(snippets: Context7Snippet[]): string {
    return snippets
        .map((snippet) => {
            const code = snippet.codeList.map((example) => `\`\`\`${example.language}\n${example.code}\n\`\`\``).join("\n\n");
            return `### ${snippet.codeTitle}\n\nSource: ${snippet.codeId}\n\n${snippet.codeDescription}\n\n${code}`;
        })
        .join("\n\n--------------------------------\n\n");
}

export const resolveLibraryIdTool = defineTool({
    id: "resolve_library_id",
    description:
        "Resolve a package name (e.g., 'scanpy', 'DESeq2', 'scikit-learn') to a Context7 library ID. Call this BEFORE `query_docs` to get the library ID needed for documentation lookup. Returns matching libraries ranked by relevance.",
    inputSchema: z.object({
        libraryName: z.string().describe("Package or library name to search for (e.g., 'scanpy', 'pysam', 'lifelines')."),
        query: z.string().describe("What you need help with — used to rank results by relevance (e.g., 'how to run differential expression')."),
    }),
    describeCall: "none",
    execute: async ({ libraryName, query }): Promise<Result<ResolveLibraryIdOutput, ToolError>> => {
        const result = await apiFetchValidated(
            `${CONTEXT7_BASE}/search?query=${encodeURIComponent(libraryName)}&topic=${encodeURIComponent(query)}`,
            Context7SearchResponseSchema,
            { maxRetries: 1 },
        );

        if (result.isErr()) throw new Error(`Context7 search failed: ${describeApiError(result.error)}`);

        const best = (result.value.results ?? [])[0];
        // No match is an expected outcome — a `found: false` data variant.
        if (!best) return ok({ found: false as const });

        return ok({
            found: true as const,
            libraryId: best.id,
            // The display name of a library is `title` on the wire. The output keeps
            // the `name` key, because that key is the contract that a caller reads.
            name: best.title,
            description: best.description ?? "",
        });
    },
});

export const queryDocsTool = defineTool({
    id: "query_docs",
    description:
        "Query up-to-date documentation and code examples for a library. You must call `resolve_library_id` first to get the libraryId. Use this to verify function signatures, parameters, and usage patterns before writing code.",
    inputSchema: z.object({
        libraryId: z.string().describe("Context7 library ID exactly as `resolve_library_id` gave it — an owner and a library, for example '/scverse/scanpy'."),
        query: z.string().describe("Specific question about the library (e.g., 'rank_genes_groups function parameters and usage')."),
    }),
    describeCall: "none",
    execute: async ({ libraryId, query }): Promise<Result<QueryDocsOutput, ToolError>> => {
        // The library id is the path of the route, not a query parameter. Each
        // segment is encoded on its own, thus the separators of the id survive and
        // a leading or trailing slash makes no difference.
        const path = libraryId
            .split("/")
            .filter((segment) => segment !== "")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
        const result = await apiFetchValidated(`${CONTEXT7_BASE}/${path}?type=json&topic=${encodeURIComponent(query)}`, Context7DocsResponseSchema, {
            maxRetries: 1,
        });

        if (result.isErr()) {
            // Context7 answers 404 for a library that it does not hold. A stale id is
            // an expected outcome, thus it becomes a data variant.
            if (result.error.type === "http_status" && result.error.status === 404) return ok({ found: false as const });
            throw new Error(`Context7 query failed: ${describeApiError(result.error)}`);
        }

        const documentation = renderSnippets(result.value.snippets);
        // No documentation for the query is an expected outcome.
        if (!documentation) return ok({ found: false as const });

        return ok({ found: true as const, documentation });
    },
});
