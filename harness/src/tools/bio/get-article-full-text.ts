/**
 * getArticleFullText — fetch full text of open-access articles from PMC.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import type { ArticleSection } from "../lib/ncbi-utils.js";
import { getArticleFullText } from "../lib/pubmed-client.js";

type FullTextResult = { pmcId: string; available: false } | { pmcId: string; available: true; fullText: string; sections: ArticleSection[] };

export function createGetArticleFullTextTool(deps: { ncbiApiKey?: string }) {
    return defineTool({
        id: "get_article_full_text",
        description:
            "Fetch the full text of an open-access article from PubMed Central (PMC). " +
            "Accepts a PMC ID (e.g., 'PMC1234567') as returned by getArticleDetails. " +
            "Returns the article body as plain text with section headers preserved. " +
            "Only works for open-access articles available in PMC — check the pmcId " +
            "field from getArticleDetails before calling this tool.",
        inputSchema: z.object({
            pmcId: z.string().describe('PubMed Central ID (e.g., "PMC1234567")'),
        }),
        execute: async ({ pmcId }) => {
            const parsed = await getArticleFullText(deps.ncbiApiKey, pmcId);
            // "Not open-access" is an expected outcome — a data variant, not an error.
            if (!parsed) return ok<FullTextResult>({ pmcId, available: false });
            return ok<FullTextResult>({
                pmcId,
                available: true,
                fullText: parsed.fullText,
                sections: parsed.sections,
            });
        },
    });
}
