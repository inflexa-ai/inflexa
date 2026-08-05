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
        "Search arXiv for preprints in ML, physics, math, control theory, " +
        "economics, and related quantitative fields. Returns id, title, " +
        "abstract, authors, publication date, arXiv categories, and URLs.",
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
