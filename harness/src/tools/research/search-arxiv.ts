/**
 * Search arXiv for preprints. Returns Atom XML which we parse without a
 * dependency. arXiv is the primary source for ML / physics / math /
 * control-theory preprints; Semantic Scholar lags it by months.
 *
 * Same wire call and envelope as the legacy tool. Stateless HTTP; no deps.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";

const BASE_URL = "https://export.arxiv.org/api/query";

type SearchArxivOutput = { success: false; error: string; papers: ArxivPaper[] } | { success: true; papers: ArxivPaper[] };

export interface ArxivPaper {
    id: string;
    title: string;
    abstract: string;
    authors: string[];
    published: string;
    categories: string[];
    url: string;
    pdfUrl?: string;
}

const stripCdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

const decodeXmlEntities = (s: string): string =>
    s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, "&"); // amp last so we don't double-decode

const collapseWs = (s: string) => decodeXmlEntities(stripCdata(s)).replace(/\s+/g, " ").trim();

const extractEntries = (xml: string): string[] => {
    const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) out.push(m[1]);
    return out;
};

const firstMatch = (entry: string, tag: string): string | undefined => {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
    const m = entry.match(re);
    return m?.[1];
};

const allMatches = (entry: string, tag: string): string[] => {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(entry)) !== null) out.push(m[1]);
    return out;
};

const linkAttr = (entry: string, predicate: (attrs: string) => boolean): string | undefined => {
    const re = /<link\b([^>]*)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(entry)) !== null) {
        if (predicate(m[1])) {
            const hrefMatch = m[1].match(/href="([^"]+)"/);
            if (hrefMatch) return hrefMatch[1];
        }
    }
    return undefined;
};

const categoryTerms = (entry: string): string[] => {
    const re = /<category\b([^>]*)\/>/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(entry)) !== null) {
        const termMatch = m[1].match(/term="([^"]+)"/);
        if (termMatch) out.push(termMatch[1]);
    }
    return out;
};

export function parseArxivAtom(xml: string): ArxivPaper[] {
    return extractEntries(xml).flatMap((entry) => {
        const idRaw = firstMatch(entry, "id");
        const title = firstMatch(entry, "title");
        if (!idRaw || !title) return [];
        const idMatch = idRaw.match(/abs\/(.+)$/);
        const authors = allMatches(entry, "author")
            .map((a) => firstMatch(a, "name"))
            .filter((n): n is string => !!n)
            .map(collapseWs);
        const htmlUrl = linkAttr(entry, (a) => /rel="alternate"/.test(a) && /type="text\/html"/.test(a));
        const pdfUrl = linkAttr(entry, (a) => /title="pdf"/.test(a));
        return [
            {
                id: idMatch?.[1] ?? collapseWs(idRaw),
                title: collapseWs(title),
                abstract: collapseWs(firstMatch(entry, "summary") ?? ""),
                authors,
                published: collapseWs(firstMatch(entry, "published") ?? ""),
                categories: categoryTerms(entry),
                url: htmlUrl ?? collapseWs(idRaw),
                pdfUrl,
            },
        ];
    });
}

export const searchArxivTool = defineTool({
    id: "search_arxiv",
    description:
        "Search arXiv for preprints in ML, physics, math, control theory, " +
        "economics, and related quantitative fields. Returns id, title, " +
        "abstract, authors, publication date, arXiv categories, and URLs.",
    inputSchema: z.object({
        query: z.string().describe('Free-text query. Example: "adaptive control feedback stabilization".'),
        categories: z
            .array(z.string())
            .optional()
            .describe('Optional arXiv category filters (e.g., ["cs.LG", "math.OC"]). ' + "Combined with the query using AND."),
        limit: z.number().int().min(1).max(20).default(10).describe("Maximum results (1–20, default 10)."),
    }),
    execute: async ({ query, categories, limit }): Promise<Result<SearchArxivOutput, ToolError>> => {
        const catPart = categories && categories.length > 0 ? ` AND (${categories.map((c) => `cat:${c}`).join(" OR ")})` : "";
        const params = new URLSearchParams({
            search_query: `all:${query}${catPart}`,
            max_results: String(limit),
            sortBy: "relevance",
            sortOrder: "descending",
        });
        const res = await apiFetch<string>(`${BASE_URL}?${params}`, {
            parseAs: "text",
        });
        if (res.isErr()) {
            return ok({ success: false as const, error: describeApiError(res.error), papers: [] });
        }
        return ok({ success: true as const, papers: parseArxivAtom(res.value) });
    },
});
