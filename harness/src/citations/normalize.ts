import { CitationInputSchema, type CitationInput, type NormalizedCitation, type NormalizedCitationMetadata, type UnsupportedWorkKind } from "./types.js";

// Each registry defines its own identifier syntax, and each is matched here rather than parsed:
// a citation string is prose, so the identifier has to be found inside it, not read off a field.
// The DOI suffix is deliberately permissive — the registry allows nearly any character in it, so
// there is no delimiter to stop at, and `trimDoiPunctuation` walks back the sentence punctuation
// and brackets a greedy match swallows. PMID and arXiv anchor instead, having fixed shapes.
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

interface AuthorEvidence {
    /** Spelled-out name parts, in no particular order. */
    readonly words: readonly string[];
    /** Standalone initials, which say nothing about which part of the name they abbreviate. */
    readonly initials: readonly string[];
}

function authorEvidence(value: string): AuthorEvidence {
    const tokens = normalizeAuthor(value).split(" ").filter(Boolean);
    return { words: tokens.filter((token) => token.length > 1), initials: tokens.filter((token) => token.length === 1) };
}

/**
 * A token long enough to be a spelled-out name part rather than an unpunctuated
 * block of initials. Two letters is the boundary: `Smith JA` and `Wu` are both
 * live readings of the same shape, so a token that short is never treated as a
 * name part that could contradict one.
 */
const SPELLED_OUT_MINIMUM = 3;

/**
 * The given-name letters a name can account for. A short leftover may itself be
 * an initial block, so it contributes every letter; a spelled-out one
 * contributes only the initial it would abbreviate to.
 */
function givenLetters(leftover: readonly string[], initials: readonly string[]): string[] {
    return [...initials, ...leftover.flatMap((word) => (word.length < SPELLED_OUT_MINIMUM ? [...word] : [word[0]!]))].sort();
}

function containsLetters(available: readonly string[], required: readonly string[]): boolean {
    const pool = [...available];
    return required.every((letter) => {
        const index = pool.indexOf(letter);
        if (index < 0) return false;
        pool.splice(index, 1);
        return true;
    });
}

/**
 * Whether two author strings can name the same person. Written surname-position
 * free, because citation styles disagree about it (`Smith, Jane A.`,
 * `Jane A. Smith`, `Smith JA` all reach us) and normalization has already
 * discarded the comma that would settle it.
 *
 * Sharing a name part is necessary but never sufficient: two spelled-out names
 * that each carry a part the other lacks are different people, and where both
 * sides supply given-name evidence it has to agree. Surname-only agreement is
 * accepted only when one side supplies no given name at all — the case where
 * there is nothing to contradict.
 */
export function authorNamesMatch(left: string, right: string): boolean {
    const a = authorEvidence(left);
    const b = authorEvidence(right);
    if (!a.words.some((word) => b.words.includes(word))) return false;
    const leftoverA = a.words.filter((word) => !b.words.includes(word));
    const leftoverB = b.words.filter((word) => !a.words.includes(word));
    const spelledOut = (leftover: readonly string[]): boolean => leftover.some((word) => word.length >= SPELLED_OUT_MINIMUM);
    if (spelledOut(leftoverA) && spelledOut(leftoverB)) return false;
    const lettersA = givenLetters(leftoverA, a.initials);
    const lettersB = givenLetters(leftoverB, b.initials);
    if (lettersA.length === 0 || lettersB.length === 0) return true;
    return lettersA.length <= lettersB.length ? containsLetters(lettersB, lettersA) : containsLetters(lettersA, lettersB);
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
    // A pinned `free_text` kind asserts the citation carries no usable identifier — `auto`
    // would have classified it otherwise. Publishing one anyway splits the pipeline against
    // itself: the plan gives the citation bibliographic-only treatment while candidate
    // scoring short-circuits to a perfect match on an identifier nothing verified.
    const identified = kind !== "free_text";
    return {
        citation,
        query: normalizeComparable(citation),
        kind,
        identifiers: {
            ...(doi === undefined || !identified ? {} : { doi }),
            ...(pmid === undefined || !identified ? {} : { pmid }),
            ...(arxiv === undefined || !identified ? {} : { arxiv }),
        },
        supplied: normalizedSupplied(input),
        ...(unsupportedWorkKind === undefined ? {} : { unsupportedWorkKind }),
    };
}

/**
 * Identity of the *lookups* an input provokes, not of the input itself.
 *
 * Two citations share this key when the authorities would be asked the same
 * question, so they share one round of source outcomes; each caller's own
 * supplied metadata is compared against those outcomes separately. An exact
 * identifier is the whole question — every operation an identifier plan selects
 * is driven by the identifier alone — so supplied metadata stays out of the key
 * there. A free-text citation is dispatched from its metadata, and folds it in.
 */
export function citationLookupKey(input: CitationInput): string {
    const normalized = normalizeCitation(input);
    return JSON.stringify(
        normalized.kind === "free_text"
            ? {
                  kind: normalized.kind,
                  identifiers: normalized.identifiers,
                  query: normalized.query,
                  supplied: normalized.supplied,
                  unsupportedWorkKind: normalized.unsupportedWorkKind ?? null,
              }
            : { kind: normalized.kind, identifiers: normalized.identifiers },
    );
}
