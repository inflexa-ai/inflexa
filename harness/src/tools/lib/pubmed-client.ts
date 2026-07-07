/**
 * Pure async client functions for PubMed and PubMed Central via NCBI E-utilities.
 *
 * Used by §3.11 (Key Papers), §3.10.4 (Preclinical literature), and the
 * pubmed-index Phase-1 collector.
 */

import { apiFetch, describeApiError } from "./api-utils.js";
import {
    NCBI_BASE,
    NCBI_IDCONV,
    ncbiUrl,
    parseEsummary,
    parseEfetch,
    parseIdConvResponse,
    parsePmcFullText,
    type ArticleDetail,
    type PubMedSummary,
    type FullTextResult,
} from "./ncbi-utils.js";

export type { PubMedSummary, ArticleDetail, FullTextResult };

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
    const searchResult = await apiFetch<{
        esearchresult?: { idlist?: string[]; count?: string };
    }>(searchUrl);

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
    const idConvAsync = apiFetch<unknown>(ncbiUrl(ncbiApiKey, NCBI_IDCONV, { ids: idString, format: "json" }));
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

/** Fetch open-access full text from PMC. Returns null when unavailable. */
export async function getArticleFullText(ncbiApiKey: string | undefined, pmcId: string): Promise<FullTextResult | null> {
    const numericId = pmcId.replace(/^PMC/i, "");
    const url = ncbiUrl(ncbiApiKey, `${NCBI_BASE}/efetch.fcgi`, {
        db: "pmc",
        id: numericId,
        rettype: "xml",
        retmode: "xml",
    });
    const result = await apiFetch<string>(url, { parseAs: "text" });
    if (result.isErr()) throw new Error(describeApiError(result.error));
    return parsePmcFullText(result.value);
}
