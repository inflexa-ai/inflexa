import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { maybeRecord, recordMember } from "../../lib/shape.js";

import { requestJson, requestText, type SourceHttpOptions, type SourceHttpResult } from "./http.js";
import { splitLines } from "../../lib/text.js";

export const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
export const NCBI_IDCONV = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0";

const EsearchResponseSchema = z.object({
    esearchresult: z.object({ idlist: z.array(z.string()).optional(), count: z.string().optional() }).optional(),
});
const IdConvResponseSchema = z.object({
    records: z.array(z.object({ pmid: z.string().optional(), pmcid: z.string().optional() })).optional(),
});

export type PubmedSourceOptions = SourceHttpOptions & {
    readonly apiKey?: string;
};

export type PubmedSearchOptions = {
    readonly maxResults?: number;
    readonly sort?: "relevance" | "date";
    readonly dateRange?: { readonly from: string; readonly to: string };
};

export type PubmedCitationFields = {
    readonly venue?: string;
    readonly year?: string | number;
    readonly volume?: string;
    readonly firstPage?: string;
    readonly firstAuthor?: string;
    readonly key: string;
};

export type PubMedSummary = {
    pmid: string;
    title: string;
    journal: string;
    year: string;
    authors: string;
};

export type ArticleDetail = {
    pmid: string;
    title: string;
    abstract: string;
    authors: string[];
    journal: string;
    year: string;
    doi: string;
    meshTerms: string[];
    pmcId: string | null;
};

export type ArticleSection = {
    heading: string;
    text: string;
};

export type FullTextResult = {
    fullText: string;
    sections: ArticleSection[];
};

export type PubmedSource = {
    search(query: string, options?: PubmedSearchOptions, signal?: AbortSignal): Promise<SourceHttpResult<{ totalFound: number; results: PubMedSummary[] }>>;
    searchIds(query: string, maxResults: number, signal?: AbortSignal): Promise<SourceHttpResult<string[]>>;
    matchCitation(fields: PubmedCitationFields, signal?: AbortSignal): Promise<SourceHttpResult<string[]>>;
    fetchArticles(pmids: readonly string[], signal?: AbortSignal): Promise<SourceHttpResult<ArticleDetail[]>>;
    articleDetails(pmids: readonly string[], signal?: AbortSignal): Promise<SourceHttpResult<{ articles: ArticleDetail[]; notFound: string[] }>>;
    fetchFullText(pmcId: string, signal?: AbortSignal): Promise<SourceHttpResult<FullTextResult | null>>;
};

export function ncbiUrl(apiKey: string | undefined, base: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(base);
    // The URL must not include an empty key. NCBI rejects `api_key=` with HTTP 400.
    if (apiKey) url.searchParams.set("api_key", apiKey);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
}

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["PubmedArticle", "Author", "MeshHeading", "AbstractText", "sec", "p", "record"].includes(name),
    textNodeName: "#text",
    // Each consumer reads a text node as a string. Without this option the
    // parser turns a numeric text node into a number, and a year-only PubDate
    // then crashes the year extraction in `parseEsummary`.
    parseTagValue: false,
});

type DocSumItem = {
    "@_Name"?: string;
    "#text"?: string;
    Item?: DocSumItem | DocSumItem[];
};

type DocSum = {
    Id?: string;
    Item?: DocSumItem | DocSumItem[];
};

function getItemValue(items: DocSumItem | DocSumItem[] | undefined, name: string): string {
    if (items === undefined) return "";
    const item = (Array.isArray(items) ? items : [items]).find((candidate) => candidate["@_Name"] === name);
    return item?.["#text"] ?? "";
}

function getAuthorsFromDocSum(items: DocSumItem | DocSumItem[] | undefined): string {
    if (items === undefined) return "";
    const authorList = (Array.isArray(items) ? items : [items]).find((item) => item["@_Name"] === "AuthorList");
    if (authorList?.Item === undefined) return "";
    const names = (Array.isArray(authorList.Item) ? authorList.Item : [authorList.Item]).map((author) => author["#text"] ?? "").filter(Boolean);
    if (names.length <= 3) return names.join(", ");
    return `${names[0]} et al.`;
}

export function parseEsummary(xml: string): PubMedSummary[] {
    const parsed = xmlParser.parse(xml);
    const docSums = (parsed?.eSummaryResult ?? parsed)?.DocSum;
    if (docSums === undefined) return [];
    const documents: DocSum[] = Array.isArray(docSums) ? docSums : [docSums];
    return documents.map((document) => {
        const publicationDate = getItemValue(document.Item, "PubDate");
        return {
            pmid: String(document.Id ?? ""),
            title: getItemValue(document.Item, "Title"),
            journal: getItemValue(document.Item, "FullJournalName") || getItemValue(document.Item, "Source"),
            year: publicationDate.slice(0, 4),
            authors: getAuthorsFromDocSum(document.Item),
        };
    });
}

export function parseEfetch(xml: string): ArticleDetail[] {
    const articleSet = xmlParser.parse(xml)?.PubmedArticleSet;
    if (articleSet === undefined) return [];
    const entries: unknown[] = Array.isArray(articleSet.PubmedArticle)
        ? articleSet.PubmedArticle
        : articleSet.PubmedArticle === undefined
          ? []
          : [articleSet.PubmedArticle];

    return entries.map((entry) => {
        const article = maybeRecord(entry);
        const citation = recordMember(article, "MedlineCitation");
        const articleData = recordMember(citation, "Article");
        const pmidValue = citation?.PMID;
        const pmidRecord = maybeRecord(pmidValue);
        const pmid = pmidRecord !== undefined ? String(pmidRecord["#text"] ?? "") : String(pmidValue ?? "");
        const abstractValue = recordMember(articleData, "Abstract")?.AbstractText;
        const abstract = (abstractValue === undefined ? [] : Array.isArray(abstractValue) ? abstractValue : [abstractValue])
            .map((value) => {
                if (typeof value === "string") return value;
                const object = maybeRecord(value);
                if (object === undefined) return String(value);
                const text = String(object["#text"] ?? "");
                return object["@_Label"] === undefined ? text : `${String(object["@_Label"])}: ${text}`;
            })
            .join("\n\n");
        const authorValue = recordMember(articleData, "AuthorList")?.Author;
        const authorName = (author: unknown): string => {
            const object = maybeRecord(author);
            if (object === undefined) return "";
            if (object.CollectiveName !== undefined) return String(object.CollectiveName);
            return [object.ForeName ?? object.Initials, object.LastName].filter(Boolean).map(String).join(" ");
        };
        const authors = (authorValue === undefined ? [] : Array.isArray(authorValue) ? authorValue : [authorValue]).map(authorName);
        const journalData = recordMember(articleData, "Journal");
        const publicationDate = recordMember(recordMember(journalData, "JournalIssue"), "PubDate");
        let doi = "";
        const articleIds = recordMember(recordMember(article, "PubmedData"), "ArticleIdList")?.ArticleId;
        for (const id of articleIds === undefined ? [] : Array.isArray(articleIds) ? articleIds : [articleIds]) {
            const idRecord = maybeRecord(id);
            if (idRecord !== undefined && idRecord["@_IdType"] === "doi") {
                doi = String(idRecord["#text"] ?? "");
            }
        }
        const meshValue = recordMember(citation, "MeshHeadingList")?.MeshHeading;
        const meshTerm = (heading: unknown): string => {
            const descriptor = maybeRecord(heading)?.DescriptorName;
            return typeof descriptor === "string" ? descriptor : String(maybeRecord(descriptor)?.["#text"] ?? "");
        };
        const meshTerms = (meshValue === undefined ? [] : Array.isArray(meshValue) ? meshValue : [meshValue]).map(meshTerm).filter(Boolean);
        return {
            pmid,
            title: String(articleData?.ArticleTitle ?? ""),
            abstract,
            authors,
            journal: String(journalData?.Title ?? journalData?.ISOAbbreviation ?? ""),
            year: String(publicationDate?.Year ?? ""),
            doi,
            meshTerms,
            pmcId: null,
        };
    });
}

export function parseIdConvResponse(data: unknown): Map<string, string> {
    const result = new Map<string, string>();
    const IdConvRecord = z.object({ records: z.array(z.object({ pmid: z.string().optional(), pmcid: z.string().optional() })).optional() });
    const records = IdConvRecord.parse(data ?? {}).records ?? [];
    for (const record of records) if (record.pmid !== undefined && record.pmcid !== undefined) result.set(record.pmid, record.pmcid);
    return result;
}

function flattenTextContent(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    const object = maybeRecord(node);
    if (object === undefined) return "";
    return Object.entries(object)
        .flatMap(([key, value]) => {
            if (key.startsWith("@_") || key === "fig" || key === "table-wrap" || key === "supplementary-material") return [];
            if (key === "#text") return [String(value)];
            return Array.isArray(value) ? value.map(flattenTextContent) : [flattenTextContent(value)];
        })
        .filter(Boolean)
        .join("");
}

function extractParagraphs(container: Record<string, unknown>): string {
    const paragraphs = container.p;
    if (paragraphs === undefined) return "";
    return (Array.isArray(paragraphs) ? paragraphs : [paragraphs])
        .map((paragraph) => (typeof paragraph === "string" ? paragraph : flattenTextContent(paragraph)))
        .filter(Boolean)
        .join("\n\n");
}

function extractSection(section: unknown, output: ArticleSection[]): void {
    const object = maybeRecord(section);
    if (object === undefined) return;
    const text = extractParagraphs(object);
    if (text) output.push({ heading: typeof object.title === "string" ? object.title : "", text });
    const nested = object.sec;
    for (const child of nested === undefined ? [] : Array.isArray(nested) ? nested : [nested]) extractSection(child, output);
}

export function parsePmcFullText(xml: string): FullTextResult | null {
    const article = xmlParser.parse(xml)?.["pmc-articleset"]?.article;
    const body = article?.body;
    if (body === undefined) return null;
    const sections: ArticleSection[] = [];
    for (const section of body.sec === undefined ? [] : Array.isArray(body.sec) ? body.sec : [body.sec]) extractSection(section, sections);
    if (sections.length === 0) {
        const text = extractParagraphs(body);
        if (text) sections.push({ heading: "", text });
    }
    return {
        fullText: sections.map((section) => (section.heading ? `## ${section.heading}\n\n${section.text}` : section.text)).join("\n\n"),
        sections,
    };
}

export function createPubmedSource(options: PubmedSourceOptions = {}): PubmedSource {
    const url = (endpoint: string, params: Record<string, string | number | undefined>): string => ncbiUrl(options.apiKey, endpoint, params);

    async function searchIdsWithTotal(
        query: string,
        searchOptions: PubmedSearchOptions,
        signal?: AbortSignal,
    ): Promise<SourceHttpResult<{ totalFound: number; ids: string[] }>> {
        const params: Record<string, string | number | undefined> = {
            db: "pubmed",
            term: query,
            retmax: searchOptions.maxResults ?? 10,
            retmode: "json",
            sort: searchOptions.sort === "date" ? "pub+date" : "relevance",
        };
        if (searchOptions.dateRange !== undefined) {
            params.mindate = searchOptions.dateRange.from;
            params.maxdate = searchOptions.dateRange.to;
            params.datetype = "pdat";
        }
        const result = await requestJson(url(`${NCBI_BASE}/esearch.fcgi`, params), EsearchResponseSchema, options, signal);
        if (result.status !== "ok") return result;
        return {
            status: "ok",
            value: {
                totalFound: parseInt(result.value.esearchresult?.count ?? "0", 10),
                ids: result.value.esearchresult?.idlist ?? [],
            },
        };
    }

    async function fetchArticles(pmids: readonly string[], signal?: AbortSignal): Promise<SourceHttpResult<ArticleDetail[]>> {
        const result = await requestText(
            url(`${NCBI_BASE}/efetch.fcgi`, { db: "pubmed", id: pmids.join(","), rettype: "xml", retmode: "xml" }),
            options,
            signal,
        );
        if (result.status !== "ok") return result;
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the PubMed grammar: its markup has no builtin parser.
        if (!/<PubmedArticleSet\b/.test(result.value)) return { status: "unavailable", detail: "response schema mismatch: missing PubmedArticleSet" };
        return { status: "ok", value: parseEfetch(result.value) };
    }

    return {
        async search(query, searchOptions = {}, signal) {
            const search = await searchIdsWithTotal(query, searchOptions, signal);
            if (search.status !== "ok") return search;
            if (search.value.ids.length === 0) return { status: "ok", value: { totalFound: search.value.totalFound, results: [] } };
            const summary = await requestText(
                url(`${NCBI_BASE}/esummary.fcgi`, { db: "pubmed", id: search.value.ids.join(","), retmode: "xml" }),
                options,
                signal,
            );
            if (summary.status !== "ok") return summary;
            return { status: "ok", value: { totalFound: search.value.totalFound, results: parseEsummary(summary.value) } };
        },
        async searchIds(query, maxResults, signal) {
            const result = await searchIdsWithTotal(query, { maxResults }, signal);
            return result.status === "ok" ? { status: "ok", value: result.value.ids } : result;
        },
        async matchCitation(fields, signal) {
            const bdata = [fields.venue ?? "", fields.year ?? "", fields.volume ?? "", fields.firstPage ?? "", fields.firstAuthor ?? "", fields.key, ""].join(
                "|",
            );
            const result = await requestText(url(`${NCBI_BASE}/ecitmatch.cgi`, { db: "pubmed", rettype: "xml", bdata }), options, signal);
            if (result.status !== "ok") return result;
            const pmids = splitLines(result.value.trim()).flatMap((line) => {
                    const value = line.split("|").at(-1)?.trim();
                    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the PubMed grammar: its markup has no builtin parser.
                    return value !== undefined && /^\d+$/.test(value) ? [value] : [];
                });
            return { status: "ok", value: pmids };
        },
        fetchArticles,
        async articleDetails(pmids, signal) {
            const [articlesResult, conversionResult] = await Promise.all([
                fetchArticles(pmids, signal),
                requestJson(url(NCBI_IDCONV, { ids: pmids.join(","), format: "json" }), IdConvResponseSchema, options, signal),
            ]);
            if (articlesResult.status !== "ok") return articlesResult;
            if (conversionResult.status === "ok") {
                const conversions = parseIdConvResponse(conversionResult.value);
                for (const article of articlesResult.value) article.pmcId = conversions.get(article.pmid) ?? null;
            }
            const found = new Set(articlesResult.value.map((article) => article.pmid));
            return { status: "ok", value: { articles: articlesResult.value, notFound: pmids.filter((pmid) => !found.has(pmid)) } };
        },
        async fetchFullText(pmcId, signal) {
            const result = await requestText(
                // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the PubMed grammar: its markup has no builtin parser.
                url(`${NCBI_BASE}/efetch.fcgi`, { db: "pmc", id: pmcId.replace(/^PMC/i, ""), rettype: "xml", retmode: "xml" }),
                options,
                signal,
            );
            return result.status === "ok" ? { status: "ok", value: parsePmcFullText(result.value) } : result;
        },
    };
}
