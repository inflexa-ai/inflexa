import { CitationInputSchema, type CitationInput, type NormalizedCitation, type NormalizedCitationMetadata, type UnsupportedWorkKind } from "./types.js";

const DOI_PATTERN = /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)?(10\.\d{4,9}\/[^\s<>"']+)/i;
const PMID_PATTERN = /^(?:pmid\s*:\s*)?(\d{1,9})$/i;
const ARXIV_PATTERN = /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv\s*:\s*)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?)(?:\.pdf)?$/i;

function collapseWhitespace(value: string): string {
    return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeComparable(value: string): string {
    return collapseWhitespace(value)
        .toLocaleLowerCase("en-US")
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function normalizeAuthor(value: string): string {
    return normalizeComparable(value)
        .replace(/\b(?:jr|sr|ii|iii|iv)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function trimDoiPunctuation(value: string): string {
    let result = value.replace(/[.,;]+$/g, "");
    const pairs: ReadonlyArray<readonly [string, string]> = [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
    ];
    for (const [open, close] of pairs) {
        while (result.endsWith(close) && result.split(open).length <= result.split(close).length) result = result.slice(0, -1);
    }
    return result;
}

export function extractDoi(value: string): string | undefined {
    const match = collapseWhitespace(value).match(DOI_PATTERN);
    if (!match?.[1]) return undefined;
    return trimDoiPunctuation(match[1]).toLocaleLowerCase("en-US");
}

export function extractPmid(value: string): string | undefined {
    return collapseWhitespace(value).match(PMID_PATTERN)?.[1];
}

export function extractArxivId(value: string): string | undefined {
    const match = collapseWhitespace(value).match(ARXIV_PATTERN)?.[1];
    return match?.toLocaleLowerCase("en-US").replace(/v\d+$/i, "");
}

function classifyUnsupportedWork(value: string): UnsupportedWorkKind | undefined {
    const normalized = normalizeComparable(value);
    if (/\bpersonal communication\b/.test(normalized)) return "personal_communication";
    if (/\bunpublished (?:data|work|manuscript)\b/.test(normalized)) return "unpublished";
    if (/\b(?:in press|forthcoming)\b/.test(normalized)) return "unregistered_in_press";
    return undefined;
}

function normalizedSupplied(input: CitationInput): NormalizedCitationMetadata {
    return {
        ...(input.title === undefined ? {} : { title: normalizeComparable(input.title) }),
        ...(input.authors === undefined ? {} : { authors: input.authors.map(normalizeAuthor).filter(Boolean) }),
        ...(input.year === undefined ? {} : { year: input.year }),
        ...(input.venue === undefined ? {} : { venue: normalizeComparable(input.venue) }),
        ...(input.volume === undefined ? {} : { volume: normalizeComparable(input.volume) }),
        ...(input.firstPage === undefined ? {} : { firstPage: normalizeComparable(input.firstPage) }),
    };
}

export function normalizeCitation(unparsed: CitationInput): NormalizedCitation {
    const input = CitationInputSchema.parse(unparsed);
    const citation = collapseWhitespace(input.citation);
    const doi = extractDoi(citation);
    const pmid = extractPmid(citation);
    const arxiv = extractArxivId(citation);
    const hint = input.kind ?? "auto";

    let kind: NormalizedCitation["kind"];
    if (hint === "auto") kind = doi ? "doi" : pmid ? "pmid" : arxiv ? "arxiv" : "free_text";
    else kind = hint;

    if (kind === "doi" && doi === undefined) throw new Error("citation kind is doi but no valid DOI was found");
    if (kind === "pmid" && pmid === undefined) throw new Error("citation kind is pmid but no valid PMID was found");
    if (kind === "arxiv" && arxiv === undefined) throw new Error("citation kind is arxiv but no valid arXiv id was found");

    const unsupportedWorkKind = kind === "free_text" ? classifyUnsupportedWork(citation) : undefined;
    return {
        citation,
        query: normalizeComparable(citation),
        kind,
        identifiers: {
            ...(doi === undefined ? {} : { doi }),
            ...(pmid === undefined ? {} : { pmid }),
            ...(arxiv === undefined ? {} : { arxiv }),
        },
        supplied: normalizedSupplied(input),
        ...(unsupportedWorkKind === undefined ? {} : { unsupportedWorkKind }),
    };
}

export function citationCacheKey(input: CitationInput): string {
    const normalized = normalizeCitation(input);
    return JSON.stringify({
        kind: normalized.kind,
        identifiers: normalized.identifiers,
        query: normalized.identifiers.doi ?? normalized.identifiers.pmid ?? normalized.identifiers.arxiv ?? normalized.query,
        supplied: normalized.supplied,
        unsupportedWorkKind: normalized.unsupportedWorkKind ?? null,
    });
}
