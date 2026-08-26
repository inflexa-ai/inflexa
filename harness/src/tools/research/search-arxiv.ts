/** Search arXiv for preprints through the shared authority client. */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { createArxivSource, type ArxivPaper } from "../../literature/sources/arxiv.js";
import { defineTool, type ToolError } from "../define-tool.js";

export { parseArxivAtom, type ArxivPaper } from "../../literature/sources/arxiv.js";

type SearchArxivOutput = { success: false; error: string; papers: ArxivPaper[] } | { success: true; papers: ArxivPaper[] };

const source = createArxivSource({ maxRetries: 3, retryDelayMs: 1_000, timeoutMs: 90_000 });

export const searchArxivTool = defineTool({
    id: "search_arxiv",
    description:
        "Search arXiv — the open preprint server of Cornell University — for work in machine learning, physics, math, quantitative biology, control " +
        "theory, economics and the related quantitative fields. Returns id, title, abstract, authors, publication date, arXiv categories, and URLs.\n" +
        "It carries PREPRINTS, thus a paper here may not be peer reviewed, and it is where a method appears months before a journal holds it. For the " +
        "clinical and biomedical literature use pubmed, which indexes MEDLINE; for cross-domain coverage of any field use search_semantic_scholar.\n" +
        "ACCEPTED IDENTIFIERS: free text in `query`, and arXiv category codes in `categories` ('cs.LG', 'q-bio.GN', 'math.OC'). An arXiv ID " +
        "('2301.00001') also matches as free text.\n" +
        "ABSENCE IS NORMAL: an empty papers array means arXiv holds nothing for the query, and `success: false` with an `error` string means the service " +
        "could not be reached. Report either one and continue, do not retry unchanged.",
    inputSchema: z.object({
        query: z.string().describe('Free-text query. Example: "adaptive control feedback stabilization".'),
        categories: z
            .array(z.string())
            .optional()
            .describe('Optional arXiv category filters (e.g., ["cs.LG", "math.OC"]). ' + "Combined with the query using AND."),
        limit: z.number().int().min(1).max(20).default(10).describe("Maximum results (1–20, default 10)."),
    }),
    describeCall: "none",
    execute: async ({ query, categories, limit }, context): Promise<Result<SearchArxivOutput, ToolError>> => {
        const result = await source.search({ query, ...(categories === undefined ? {} : { categories }), limit }, context.signal);
        if (result.status !== "ok") return ok({ success: false as const, error: result.detail, papers: [] });
        return ok({ success: true as const, papers: result.value });
    },
});
