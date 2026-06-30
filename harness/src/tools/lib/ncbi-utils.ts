/**
 * Shared NCBI E-utilities helpers for PubMed/PMC tools.
 *
 * Provides base URL constants, API key injection, and XML-to-article
 * mapping functions for PubMed and PMC DTD structures.
 */

import { XMLParser } from "fast-xml-parser";

// ── NCBI E-utilities base URLs ──────────────────────────────────────

export const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
export const NCBI_IDCONV = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0";

// ── API key injection ───────────────────────────────────────────────

/**
 * Append `api_key` and optional extra params to a base URL.
 * Omits the key when `apiKey` is undefined.
 */
export function ncbiUrl(apiKey: string | undefined, base: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(base);
    if (apiKey) {
        url.searchParams.set("api_key", apiKey);
    }
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) {
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
}

// ── XML parser (shared, configured once) ────────────────────────────

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["PubmedArticle", "Author", "MeshHeading", "AbstractText", "sec", "p", "record"].includes(name),
    textNodeName: "#text",
});

// ── PubMed esummary mapping ─────────────────────────────────────────

export interface PubMedSummary {
    pmid: string;
    title: string;
    journal: string;
    year: string;
    authors: string;
}

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
    if (!items) return "";
    const arr = Array.isArray(items) ? items : [items];
    const item = arr.find((i) => i["@_Name"] === name);
    return item?.["#text"] ?? "";
}

function getAuthorsFromDocSum(items: DocSumItem | DocSumItem[] | undefined): string {
    if (!items) return "";
    const arr = Array.isArray(items) ? items : [items];
    const authorList = arr.find((i) => i["@_Name"] === "AuthorList");
    if (!authorList?.Item) return "";
    const authors = Array.isArray(authorList.Item) ? authorList.Item : [authorList.Item];
    const names = authors.map((a) => a["#text"] ?? "").filter(Boolean);
    if (names.length === 0) return "";
    if (names.length <= 3) return names.join(", ");
    return `${names[0]} et al.`;
}

/**
 * Parse esummary XML into PubMedSummary records.
 */
export function parseEsummary(xml: string): PubMedSummary[] {
    const parsed = xmlParser.parse(xml);
    const result = parsed?.eSummaryResult ?? parsed;
    const docSums = result?.DocSum;
    if (!docSums) return [];
    const docs: DocSum[] = Array.isArray(docSums) ? docSums : [docSums];
    return docs.map((doc) => {
        const items = doc.Item;
        const pubDate = getItemValue(items, "PubDate");
        return {
            pmid: String(doc.Id ?? ""),
            title: getItemValue(items, "Title"),
            journal: getItemValue(items, "FullJournalName") || getItemValue(items, "Source"),
            year: pubDate ? String(pubDate).slice(0, 4) : "",
            authors: getAuthorsFromDocSum(items),
        };
    });
}

// ── PubMed efetch (XML) mapping ─────────────────────────────────────

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

interface MedlineAuthor {
    LastName?: string;
    ForeName?: string;
    Initials?: string;
    CollectiveName?: string;
}

interface MeshHeadingItem {
    DescriptorName?: { "#text"?: string } | string;
}

/**
 * Parse efetch PubMed XML into ArticleDetail records.
 * `pmcId` is left null here — resolved separately via ID Converter.
 */
export function parseEfetch(xml: string): ArticleDetail[] {
    const parsed = xmlParser.parse(xml);
    const articleSet = parsed?.PubmedArticleSet;
    if (!articleSet) return [];
    const articles: unknown[] = Array.isArray(articleSet.PubmedArticle) ? articleSet.PubmedArticle : articleSet.PubmedArticle ? [articleSet.PubmedArticle] : [];

    return articles.map((entry: unknown) => {
        const article = entry as Record<string, unknown>;
        const medlineCitation = article.MedlineCitation as Record<string, unknown> | undefined;
        const articleData = medlineCitation?.Article as Record<string, unknown> | undefined;

        // PMID
        const pmidObj = medlineCitation?.PMID;
        const pmid = typeof pmidObj === "object" && pmidObj !== null ? String((pmidObj as Record<string, unknown>)["#text"] ?? "") : String(pmidObj ?? "");

        // Title
        const title = String(articleData?.ArticleTitle ?? "");

        // Abstract
        const abstractObj = articleData?.Abstract as Record<string, unknown> | undefined;
        let abstract = "";
        if (abstractObj?.AbstractText) {
            const texts = Array.isArray(abstractObj.AbstractText) ? abstractObj.AbstractText : [abstractObj.AbstractText];
            abstract = texts
                .map((t) => {
                    if (typeof t === "string") return t;
                    if (typeof t === "object" && t !== null) {
                        const label = (t as Record<string, unknown>)["@_Label"];
                        const text = (t as Record<string, unknown>)["#text"] ?? "";
                        return label ? `${label}: ${text}` : String(text);
                    }
                    return String(t);
                })
                .join("\n\n");
        }

        // Authors
        const authorListObj = articleData?.AuthorList as Record<string, unknown> | undefined;
        const rawAuthors = authorListObj?.Author;
        const authorArr: MedlineAuthor[] = Array.isArray(rawAuthors) ? rawAuthors : rawAuthors ? [rawAuthors as MedlineAuthor] : [];
        const authors = authorArr.map((a) => {
            if (a.CollectiveName) return a.CollectiveName;
            return [a.ForeName ?? a.Initials, a.LastName].filter(Boolean).join(" ");
        });

        // Journal + year
        const journalObj = articleData?.Journal as Record<string, unknown> | undefined;
        const journal = String((journalObj?.Title as string) ?? (journalObj?.ISOAbbreviation as string) ?? "");
        const journalIssue = journalObj?.JournalIssue as Record<string, unknown> | undefined;
        const pubDate = journalIssue?.PubDate as Record<string, unknown> | undefined;
        const year = String(pubDate?.Year ?? "");

        // DOI
        let doi = "";
        const articleIdList = (article.PubmedData as Record<string, unknown> | undefined)?.ArticleIdList as Record<string, unknown> | undefined;
        if (articleIdList?.ArticleId) {
            const ids = Array.isArray(articleIdList.ArticleId) ? articleIdList.ArticleId : [articleIdList.ArticleId];
            for (const idObj of ids) {
                if (typeof idObj === "object" && idObj !== null) {
                    const typed = idObj as Record<string, unknown>;
                    if (typed["@_IdType"] === "doi") {
                        doi = String(typed["#text"] ?? "");
                    }
                }
            }
        }

        // MeSH terms
        const meshList = medlineCitation?.MeshHeadingList as Record<string, unknown> | undefined;
        const meshHeadings: MeshHeadingItem[] = meshList?.MeshHeading
            ? Array.isArray(meshList.MeshHeading)
                ? meshList.MeshHeading
                : [meshList.MeshHeading as MeshHeadingItem]
            : [];
        const meshTerms = meshHeadings
            .map((h) => {
                const desc = h.DescriptorName;
                if (typeof desc === "string") return desc;
                if (typeof desc === "object" && desc !== null) return desc["#text"] ?? "";
                return "";
            })
            .filter(Boolean);

        return {
            pmid,
            title,
            abstract,
            authors,
            journal,
            year,
            doi,
            meshTerms,
            pmcId: null, // resolved separately via ID Converter
        };
    });
}

// ── NCBI ID Converter mapping ───────────────────────────────────────

/**
 * Parse ID Converter JSON response into a PMID → PMC ID map.
 * Returns only entries that have a PMC ID.
 */
export function parseIdConvResponse(data: unknown): Map<string, string> {
    const map = new Map<string, string>();
    const typed = data as { records?: Array<{ pmid?: string; pmcid?: string }> };
    if (!typed?.records) return map;
    for (const rec of typed.records) {
        if (rec.pmid && rec.pmcid) {
            map.set(rec.pmid, rec.pmcid);
        }
    }
    return map;
}

// ── PMC full text mapping ───────────────────────────────────────────

export interface ArticleSection {
    heading: string;
    text: string;
}

export interface FullTextResult {
    fullText: string;
    sections: ArticleSection[];
}

/**
 * Parse PMC efetch XML into plain text with section structure.
 * Omits figures, tables, and supplementary material markup.
 */
export function parsePmcFullText(xml: string): FullTextResult | null {
    const parsed = xmlParser.parse(xml);
    const articleSet = parsed?.["pmc-articleset"];
    const article = articleSet?.article;
    if (!article) return null;

    const body = article.body;
    if (!body) return null;

    const sections: ArticleSection[] = [];
    const rawSecs = body.sec ? (Array.isArray(body.sec) ? body.sec : [body.sec]) : [];

    for (const sec of rawSecs) {
        extractSection(sec, sections);
    }

    // If no sections found, try to extract body text directly
    if (sections.length === 0) {
        const bodyText = extractParagraphs(body);
        if (bodyText) {
            sections.push({ heading: "", text: bodyText });
        }
    }

    const fullText = sections.map((s) => (s.heading ? `## ${s.heading}\n\n${s.text}` : s.text)).join("\n\n");

    return { fullText, sections };
}

function extractSection(sec: unknown, out: ArticleSection[]): void {
    if (!sec || typeof sec !== "object") return;
    const s = sec as Record<string, unknown>;
    const heading = typeof s.title === "string" ? s.title : "";
    const text = extractParagraphs(s);
    if (text) {
        out.push({ heading, text });
    }
    // Recurse into nested sections
    if (s.sec) {
        const nested = Array.isArray(s.sec) ? s.sec : [s.sec];
        for (const sub of nested) {
            extractSection(sub, out);
        }
    }
}

function extractParagraphs(container: Record<string, unknown>): string {
    const paragraphs = container.p;
    if (!paragraphs) return "";
    const pArr = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
    return pArr
        .map((p) => {
            if (typeof p === "string") return p;
            if (typeof p === "object" && p !== null) {
                return flattenTextContent(p);
            }
            return String(p);
        })
        .filter(Boolean)
        .join("\n\n");
}

/**
 * Recursively extract text content from a parsed XML node,
 * ignoring markup like <fig>, <table-wrap>, <xref>, etc.
 */
function flattenTextContent(node: unknown): string {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (!node || typeof node !== "object") return "";

    const obj = node as Record<string, unknown>;
    const parts: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
        // Skip attributes and figure/table elements
        if (key.startsWith("@_")) continue;
        if (key === "fig" || key === "table-wrap" || key === "supplementary-material") continue;

        if (key === "#text") {
            parts.push(String(value));
        } else if (Array.isArray(value)) {
            for (const item of value) {
                parts.push(flattenTextContent(item));
            }
        } else {
            parts.push(flattenTextContent(value));
        }
    }

    return parts.filter(Boolean).join("");
}
