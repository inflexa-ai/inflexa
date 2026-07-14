/**
 * pubmed — one tool over PubMed and PubMed Central (NCBI E-utilities):
 * search the literature, fetch article metadata, and read the full text of an
 * open-access article.
 *
 * Dependency-bearing: the optional NCBI API key is captured by the factory.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`). Each action's required argument is optional
 * in the schema and enforced by `.refine`, so a malformed call (e.g. 'fulltext'
 * with no pmcId) fails at the loop boundary and surfaces as an `is_error` tool
 * result instead of reaching NCBI.
 *
 * The three actions form one retrieval chain — search yields PMIDs, details
 * turns PMIDs into abstracts + the PMC id, fulltext turns a PMC id into the
 * article body — which is why they share a tool: the identifier for each step
 * is read off the previous step's result.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import type { ArticleSection } from "../lib/ncbi-utils.js";
import { getArticleDetails, getArticleFullText, searchPubmed, type ArticleDetail, type PubMedSummary } from "../lib/pubmed-client.js";

const inputSchema = z
    .object({
        action: z
            .enum(["search", "details", "fulltext"])
            .describe(
                "'search' (needs query) — returns totalFound plus, per hit, PMID, title, journal, year and an author summary. " +
                    "'details' (needs pmids, max 20 per call) — each article's full abstract, authors, journal, year, DOI, MeSH terms, and " +
                    "pmcId (non-null only when open-access full text exists in PubMed Central). " +
                    "'fulltext' (needs pmcId, taken from a 'details' result) — the body of ONE open-access PMC article as plain text with " +
                    "section headers preserved; available: false when the article is not open-access.",
            ),
        query: z
            .string()
            .optional()
            .describe(
                "Required for action 'search'. PubMed query syntax — MeSH terms (\"breast neoplasms\"[MeSH]), field tags " +
                    '([Title/Abstract], [Author], [Gene]), Boolean AND/OR/NOT. Example: "BRCA1"[Gene] AND "drug resistance"[Title/Abstract].',
            ),
        maxResults: z.number().int().min(1).max(50).default(10).optional().describe("action 'search': max results, 1–50 (default 10)."),
        sort: z.enum(["relevance", "date"]).default("relevance").optional().describe("action 'search': sort order (default \"relevance\")."),
        dateRange: z
            .object({
                from: z.string().describe("Start date in YYYY/MM/DD format"),
                to: z.string().describe("End date in YYYY/MM/DD format"),
            })
            .optional()
            .describe("action 'search': optional publication date range filter."),
        pmids: z
            .array(z.string())
            .min(1)
            .max(20)
            .optional()
            .describe("Required for action 'details'. Non-empty array of PMID strings, max 20 — batch them, do not call once per PMID."),
        pmcId: z.string().optional().describe("Required for action 'fulltext'. A PMC ID (e.g. \"PMC1234567\") copied from a 'details' result — not a PMID."),
    })
    .refine((d) => d.action !== "search" || (d.query !== undefined && d.query.trim().length > 0), {
        message: "query is required when action is 'search'",
        path: ["query"],
    })
    .refine((d) => d.action !== "details" || (d.pmids !== undefined && d.pmids.length > 0), {
        message: "pmids is required when action is 'details' — pass a non-empty array of PMID strings (max 20), copied from a 'search' result",
        path: ["pmids"],
    })
    .refine((d) => d.action !== "fulltext" || (d.pmcId !== undefined && d.pmcId.trim().length > 0), {
        message: "pmcId is required when action is 'fulltext' — copy it from the pmcId field of a 'details' result; a PMID is not a PMC ID",
        path: ["pmcId"],
    });

type PubMedOutput =
    | { totalFound: number; results: PubMedSummary[] }
    | { articles: ArticleDetail[]; notFound: string[] }
    | { pmcId: string; available: false }
    | { pmcId: string; available: true; fullText: string; sections: ArticleSection[] };

export function createPubMedTool(deps: { ncbiApiKey?: string }) {
    return defineTool({
        id: "pubmed",
        description:
            "Search and read the biomedical literature via PubMed / PubMed Central (NCBI E-utilities). The three actions form a chain " +
            "— search, then details on the relevant hits, then fulltext; see the action parameter for what each needs and returns. Read " +
            "fulltext sparingly — only where the 'details' abstract is not enough, and only for articles that have a pmcId (open-access). " +
            "available: false is an expected outcome, not an error — do not retry it.",
        inputSchema,
        execute: async (input): Promise<Result<PubMedOutput, ToolError>> => {
            switch (input.action) {
                case "search":
                    return ok(
                        await searchPubmed(deps.ncbiApiKey, input.query!, {
                            maxResults: input.maxResults,
                            sort: input.sort,
                            dateRange: input.dateRange,
                        }),
                    );
                case "details":
                    return ok(await getArticleDetails(deps.ncbiApiKey, input.pmids!));
                case "fulltext": {
                    const parsed = await getArticleFullText(deps.ncbiApiKey, input.pmcId!);
                    // "Not open-access" is an expected outcome — a data variant, not an error.
                    if (!parsed) return ok({ pmcId: input.pmcId!, available: false as const });
                    return ok({
                        pmcId: input.pmcId!,
                        available: true as const,
                        fullText: parsed.fullText,
                        sections: parsed.sections,
                    });
                }
            }
        },
    });
}
