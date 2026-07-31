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
 *
 * Every step is bounded, because this is the tool most able to flood a context:
 * an author list can run to hundreds of names, and one research article parses
 * to 40–80k characters — more than the entire tool surface costs to attach.
 * `details` trims the two unbounded list fields; `fulltext` admits whole
 * sections up to a character budget and always returns the article's full
 * section outline so a follow-up can name what it wants.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    boundArticleDetails,
    getArticleDetails,
    getArticleFullText,
    searchPubmed,
    type BoundedArticleDetail,
    type BoundedFullText,
    type PubMedSummary,
} from "../lib/pubmed-client.js";

const DEFAULTS = { searchResults: 10, maxAuthors: 5, maxMeshTerms: 10, maxChars: 12_000 } as const;

const inputSchema = z
    .object({
        action: z
            .enum(["search", "details", "fulltext"])
            .describe(
                "'search' (needs query) — returns totalFound plus, per hit, PMID, title, journal, year and an author summary. " +
                    "'details' (needs pmids, max 20 per call) — each article's full abstract, journal, year, DOI, pmcId (non-null only when open-access " +
                    "full text exists in PubMed Central), plus the leading authors and MeSH terms with authorCount / meshTermCount giving the true totals. " +
                    "'fulltext' (needs pmcId, taken from a 'details' result) — the body of ONE open-access PMC article as plain text with section headers " +
                    "preserved, trimmed to maxChars; `outline` lists every section with its size and whether it came back, and truncated says whether " +
                    "anything was left out. available: false when the article is not open-access.",
            ),
        query: z
            .string()
            .optional()
            .describe(
                "Required for action 'search'. PubMed query syntax — MeSH terms (\"breast neoplasms\"[MeSH]), field tags " +
                    '([Title/Abstract], [Author], [Gene]), Boolean AND/OR/NOT. Example: "BRCA1"[Gene] AND "drug resistance"[Title/Abstract].',
            ),
        maxResults: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe(`action 'search': max results, 1–50 (default ${DEFAULTS.searchResults}). totalFound reports the true match count regardless.`),
        sort: z.enum(["relevance", "date"]).optional().describe("action 'search': sort order (default \"relevance\")."),
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
            .describe(
                "Required for action 'details'. Non-empty array of PMID strings, max 20 — batch them, do not call once per PMID. Each article returns a " +
                    "FULL abstract, so 20 is a large result; pass the handful you actually intend to read.",
            ),
        maxAuthors: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe(`action 'details': leading authors kept per article (default ${DEFAULTS.maxAuthors}, 0 for none); authorCount gives the true total.`),
        maxMeshTerms: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe(`action 'details': MeSH terms kept per article (default ${DEFAULTS.maxMeshTerms}, 0 for none); meshTermCount gives the true total.`),
        pmcId: z.string().optional().describe("Required for action 'fulltext'. A PMC ID (e.g. \"PMC1234567\") copied from a 'details' result — not a PMID."),
        sections: z
            .array(z.string())
            .optional()
            .describe(
                "action 'fulltext': case-insensitive substring filter on section headings, e.g. ['methods','results']. Omit first to get the outline, " +
                    "then name what you need — far cheaper than raising maxChars.",
            ),
        maxChars: z
            .number()
            .int()
            .min(500)
            .max(200_000)
            .optional()
            .describe(
                `action 'fulltext': character budget across returned section bodies (default ${DEFAULTS.maxChars}). Sections are admitted whole, in ` +
                    "document order, until the budget would be exceeded.",
            ),
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
    })
    .refine((d) => d.action === "fulltext" || (d.sections === undefined && d.maxChars === undefined), {
        message: "sections and maxChars apply to action 'fulltext' only",
        path: ["action"],
    })
    .refine((d) => d.action === "details" || (d.maxAuthors === undefined && d.maxMeshTerms === undefined), {
        message: "maxAuthors and maxMeshTerms apply to action 'details' only",
        path: ["action"],
    });

type PubMedOutput =
    | { totalFound: number; results: PubMedSummary[] }
    | { articles: BoundedArticleDetail[]; notFound: string[] }
    | { pmcId: string; available: false }
    | ({ pmcId: string; available: true } & BoundedFullText);

export function createPubMedTool(deps: { ncbiApiKey?: string }) {
    return defineTool({
        id: "pubmed",
        description:
            "Search and read the biomedical literature via PubMed / PubMed Central (NCBI E-utilities). The three actions form a chain " +
            "— search, then details on the relevant hits, then fulltext; see the action parameter for what each needs and returns. Read " +
            "fulltext sparingly — only where the 'details' abstract is not enough, and only for articles that have a pmcId (open-access). " +
            "A full article is larger than everything else this tool returns combined, so it comes back trimmed to a character budget: take the " +
            "`outline` from the first call and re-request the specific `sections` you need rather than raising maxChars. " +
            "available: false is an expected outcome, not an error — do not retry it.",
        inputSchema,
        // One tool, three jobs. The action alone would still render three
        // different searches identically, so each action names its own subject:
        // the query, how many articles, or which article.
        describeCall: (input) => {
            switch (input.action) {
                case "search":
                    return `search ${input.query ?? ""}`;
                case "details": {
                    const count = input.pmids?.length ?? 0;
                    return `details for ${count} ${count === 1 ? "article" : "articles"}`;
                }
                case "fulltext":
                    return `fulltext ${input.pmcId ?? ""}`;
            }
        },
        execute: async (input): Promise<Result<PubMedOutput, ToolError>> => {
            switch (input.action) {
                case "search":
                    return ok(
                        await searchPubmed(deps.ncbiApiKey, input.query!, {
                            maxResults: input.maxResults ?? DEFAULTS.searchResults,
                            ...(input.sort ? { sort: input.sort } : {}),
                            ...(input.dateRange ? { dateRange: input.dateRange } : {}),
                        }),
                    );
                case "details": {
                    const { articles, notFound } = await getArticleDetails(deps.ncbiApiKey, input.pmids!);
                    return ok({
                        articles: boundArticleDetails(articles, {
                            maxAuthors: input.maxAuthors ?? DEFAULTS.maxAuthors,
                            maxMeshTerms: input.maxMeshTerms ?? DEFAULTS.maxMeshTerms,
                        }),
                        notFound,
                    });
                }
                case "fulltext": {
                    const parsed = await getArticleFullText(deps.ncbiApiKey, input.pmcId!, {
                        ...(input.sections ? { sections: input.sections } : {}),
                        maxChars: input.maxChars ?? DEFAULTS.maxChars,
                    });
                    // "Not open-access" is an expected outcome — a data variant, not an error.
                    if (!parsed) return ok({ pmcId: input.pmcId!, available: false as const });
                    return ok({ pmcId: input.pmcId!, available: true as const, ...parsed });
                }
            }
        },
    });
}
