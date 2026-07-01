/**
 * Search Semantic Scholar Graph API for academic papers across all
 * sciences. No API key required; rate-limited but reasonable for agent
 * use. Used by the analogical-reasoner for cross-domain analogical search.
 *
 * Same wire call and envelope as the legacy tool, packaged as `defineTool`.
 * Stateless HTTP; no deps.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";

const BASE_URL = "https://api.semanticscholar.org/graph/v1";
const DEFAULT_FIELDS = "paperId,title,abstract,year,venue,citationCount,url,authors,externalIds";

export interface SemanticScholarPaper {
    id: string;
    title: string;
    abstract?: string;
    year?: number;
    venue?: string;
    citationCount?: number;
    url?: string;
    authors: string[];
    externalIds?: Record<string, string>;
}

type SearchSemanticScholarOutput = { success: false; error: string; papers: SemanticScholarPaper[] } | { success: true; papers: SemanticScholarPaper[] };

export function parseSemanticScholarResponse(raw: unknown): SemanticScholarPaper[] {
    const data = (raw as { data?: unknown[] } | undefined)?.data;
    if (!Array.isArray(data)) return [];
    return data
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null && "paperId" in p && "title" in p)
        .map((p) => {
            const authors = Array.isArray(p.authors)
                ? (p.authors as Array<{ name?: unknown }>).map((a) => a?.name).filter((n): n is string => typeof n === "string")
                : [];
            return {
                id: String(p.paperId),
                title: String(p.title),
                abstract: typeof p.abstract === "string" ? p.abstract : undefined,
                year: typeof p.year === "number" ? p.year : undefined,
                venue: typeof p.venue === "string" ? p.venue : undefined,
                citationCount: typeof p.citationCount === "number" ? p.citationCount : undefined,
                url: typeof p.url === "string" ? p.url : undefined,
                authors,
                externalIds: p.externalIds && typeof p.externalIds === "object" ? (p.externalIds as Record<string, string>) : undefined,
            } satisfies SemanticScholarPaper;
        });
}

export const searchSemanticScholarTool = defineTool({
    id: "search_semantic_scholar",
    description:
        "Search Semantic Scholar for academic papers across all sciences " +
        "(biology, ML, physics, math, economics, engineering, etc.). Returns " +
        "paper id, title, abstract, year, venue, citation count, authors, and " +
        "external IDs (DOI, ArXiv). Best for cross-domain analogical search.",
    inputSchema: z.object({
        query: z
            .string()
            .describe(
                "Free-text query. Use natural language phrases such as " + '"reinforcement learning for control" or "feedback stabilisation in oscillators".',
            ),
        limit: z.number().int().min(1).max(20).default(10).describe("Maximum number of results to return (1–20, default 10)."),
    }),
    execute: async ({ query, limit }): Promise<Result<SearchSemanticScholarOutput, ToolError>> => {
        const params = new URLSearchParams({
            query,
            limit: String(limit),
            fields: DEFAULT_FIELDS,
        });
        const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
        const headers: Record<string, string> = {};
        if (apiKey) headers["x-api-key"] = apiKey;
        const res = await apiFetch<unknown>(`${BASE_URL}/paper/search?${params}`, {
            headers,
        });
        if (res.isErr()) {
            return ok({ success: false as const, error: describeApiError(res.error), papers: [] });
        }
        return ok({
            success: true as const,
            papers: parseSemanticScholarResponse(res.value),
        });
    },
});
