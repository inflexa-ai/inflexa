import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { requestJson, requestText, type SourceHttpOptions, type SourceHttpResult } from "./http.js";

export const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
export const NCBI_IDCONV = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0";

const EsearchResponseSchema = z.object({
    esearchresult: z.object({ idlist: z.array(z.string()).optional(), count: z.string().optional() }).optional(),
});
const IdConvResponseSchema = z.object({
    records: z.array(z.object({ pmid: z.string().optional(), pmcid: z.string().optional() })).optional(),
});

export interface PubmedSourceOptions extends SourceHttpOptions {
    readonly apiKey?: string;
}

export interface PubmedSearchOptions {
    readonly maxResults?: number;
    readonly sort?: "relevance" | "date";
    readonly dateRange?: { readonly from: string; readonly to: string };
}

export interface PubmedCitationFields {
    readonly venue?: string;
    readonly year?: string | number;
    readonly volume?: string;
    readonly firstPage?: string;
    readonly firstAuthor?: string;
    readonly key: string;
}

export interface PubMedSummary {
    pmid: string;
    title: string;
    journal: string;
    year: string;
    authors: string;
}

export interface ArticleDetail {
    pmid: string;
    title: string;
    abstract: string;
    authors: string[];
    journal: string;
    year: string;
    doi: string;
    meshTerms: string[];
    pmcId: string | null;
}

export interface ArticleSection {
    heading: string;
    text: string;
}

export interface FullTextResult {
    fullText: string;
    sections: ArticleSection[];
}

export interface PubmedSource {
    search(query: string, options?: PubmedSearchOptions, signal?: AbortSignal): Promise<SourceHttpResult<{ totalFound: number; results: PubMedSummary[] }>>;
    searchIds(query: string, maxResults: number, signal?: AbortSignal): Promise<SourceHttpResult<string[]>>;
    matchCitation(fields: PubmedCitationFields, signal?: AbortSignal): Promise<SourceHttpResult<string[]>>;
    fetchArticles(pmids: readonly string[], signal?: AbortSignal): Promise<SourceHttpResult<ArticleDetail[]>>;
    articleDetails(pmids: readonly string[], signal?: AbortSignal): Promise<SourceHttpResult<{ articles: ArticleDetail[]; notFound: string[] }>>;
    fetchFullText(pmcId: string, signal?: AbortSignal): Promise<SourceHttpResult<FullTextResult | null>>;
}

export function ncbiUrl(apiKey: string | undefined, base: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(base);
    if (apiKey !== undefined) url.searchParams.set("api_key", apiKey);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
}

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["PubmedArticle", "Author", "MeshHeading", "AbstractText", "sec", "p", "record"].includes(name),
    textNodeName: "#text",
});

interface DocSumItem {
    "@_Name"?: string;
    "#text"?: string;
    Item?: DocSumItem | DocSumItem[];
}

interface DocSum {
    Id?: string;
    Item?: DocSumItem | DocSumItem[];
}

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

interface MedlineAuthor {
    LastName?: string;
    ForeName?: string;
    Initials?: string;
    CollectiveName?: string;
}

interface MeshHeadingItem {
    DescriptorName?: { "#text"?: string } | string;
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
        const article = entry as Record<string, unknown>;
        const citation = article.MedlineCitation as Record<string, unknown> | undefined;
        const articleData = citation?.Article as Record<string, unknown> | undefined;
        const pmidValue = citation?.PMID;
        const pmid =
            typeof pmidValue === "object" && pmidValue !== null ? String((pmidValue as Record<string, unknown>)["#text"] ?? "") : String(pmidValue ?? "");
        const abstractValue = (articleData?.Abstract as Record<string, unknown> | undefined)?.AbstractText;
        const abstract = (abstractValue === undefined ? [] : Array.isArray(abstractValue) ? abstractValue : [abstractValue])
            .map((value) => {
                if (typeof value === "string") return value;
                if (typeof value !== "object" || value === null) return String(value);
                const object = value as Record<string, unknown>;
                const text = String(object["#text"] ?? "");
                return object["@_Label"] === undefined ? text : `${String(object["@_Label"])}: ${text}`;
            })
            .join("\n\n");
        const authorValue = (articleData?.AuthorList as Record<string, unknown> | undefined)?.Author;
        const authors = (authorValue === undefined ? [] : Array.isArray(authorValue) ? authorValue : [authorValue as MedlineAuthor]).map(
            (author: MedlineAuthor) => author.CollectiveName ?? [author.ForeName ?? author.Initials, author.LastName].filter(Boolean).join(" "),
        );
        const journalData = articleData?.Journal as Record<string, unknown> | undefined;
        const publicationDate = (journalData?.JournalIssue as Record<string, unknown> | undefined)?.PubDate as Record<string, unknown> | undefined;
        let doi = "";
        const articleIds = ((article.PubmedData as Record<string, unknown> | undefined)?.ArticleIdList as Record<string, unknown> | undefined)?.ArticleId;
        for (const id of articleIds === undefined ? [] : Array.isArray(articleIds) ? articleIds : [articleIds]) {
            if (typeof id === "object" && id !== null && (id as Record<string, unknown>)["@_IdType"] === "doi") {
                doi = String((id as Record<string, unknown>)["#text"] ?? "");
            }
        }
        const meshValue = (citation?.MeshHeadingList as Record<string, unknown> | undefined)?.MeshHeading;
        const meshTerms = (meshValue === undefined ? [] : Array.isArray(meshValue) ? meshValue : [meshValue as MeshHeadingItem])
            .map((heading: MeshHeadingItem) => {
                const descriptor = heading.DescriptorName;
                return typeof descriptor === "string" ? descriptor : (descriptor?.["#text"] ?? "");
            })
            .filter(Boolean);
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
    const records = (data as { records?: Array<{ pmid?: string; pmcid?: string }> } | undefined)?.records ?? [];
    for (const record of records) if (record.pmid !== undefined && record.pmcid !== undefined) result.set(record.pmid, record.pmcid);
    return result;
}

function flattenTextContent(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (node === null || typeof node !== "object") return "";
    return Object.entries(node as Record<string, unknown>)
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
    if (section === null || typeof section !== "object") return;
    const object = section as Record<string, unknown>;
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
            const pmids = result.value
                .trim()
                .split(/\r?\n/)
                .flatMap((line) => {
                    const value = line.split("|").at(-1)?.trim();
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
                url(`${NCBI_BASE}/efetch.fcgi`, { db: "pmc", id: pmcId.replace(/^PMC/i, ""), rettype: "xml", retmode: "xml" }),
                options,
                signal,
            );
            return result.status === "ok" ? { status: "ok", value: parsePmcFullText(result.value) } : result;
        },
    };
}
