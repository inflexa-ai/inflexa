/**
 * Map free-text protein-family descriptors (UniProt keywords, HGNC names,
 * GraphQL labels) to a single canonical lowercase form, so a consumer has one
 * form to match against.
 *
 * Why this exists: UniProt keyword text varies in hyphenation
 * ("G-protein coupled receptor" vs "G protein-coupled receptor"), thus an
 * exact match on the raw text misses one of the two spellings.
 */

type CanonicalFamily = {
    canonical: string;
    patterns: RegExp[];
};

const FAMILIES: CanonicalFamily[] = [
    {
        canonical: "g protein-coupled receptor",
        patterns: [
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the hyphen-variant spellings of the GPCR name, matched as whole words.
            /\bg[-\s]?protein[-\s]?coupled\s+receptor\b/i,
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the GPCR abbreviation as a whole word.
            /\bgpcr\b/i,
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the seven-transmembrane spelling of the family name.
            /\b7tm\s+receptor\b/i,
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the rhodopsin-like subfamily spelling.
            /\brhodopsin-like\s+receptor\b/i,
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the secretin-like subfamily spelling.
            /\bsecretin-like\s+receptor\b/i,
        ],
    },
    {
        canonical: "serine/threonine-protein kinase",
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the hyphen-variant spellings of the serine/threonine kinase name.
        patterns: [/\bserine\/threonine[-\s]?protein\s+kinase\b/i],
    },
    {
        canonical: "tyrosine-protein kinase",
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the hyphen-variant spellings of the tyrosine kinase name.
        patterns: [/\btyrosine[-\s]?protein\s+kinase\b/i],
    },
    // Extend as additional hyphen-style mismatches surface. The default branch
    // below preserves the lowercased input so callers can still pattern-match
    // unknown families.
];

export function normalizeProteinFamily(input: string | null): string | null {
    if (!input) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    for (const fam of FAMILIES) {
        if (fam.patterns.some((rx) => rx.test(trimmed))) return fam.canonical;
    }
    return trimmed.toLowerCase();
}
