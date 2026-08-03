import { requestText, type SourceHttpOptions, type SourceHttpResult } from "./http.js";

const BASE_URL = "https://export.arxiv.org/api/query";

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

export interface ArxivSearchInput {
    readonly query: string;
    readonly categories?: readonly string[];
    readonly limit: number;
}

export interface ArxivSource {
    search(input: ArxivSearchInput, signal?: AbortSignal): Promise<SourceHttpResult<ArxivPaper[]>>;
    lookupExact(id: string, limit: number, signal?: AbortSignal): Promise<SourceHttpResult<ArxivPaper[]>>;
}

const stripCdata = (value: string): string => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

const decodeXmlEntities = (value: string): string =>
    value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hexadecimal: string) => String.fromCodePoint(parseInt(hexadecimal, 16)))
        .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
        .replace(/&amp;/g, "&");

const collapseWhitespace = (value: string): string => decodeXmlEntities(stripCdata(value)).replace(/\s+/g, " ").trim();

function extractEntries(xml: string): string[] {
    const expression = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
    const entries: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(xml)) !== null) entries.push(match[1]!);
    return entries;
}

function firstMatch(entry: string, tag: string): string | undefined {
    return entry.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1];
}

function allMatches(entry: string, tag: string): string[] {
    const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
    const values: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(entry)) !== null) values.push(match[1]!);
    return values;
}

function linkAttribute(entry: string, predicate: (attributes: string) => boolean): string | undefined {
    const expression = /<link\b([^>]*)\/>/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(entry)) !== null) {
        const attributes = match[1]!;
        if (predicate(attributes)) return attributes.match(/href="([^"]+)"/)?.[1];
    }
    return undefined;
}

function categoryTerms(entry: string): string[] {
    const expression = /<category\b([^>]*)\/>/g;
    const terms: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(entry)) !== null) {
        const term = match[1]!.match(/term="([^"]+)"/)?.[1];
        if (term !== undefined) terms.push(term);
    }
    return terms;
}

export function parseArxivAtom(xml: string): ArxivPaper[] {
    return extractEntries(xml).flatMap((entry) => {
        const rawId = firstMatch(entry, "id");
        const title = firstMatch(entry, "title");
        if (rawId === undefined || title === undefined) return [];
        const idMatch = rawId.match(/abs\/(.+)$/);
        const authors = allMatches(entry, "author")
            .map((author) => firstMatch(author, "name"))
            .filter((name): name is string => name !== undefined)
            .map(collapseWhitespace);
        const htmlUrl = linkAttribute(entry, (attributes) => /rel="alternate"/.test(attributes) && /type="text\/html"/.test(attributes));
        const pdfUrl = linkAttribute(entry, (attributes) => /title="pdf"/.test(attributes));
        return [
            {
                id: idMatch?.[1] ?? collapseWhitespace(rawId),
                title: collapseWhitespace(title),
                abstract: collapseWhitespace(firstMatch(entry, "summary") ?? ""),
                authors,
                published: collapseWhitespace(firstMatch(entry, "published") ?? ""),
                categories: categoryTerms(entry),
                url: htmlUrl ?? collapseWhitespace(rawId),
                ...(pdfUrl === undefined ? {} : { pdfUrl }),
            },
        ];
    });
}

export function createArxivSource(options: SourceHttpOptions = {}): ArxivSource {
    async function fetchPapers(params: URLSearchParams, signal?: AbortSignal): Promise<SourceHttpResult<ArxivPaper[]>> {
        const result = await requestText(`${BASE_URL}?${params}`, options, signal);
        if (result.status !== "ok") return result;
        if (!/<feed\b/.test(result.value)) return { status: "unavailable", detail: "response schema mismatch: missing Atom feed" };
        return { status: "ok", value: parseArxivAtom(result.value) };
    }

    return {
        search: (input, signal) => {
            const categoryQuery =
                input.categories !== undefined && input.categories.length > 0
                    ? ` AND (${input.categories.map((category) => `cat:${category}`).join(" OR ")})`
                    : "";
            return fetchPapers(
                new URLSearchParams({
                    search_query: `all:${input.query}${categoryQuery}`,
                    max_results: String(input.limit),
                    sortBy: "relevance",
                    sortOrder: "descending",
                }),
                signal,
            );
        },
        lookupExact: (id, limit, signal) => fetchPapers(new URLSearchParams({ id_list: id, max_results: String(limit) }), signal),
    };
}
