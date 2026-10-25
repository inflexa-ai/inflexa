import { presentAt } from "../../lib/present.js";
import { collapseWhitespace as collapseText, isAllDigits, isAllHex } from "../../lib/text.js";
import { requestText, type SourceHttpOptions, type SourceHttpResult } from "./http.js";

const BASE_URL = "https://export.arxiv.org/api/query";

export type ArxivPaper = {
    id: string;
    title: string;
    abstract: string;
    authors: string[];
    published: string;
    categories: string[];
    url: string;
    pdfUrl?: string;
};

export type ArxivSearchInput = {
    readonly query: string;
    readonly categories?: readonly string[];
    readonly limit: number;
};

export type ArxivSource = {
    search(input: ArxivSearchInput, signal?: AbortSignal): Promise<SourceHttpResult<ArxivPaper[]>>;
    lookupExact(id: string, limit: number, signal?: AbortSignal): Promise<SourceHttpResult<ArxivPaper[]>>;
};

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- an Atom feed wraps text in CDATA sections; this keeps the text of each nearest opener/closer pair.
const stripCdata = (value: string): string => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

const NAMED_XML_ENTITIES = new Map([
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["amp", "&"],
]);

function decodeEntity(body: string): string | undefined {
    const named = NAMED_XML_ENTITIES.get(body);
    if (named !== undefined) return named;
    if (body.startsWith("#x")) {
        const hexadecimal = body.slice(2);
        return hexadecimal.length > 0 && isAllHex(hexadecimal) ? String.fromCodePoint(parseInt(hexadecimal, 16)) : undefined;
    }
    if (body.startsWith("#")) {
        const decimal = body.slice(1);
        return decimal.length > 0 && isAllDigits(decimal) ? String.fromCodePoint(parseInt(decimal, 10)) : undefined;
    }
    return undefined;
}

/**
 * Decode the XML entities the feed emits, in one pass.
 *
 * A single pass cannot re-decode its own output: `&amp;lt;` yields `&lt;`, never `<`.
 * A body that names no entity — or a numeric body that is not well-formed — stays literal.
 */
function decodeXmlEntities(value: string): string {
    let out = "";
    for (let i = 0; i < value.length;) {
        if (value.charAt(i) !== "&") {
            out += value.charAt(i);
            i++;
            continue;
        }
        const semicolon = value.indexOf(";", i);
        const decoded = semicolon < 0 ? undefined : decodeEntity(value.slice(i + 1, semicolon));
        if (decoded === undefined) {
            out += "&";
            i++;
            continue;
        }
        out += decoded;
        i = semicolon + 1;
    }
    return out;
}

const collapseWhitespace = (value: string): string => collapseText(decodeXmlEntities(stripCdata(value)));

function allMatches(entry: string, tag: string): string[] {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an Atom tag's content is `<tag …>` up to the nearest `</tag>`; the expression is built per tag name, and a tag name is not data.
    const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
    const values: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(entry)) !== null) values.push(presentAt(match, 1, `the captured ${tag}`));
    return values;
}

function firstMatch(entry: string, tag: string): string | undefined {
    return allMatches(entry, tag)[0];
}

function attributeValue(attributes: string, name: string): string | undefined {
    const marker = `${name}="`;
    const start = attributes.indexOf(marker);
    if (start < 0) return undefined;
    const valueStart = start + marker.length;
    const end = attributes.indexOf('"', valueStart);
    return end > valueStart ? attributes.slice(valueStart, end) : undefined;
}

function selfClosingAttributes(entry: string, tag: string): string[] {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- a self-closing Atom tag carries its attributes in the tag itself: `<tag … />`; the expression is built per tag name.
    const expression = new RegExp(`<${tag}\\b([^>]*)/>`, "g");
    const values: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(entry)) !== null) values.push(presentAt(match, 1, `the attributes of ${tag}`));
    return values;
}

function linkAttribute(entry: string, predicate: (attributes: string) => boolean): string | undefined {
    for (const attributes of selfClosingAttributes(entry, "link")) {
        if (predicate(attributes)) return attributeValue(attributes, "href");
    }
    return undefined;
}

function categoryTerms(entry: string): string[] {
    const terms: string[] = [];
    for (const attributes of selfClosingAttributes(entry, "category")) {
        const term = attributeValue(attributes, "term");
        if (term !== undefined) terms.push(term);
    }
    return terms;
}

function afterMarker(text: string, marker: string): string | undefined {
    const start = text.indexOf(marker);
    if (start < 0) return undefined;
    const rest = text.slice(start + marker.length);
    return rest.length > 0 ? rest : undefined;
}

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the Atom envelope probe: a `<feed` element opens the document; the word boundary keeps a longer element name from passing.
const ATOM_FEED_ELEMENT = /<feed\b/;

export function parseArxivAtom(xml: string): ArxivPaper[] {
    return allMatches(xml, "entry").flatMap((entry) => {
        const rawId = firstMatch(entry, "id");
        const title = firstMatch(entry, "title");
        if (rawId === undefined || title === undefined) return [];
        const idMatch = afterMarker(rawId, "abs/");
        const authors = allMatches(entry, "author")
            .map((author) => firstMatch(author, "name"))
            .filter((name): name is string => name !== undefined)
            .map(collapseWhitespace);
        const htmlUrl = linkAttribute(entry, (attributes) => attributes.includes('rel="alternate"') && attributes.includes('type="text/html"'));
        const pdfUrl = linkAttribute(entry, (attributes) => attributes.includes('title="pdf"'));
        return [
            {
                id: idMatch ?? collapseWhitespace(rawId),
                title: collapseWhitespace(title),
                abstract: collapseWhitespace(firstMatch(entry, "summary") ?? ""),
                authors,
                published: collapseWhitespace(firstMatch(entry, "published") ?? ""),
                categories: categoryTerms(entry),
                url: htmlUrl ?? collapseWhitespace(rawId),
                pdfUrl,
            },
        ];
    });
}

export function createArxivSource(options: SourceHttpOptions = {}): ArxivSource {
    async function fetchPapers(params: URLSearchParams, signal?: AbortSignal): Promise<SourceHttpResult<ArxivPaper[]>> {
        const result = await requestText(`${BASE_URL}?${params}`, options, signal);
        if (result.status !== "ok") return result;
        if (!ATOM_FEED_ELEMENT.test(result.value)) return { status: "unavailable", detail: "response schema mismatch: missing Atom feed" };
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
