/**
 * Pure async client functions for PubMed and PubMed Central via NCBI E-utilities.
 *
 * Used by §3.11 (Key Papers), §3.10.4 (Preclinical literature), and the
 * pubmed-index Phase-1 collector.
 */

import {
    createPubmedSource,
    type ArticleDetail,
    type ArticleSection,
    type FullTextResult,
    type PubmedSearchOptions,
    type PubMedSummary,
} from "../../literature/sources/pubmed.js";
import type { SourceHttpResult } from "../../literature/sources/http.js";

export type { PubMedSummary, ArticleDetail, ArticleSection, FullTextResult };

export type SearchOptions = PubmedSearchOptions;

function pubmedSource(ncbiApiKey: string | undefined) {
    return createPubmedSource({
        ...(ncbiApiKey === undefined ? {} : { apiKey: ncbiApiKey }),
        maxRetries: 3,
        retryDelayMs: 1_000,
        timeoutMs: 90_000,
    });
}

function unwrap<T>(result: SourceHttpResult<T>): T {
    if (result.status !== "ok") throw new Error(result.detail);
    return result.value;
}

/** PubMed search via esearch + esummary. */
export async function searchPubmed(
    ncbiApiKey: string | undefined,
    query: string,
    options: SearchOptions = {},
    signal?: AbortSignal,
): Promise<{ totalFound: number; results: PubMedSummary[] }> {
    return unwrap(await pubmedSource(ncbiApiKey).search(query, options, signal));
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
export async function getArticleDetails(
    ncbiApiKey: string | undefined,
    pmids: string[],
    signal?: AbortSignal,
): Promise<{ articles: ArticleDetail[]; notFound: string[] }> {
    return unwrap(await pubmedSource(ncbiApiKey).articleDetails(pmids, signal));
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
export async function getArticleFullText(
    ncbiApiKey: string | undefined,
    pmcId: string,
    options: FullTextOptions = {},
    signal?: AbortSignal,
): Promise<BoundedFullText | null> {
    const parsed = unwrap(await pubmedSource(ncbiApiKey).fetchFullText(pmcId, signal));
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
