/** Search Semantic Scholar through the shared authority client. */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { createSemanticScholarSource, type SemanticScholarSearchPaper } from "../../literature/sources/semantic-scholar.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

export { parseSemanticScholarResponse } from "../../literature/sources/semantic-scholar.js";
export type SemanticScholarPaper = SemanticScholarSearchPaper;

type SearchSemanticScholarOutput =
    { success: false; error: string; papers: SemanticScholarSearchPaper[] } | { success: true; papers: SemanticScholarSearchPaper[] };

export function createSearchSemanticScholarTool(options: { readonly apiKey?: string } = {}): Tool {
    const source = createSemanticScholarSource({
        maxRetries: 3,
        retryDelayMs: 1_000,
        timeoutMs: 90_000,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    });
    return defineTool({
        id: "search_semantic_scholar",
        description:
            "Search Semantic Scholar — the cross-disciplinary literature corpus of the Allen Institute for AI, which indexes over 200M papers across " +
            "biology, medicine, machine learning, physics, math, economics and engineering. Returns paper id, title, abstract, year, venue, citation " +
            "count, authors, and external IDs (DOI, arXiv). Its citation counts are what rank a field by influence, and its breadth is what makes it the " +
            "tool for a cross-domain analogical search.\n" +
            "For the clinical and biomedical literature alone, pubmed indexes MEDLINE more precisely; for preprints in the quantitative fields use " +
            "search_arxiv.\n" +
            "ACCEPTED IDENTIFIERS: free text in `query`. A DOI or an arXiv ID also matches as free text, and each result carries its DOI and arXiv ID " +
            "back for a citation.\n" +
            "ABSENCE IS NORMAL: an empty papers array means the corpus holds nothing for the query, and `success: false` with an `error` string means the " +
            "service could not be reached (its unkeyed rate limit lands here). Report either one and continue, do not retry unchanged.",
        inputSchema: z.object({
            query: z
                .string()
                .describe(
                    "Free-text query. Use natural language phrases such as " +
                        '"reinforcement learning for control" or "feedback stabilisation in oscillators".',
                ),
            limit: z.number().int().min(1).max(20).default(10).describe("Maximum number of results to return (1–20, default 10)."),
        }),
        describeCall: "none",
        execute: async ({ query, limit }, context): Promise<Result<SearchSemanticScholarOutput, ToolError>> => {
            const result = await source.search(query, limit, context.signal);
            if (result.status !== "ok") return ok({ success: false as const, error: result.detail, papers: [] });
            return ok({ success: true as const, papers: result.value });
        },
    });
}
