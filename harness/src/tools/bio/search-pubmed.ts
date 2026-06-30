/**
 * searchPubMed — search PubMed via NCBI E-utilities.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchPubmed } from "../lib/pubmed-client.js";

export function createSearchPubMedTool(deps: { ncbiApiKey?: string }) {
    return defineTool({
        id: "search_pubmed",
        description:
            "Search PubMed for scientific articles using NCBI E-utilities. " +
            "The query uses PubMed search syntax — use MeSH terms (e.g., " +
            '"breast neoplasms"[MeSH]), field tags ([Title/Abstract], [Author], [Gene]), ' +
            "and Boolean operators (AND, OR, NOT). " +
            'Example: "BRCA1"[Gene] AND "breast neoplasms"[MeSH] AND "drug resistance"[Title/Abstract]. ' +
            "Returns PMIDs, titles, journal names, publication years, and author summaries.",
        inputSchema: z.object({
            query: z.string().describe("PubMed search query. Supports MeSH terms, field tags, and Boolean operators."),
            maxResults: z.number().int().min(1).max(50).default(10).describe("Maximum number of results to return (1–50, default 10)"),
            sort: z.enum(["relevance", "date"]).default("relevance").describe('Sort order: "relevance" or "date" (default "relevance")'),
            dateRange: z
                .object({
                    from: z.string().describe("Start date in YYYY/MM/DD format"),
                    to: z.string().describe("End date in YYYY/MM/DD format"),
                })
                .optional()
                .describe("Optional date range filter"),
        }),
        execute: async ({ query, maxResults, sort, dateRange }) => ok(await searchPubmed(deps.ncbiApiKey, query, { maxResults, sort, dateRange })),
    });
}
