/**
 * Pure async client functions for PubMed and PubMed Central via NCBI E-utilities.
 *
 * Used by §3.11 (Key Papers), §3.10.4 (Preclinical literature), and the
 * pubmed-index Phase-1 collector.
 */

import { z } from "zod";

import { apiFetch, apiFetchValidated, describeApiError } from "./api-utils.js";
import {
    NCBI_BASE,
    NCBI_IDCONV,
    ncbiUrl,
    parseEsummary,
    parseEfetch,
    parseIdConvResponse,
    parsePmcFullText,
    type ArticleDetail,
    type ArticleSection,
    type PubMedSummary,
    type FullTextResult,
} from "./ncbi-utils.js";

export type { PubMedSummary, ArticleDetail, ArticleSection, FullTextResult };

// NCBI E-utilities JSON payloads, validated at the fetch boundary. Every field
// is optional because the API omits absent values.
const EsearchResponseSchema = z.object({
    esearchresult: z.object({ idlist: z.array(z.string()).optional(), count: z.string().optional() }).optional(),
});

const IdConvResponseSchema = z.object({
    records: z.array(z.object({ pmid: z.string().optional(), pmcid: z.string().optional() })).optional(),
});

export interface SearchOptions {
    maxResults?: number;
    sort?: "relevance" | "date";
    dateRange?: { from: string; to: string };
}

/** PubMed search via esearch + esummary. */
export async function searchPubmed(
    ncbiApiKey: string | undefined,
    query: string,
    options: SearchOptions = {},
): Promise<{ totalFound: number; results: PubMedSummary[] }> {
    const maxResults = options.maxResults ?? 10;
    const sort = options.sort ?? "relevance";

    const esearchParams: Record<string, string | number | undefined> = {
        db: "pubmed",
        term: query,
        retmax: maxResults,
        retmode: "json",
        sort: sort === "date" ? "pub+date" : "relevance",
    };
    if (options.dateRange) {
        esearchParams.mindate = options.dateRange.from;
        esearchParams.maxdate = options.dateRange.to;
        esearchParams.datetype = "pdat";
    }

    const searchUrl = ncbiUrl(ncbiApiKey, `${NCBI_BASE}/esearch.fcgi`, esearchParams);
    const searchResult = await apiFetchValidated(searchUrl, EsearchResponseSchema);

    if (searchResult.isErr()) throw new Error(describeApiError(searchResult.error));

    const idList = searchResult.value.esearchresult?.idlist ?? [];
    const totalFound = parseInt(searchResult.value.esearchresult?.count ?? "0", 10);
    if (idList.length === 0) return { totalFound, results: [] };

    const summaryUrl = ncbiUrl(ncbiApiKey, `${NCBI_BASE}/esummary.fcgi`, {
        db: "pubmed",
        id: idList.join(","),
        retmode: "xml",
    });
    const summaryResult = await apiFetch<string>(summaryUrl, { parseAs: "text" });
    if (summaryResult.isErr()) throw new Error(describeApiError(summaryResult.error));

    return { totalFound, results: parseEsummary(summaryResult.value) };
}

export interface DetailOptions {
    /** Authors kept per article before collapsing the rest into `authorCount`. */
    maxAuthors?: number;
    /** MeSH terms kept per article; 0 drops the list entirely. */
    maxMeshTerms?: number;
}

/**
 * One article as the tool returns it: `ArticleDetail` with the two unbounded
 * list fields trimmed. A consortium paper can carry hundreds of authors and
 * dozens of MeSH headings — neither is worth the context, so the counts travel
 * instead of the tails.
 */
export interface BoundedArticleDetail extends ArticleDetail {
    authorCount: number;
    meshTermCount: number;
}

/** Fetch full PubMed article details (efetch + ID Converter for PMC). */
export async function getArticleDetails(ncbiApiKey: string | undefined, pmids: string[]): Promise<{ articles: ArticleDetail[]; notFound: string[] }> {
    const idString = pmids.join(",");
    const efetchAsync = apiFetch<string>(
        ncbiUrl(ncbiApiKey, `${NCBI_BASE}/efetch.fcgi`, {
            db: "pubmed",
            id: idString,
            rettype: "xml",
            retmode: "xml",
        }),
        { parseAs: "text" },
    );
    const idConvAsync = apiFetchValidated(ncbiUrl(ncbiApiKey, NCBI_IDCONV, { ids: idString, format: "json" }), IdConvResponseSchema);
    // Both requests run concurrently; each Result is awaited and handled below.
    const efetchResult = await efetchAsync;
    const idConvResult = await idConvAsync;

    if (efetchResult.isErr()) throw new Error(describeApiError(efetchResult.error));

    const articles: ArticleDetail[] = parseEfetch(efetchResult.value);
    if (idConvResult.isOk()) {
        const pmcMap = parseIdConvResponse(idConvResult.value);
        for (const article of articles) {
            article.pmcId = pmcMap.get(article.pmid) ?? null;
        }
    }
    const foundPmids = new Set(articles.map((a) => a.pmid));
    const notFound = pmids.filter((id) => !foundPmids.has(id));
    return { articles, notFound };
}

/** Trim the two unbounded list fields on each article, recording their true sizes. */
export function boundArticleDetails(articles: ArticleDetail[], options: DetailOptions = {}): BoundedArticleDetail[] {
    const maxAuthors = options.maxAuthors ?? 5;
    const maxMeshTerms = options.maxMeshTerms ?? 10;
    return articles.map((a) => ({
        ...a,
        authors: a.authors.slice(0, maxAuthors),
        authorCount: a.authors.length,
        meshTerms: a.meshTerms.slice(0, maxMeshTerms),
        meshTermCount: a.meshTerms.length,
    }));
}

export interface FullTextOptions {
    /** Case-insensitive substring match against section headings. */
    sections?: string[];
    /** Character budget across the returned section bodies. */
    maxChars?: number;
}

/**
 * A full text trimmed to a character budget. `outline` always lists EVERY
 * section in the article with its size and whether the body came back, so one
 * call is enough to decide which sections a follow-up should request — the
 * alternative is the agent guessing headings it has not seen.
 */
export interface BoundedFullText {
    fullText: string;
    sections: ArticleSection[];
    outline: { heading: string; chars: number; included: boolean }[];
    totalChars: number;
    returnedChars: number;
    truncated: boolean;
}

/**
 * Fetch open-access full text from PMC, trimmed to a section filter and a
 * character budget. Returns null when the article is not open-access.
 *
 * A research article routinely parses to 40–80k characters, so returning the
 * whole body by default would spend more context on one paper than the entire
 * tool surface costs to attach. Sections are kept whole (a half-sentence of
 * Methods is worse than none) and admitted in document order until the budget
 * would be exceeded.
 */
export async function getArticleFullText(ncbiApiKey: string | undefined, pmcId: string, options: FullTextOptions = {}): Promise<BoundedFullText | null> {
    const numericId = pmcId.replace(/^PMC/i, "");
    const url = ncbiUrl(ncbiApiKey, `${NCBI_BASE}/efetch.fcgi`, {
        db: "pmc",
        id: numericId,
        rettype: "xml",
        retmode: "xml",
    });
    const result = await apiFetch<string>(url, { parseAs: "text" });
    if (result.isErr()) throw new Error(describeApiError(result.error));
    const parsed: FullTextResult | null = parsePmcFullText(result.value);
    if (!parsed) return null;
    return boundFullText(parsed, options);
}

/** Apply the section filter and character budget to a parsed full text. */
export function boundFullText(parsed: FullTextResult, options: FullTextOptions = {}): BoundedFullText {
    const maxChars = options.maxChars ?? 12_000;
    const needles = (options.sections ?? []).map((s) => s.toLowerCase()).filter(Boolean);

    const totalChars = parsed.sections.reduce((n, s) => n + s.text.length, 0);
    const outline: { heading: string; chars: number; included: boolean }[] = [];
    const kept: ArticleSection[] = [];
    let returnedChars = 0;

    for (const section of parsed.sections) {
        const matchesFilter = needles.length === 0 || needles.some((n) => section.heading.toLowerCase().includes(n));
        // A section is admitted whole or not at all. The first section is always
        // admitted even if it alone busts the budget — a single-section article
        // would otherwise come back empty with no way to ask for less.
        const fits = returnedChars + section.text.length <= maxChars || kept.length === 0;
        const included = matchesFilter && fits;
        if (included) {
            kept.push(section);
            returnedChars += section.text.length;
        }
        outline.push({ heading: section.heading, chars: section.text.length, included });
    }

    return {
        fullText: kept.map((s) => (s.heading ? `## ${s.heading}\n\n${s.text}` : s.text)).join("\n\n"),
        sections: kept,
        outline,
        totalChars,
        returnedChars,
        truncated: returnedChars < totalChars,
    };
}
