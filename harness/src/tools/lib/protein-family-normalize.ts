/**
 * Map free-text protein-family descriptors (UniProt keywords, HGNC names,
 * GraphQL labels) to a single canonical lowercase form so the modality lookup
 * in `protein-family-modality.json` has one pattern set to match against.
 *
 * Why this exists: UniProt keyword text and the modality-JSON patterns
 * disagreed on hyphenation ("G-protein coupled receptor" vs
 * "G protein-coupled receptor"), causing every GPCR target whose UniProt
 * keyword used the hyphenated variant to fall through to the dataset default
 * modality. See review of dossier 9ad29ba5 (GLP1R) — 2026-05-13.
 */

interface CanonicalFamily {
    canonical: string;
    patterns: RegExp[];
}

const FAMILIES: CanonicalFamily[] = [
    {
        canonical: "g protein-coupled receptor",
        patterns: [
            /\bg[-\s]?protein[-\s]?coupled\s+receptor\b/i,
            /\bgpcr\b/i,
            /\b7tm\s+receptor\b/i,
            /\brhodopsin-like\s+receptor\b/i,
            /\bsecretin-like\s+receptor\b/i,
        ],
    },
    {
        canonical: "serine/threonine-protein kinase",
        patterns: [/\bserine\/threonine[-\s]?protein\s+kinase\b/i],
    },
    {
        canonical: "tyrosine-protein kinase",
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
