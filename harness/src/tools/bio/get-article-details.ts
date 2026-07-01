/**
 * getArticleDetails — fetch detailed metadata for PubMed articles.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getArticleDetails } from "../lib/pubmed-client.js";

export function createGetArticleDetailsTool(deps: { ncbiApiKey?: string }) {
    return defineTool({
        id: "get_article_details",
        description:
            "Fetch detailed metadata for PubMed articles by PMID. " +
            "Returns title, full abstract, authors, journal, year, DOI, MeSH terms, " +
            "and PMC ID (if open-access full text is available in PubMed Central). " +
            "Accepts up to 20 PMIDs per call for batch retrieval.",
        inputSchema: z.object({
            pmids: z.array(z.string()).min(1).max(20).describe("PubMed IDs to fetch details for (max 20)"),
        }),
        execute: async ({ pmids }) => ok(await getArticleDetails(deps.ncbiApiKey, pmids)),
    });
}
