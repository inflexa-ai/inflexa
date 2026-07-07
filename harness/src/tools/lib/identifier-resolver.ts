/**
 * Identifier resolver — combines HGNC, UniProt, Ensembl, and ChEMBL gene-name
 * fields into a single canonical entity payload with synonyms.
 *
 * Used by Phase 0 of the target-assessment workflow to resolve a user-
 * supplied target string (gene symbol, alias, UniProt accession, Ensembl
 * id, ChEMBL target id) to a canonical entity that downstream collectors
 * can key off.
 *
 * Resolution order:
 *   1. If the input matches a known id pattern (ENSG, UniProt 6-char,
 *      CHEMBL\d+), use that as the seed.
 *   2. Otherwise treat as a gene symbol and resolve via HGNC, then enrich
 *      with UniProt, Ensembl, and ChEMBL.
 *
 * This is the only step in the workflow allowed to throw — a hard
 * resolution failure aborts the assessment with `error.kind:
 * "target-unresolved"` (per design §6).
 */

import { z } from "zod";

import { apiFetchValidated } from "./api-utils.js";
import { resolveSymbolToEnsemblId } from "./ensembl-client.js";
import { searchTargets as searchChemblTargets } from "./chembl-client.js";
import { normalizeProteinFamily } from "./protein-family-normalize.js";

const HGNC_BASE = "https://rest.genenames.org/fetch";
const UNIPROT_BASE = "https://rest.uniprot.org/uniprotkb/search";

const HGNC_HEADERS = { Accept: "application/json" };
const UNIPROT_HEADERS = { Accept: "application/json" };

const ENSG_RE = /^ENSG\d{11}$/;
const UNIPROT_RE = /^[A-Z][0-9][A-Z0-9]{3}[0-9](-\d+)?$/;
const CHEMBL_RE = /^CHEMBL\d+$/;
const HGNC_RE = /^HGNC:\d+$/;

export interface ResolvedTarget {
    /** Canonical id used as the entity-resolution anchor — preferred order: HGNC, then Ensembl. */
    canonicalId: string;
    /** What ontology produced the canonical id ("hgnc" or "ensembl"). */
    canonicalOntology: "hgnc" | "ensembl";
    /** Approved HGNC symbol (always uppercase). */
    geneSymbol: string;
    /** Full gene name. */
    approvedName: string;
    /** Cross-reference identifiers, populated where available. */
    ids: {
        hgnc: string | null;
        ensembl: string | null;
        uniprot: string | null;
        chembl: string | null;
        entrez: string | null;
    };
    /** Gene symbol synonyms. */
    synonyms: string[];
    /** Protein name synonyms (UniProt). */
    proteinSynonyms: string[];
    /** Protein family / classification fields gathered from UniProt or ChEMBL — used by §2.2 family fallback. */
    proteinFamily: string | null;
    /** Whether each upstream lookup succeeded — used to disclose coverage. */
    resolutionCoverage: {
        hgnc: boolean;
        uniprot: boolean;
        ensembl: boolean;
        chembl: boolean;
    };
}

// HGNC search payload, validated at the fetch boundary. Every field is optional
// because the API omits absent values; each read below is optional-chained /
// defaulted, so a missing field degrades gracefully rather than throwing.
const HgncResponseSchema = z.object({
    response: z
        .object({
            docs: z
                .array(
                    z.object({
                        symbol: z.string().optional(),
                        name: z.string().optional(),
                        hgnc_id: z.string().optional(),
                        ensembl_gene_id: z.string().optional(),
                        uniprot_ids: z.array(z.string()).optional(),
                        entrez_id: z.string().optional(),
                        alias_symbol: z.array(z.string()).optional(),
                        prev_symbol: z.array(z.string()).optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});
type HgncResponse = z.infer<typeof HgncResponseSchema>;

/** A single doc from the HGNC search payload — every field is optional. */
type HgncDoc = NonNullable<NonNullable<HgncResponse["response"]>["docs"]>[number];

// UniProt search payload, validated at the fetch boundary. Every field is
// optional because the API omits absent values.
const UniprotResponseSchema = z.object({
    results: z
        .array(
            z.object({
                primaryAccession: z.string().optional(),
                proteinDescription: z
                    .object({
                        recommendedName: z.object({ fullName: z.object({ value: z.string().optional() }).optional() }).optional(),
                        alternativeNames: z.array(z.object({ fullName: z.object({ value: z.string().optional() }).optional() })).optional(),
                    })
                    .optional(),
                genes: z
                    .array(
                        z.object({
                            geneName: z.object({ value: z.string().optional() }).optional(),
                            synonyms: z.array(z.object({ value: z.string().optional() })).optional(),
                        }),
                    )
                    .optional(),
                proteinFamily: z.string().optional(),
                extraAttributes: z.object({ uniParcId: z.string().optional() }).optional(),
                keywords: z.array(z.object({ name: z.string().optional() })).optional(),
            }),
        )
        .optional(),
});
type UniprotResponse = z.infer<typeof UniprotResponseSchema>;

async function fetchHgncBy(field: string, value: string) {
    const url = `${HGNC_BASE}/${field}/${encodeURIComponent(value)}`;
    const res = await apiFetchValidated(url, HgncResponseSchema, { headers: HGNC_HEADERS });
    if (res.isErr()) return null;
    const docs = res.value.response?.docs ?? [];
    return docs[0] ?? null;
}

async function fetchUniprotByAccession(accession: string) {
    const url = `${UNIPROT_BASE}?query=accession:${encodeURIComponent(accession)}&format=json&size=1`;
    const res = await apiFetchValidated(url, UniprotResponseSchema, { headers: UNIPROT_HEADERS });
    if (res.isErr()) return null;
    return res.value.results?.[0] ?? null;
}

async function fetchUniprotBySymbol(symbol: string) {
    const query = `gene_exact:${symbol} AND organism_id:9606 AND reviewed:true`;
    const url = `${UNIPROT_BASE}?query=${encodeURIComponent(query)}&format=json&size=1`;
    const res = await apiFetchValidated(url, UniprotResponseSchema, { headers: UNIPROT_HEADERS });
    if (res.isErr()) return null;
    return res.value.results?.[0] ?? null;
}

function extractProteinFamily(uniprotKeywords?: { name?: string }[]): string | null {
    if (!uniprotKeywords) return null;
    for (const kw of uniprotKeywords) {
        const norm = normalizeProteinFamily(kw.name ?? null);
        if (!norm) continue;
        if (
            norm.includes("kinase") ||
            norm.includes("g protein-coupled receptor") ||
            norm.includes("ion channel") ||
            norm.includes("protease") ||
            norm.includes("nuclear receptor") ||
            norm.includes("transcription factor") ||
            norm.includes("phosphatase") ||
            norm.includes("transporter") ||
            norm.includes("transferase")
        ) {
            return kw.name ?? null; // preserve original UniProt text on the entity for traceability
        }
    }
    return uniprotKeywords[0]?.name ?? null;
}

/**
 * Resolve a free-form target identifier to a canonical entity.
 *
 * @throws when the input cannot be mapped to any human gene/protein.
 */
export async function resolveTarget(input: string): Promise<ResolvedTarget> {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Target identifier is required");

    let seedSymbol: string | null = null;
    let seedHgncId: string | null = null;
    let seedEnsemblId: string | null = null;
    let seedUniprot: string | null = null;
    let seedChembl: string | null = null;

    if (ENSG_RE.test(trimmed)) {
        seedEnsemblId = trimmed;
    } else if (HGNC_RE.test(trimmed)) {
        seedHgncId = trimmed;
    } else if (UNIPROT_RE.test(trimmed)) {
        seedUniprot = trimmed;
    } else if (CHEMBL_RE.test(trimmed)) {
        seedChembl = trimmed;
    } else {
        seedSymbol = trimmed.toUpperCase();
    }

    // Step 1: HGNC anchor.
    // `hgncDoc` holds a single doc from the HGNC search payload (all fields are
    // optional on `HgncDoc`); every read below is optional-chained / defaulted, so
    // a missing or renamed field degrades to null rather than throwing — the
    // resolver never relies on any single HGNC field being present.
    let hgncDoc: HgncDoc | null = null;
    if (seedSymbol) {
        hgncDoc = await fetchHgncBy("symbol", seedSymbol);
        if (!hgncDoc) {
            hgncDoc = await fetchHgncBy("alias_symbol", seedSymbol);
        }
        if (!hgncDoc) {
            hgncDoc = await fetchHgncBy("prev_symbol", seedSymbol);
        }
    } else if (seedHgncId) {
        hgncDoc = await fetchHgncBy("hgnc_id", seedHgncId.replace(/^HGNC:/, ""));
    } else if (seedEnsemblId) {
        hgncDoc = await fetchHgncBy("ensembl_gene_id", seedEnsemblId);
    } else if (seedUniprot) {
        hgncDoc = await fetchHgncBy("uniprot_ids", seedUniprot);
    }

    // Step 2: UniProt
    let uniprotDoc: NonNullable<UniprotResponse["results"]>[number] | null = null;
    const uniprotFromHgnc = hgncDoc?.uniprot_ids?.[0] ?? null;
    const uniprotSeed = seedUniprot ?? uniprotFromHgnc ?? null;
    if (uniprotSeed) {
        uniprotDoc = await fetchUniprotByAccession(uniprotSeed);
    } else if (hgncDoc?.symbol) {
        uniprotDoc = await fetchUniprotBySymbol(hgncDoc.symbol);
    } else if (seedSymbol) {
        uniprotDoc = await fetchUniprotBySymbol(seedSymbol);
    }

    // Backfill HGNC if it was empty but UniProt produced a primary gene name.
    const uniprotPrimaryGene = uniprotDoc?.genes?.[0]?.geneName?.value ?? null;
    if (!hgncDoc && uniprotPrimaryGene) {
        hgncDoc = await fetchHgncBy("symbol", uniprotPrimaryGene);
    }

    // Step 3: Ensembl
    let ensemblId: string | null = seedEnsemblId ?? hgncDoc?.ensembl_gene_id ?? null;
    const symbolForEnsembl = hgncDoc?.symbol ?? uniprotPrimaryGene ?? seedSymbol;
    if (!ensemblId && symbolForEnsembl) {
        ensemblId = await resolveSymbolToEnsemblId(symbolForEnsembl);
    }

    // Step 4: ChEMBL
    let chemblId: string | null = seedChembl;
    if (!chemblId && symbolForEnsembl) {
        const targets = await searchChemblTargets(symbolForEnsembl, 5).catch(() => []);
        const human = targets.find((t) => t.organism === "Homo sapiens");
        chemblId = (human ?? targets[0])?.targetChemblId ?? null;
    }

    // Final canonical anchor — HGNC preferred, then Ensembl.
    const hgncId = hgncDoc?.hgnc_id ?? null;
    const finalSymbol = hgncDoc?.symbol ?? uniprotPrimaryGene ?? seedSymbol;

    if (!finalSymbol) {
        throw new Error(`Could not resolve target "${trimmed}" to a canonical human gene/protein identity`);
    }
    const finalName = uniprotDoc?.proteinDescription?.recommendedName?.fullName?.value ?? hgncDoc?.name ?? finalSymbol;
    // The canonicalOntology field is the entity-resolution anchor for
    // downstream collectors — falling back to a ChEMBL id (or worse, the
    // raw input string) while labelling it "ensembl" would silently route
    // every cross-reference through the wrong ontology. Require at least
    // one of HGNC / Ensembl to anchor the row.
    const canonicalId = hgncId ?? ensemblId;
    const canonicalOntology: "hgnc" | "ensembl" = hgncId ? "hgnc" : "ensembl";
    if (!canonicalId) {
        throw new Error(
            `Resolved "${trimmed}" to symbol "${finalSymbol}" but could not anchor to HGNC or Ensembl — ChEMBL/UniProt-only matches cannot serve as the canonical entity id`,
        );
    }

    const synonyms = new Set<string>();
    for (const s of hgncDoc?.alias_symbol ?? []) synonyms.add(String(s));
    for (const s of hgncDoc?.prev_symbol ?? []) synonyms.add(String(s));
    for (const g of uniprotDoc?.genes ?? []) {
        for (const syn of g.synonyms ?? []) {
            if (syn.value) synonyms.add(syn.value);
        }
    }
    synonyms.delete(finalSymbol);

    const proteinSynonyms = new Set<string>();
    for (const alt of uniprotDoc?.proteinDescription?.alternativeNames ?? []) {
        if (alt.fullName?.value) proteinSynonyms.add(alt.fullName.value);
    }

    return {
        canonicalId,
        canonicalOntology,
        geneSymbol: finalSymbol,
        approvedName: finalName,
        ids: {
            hgnc: hgncId,
            ensembl: ensemblId,
            uniprot: uniprotDoc?.primaryAccession ?? uniprotSeed,
            chembl: chemblId,
            entrez: hgncDoc?.entrez_id ?? null,
        },
        synonyms: [...synonyms].filter(Boolean).sort(),
        proteinSynonyms: [...proteinSynonyms].filter(Boolean).sort(),
        proteinFamily: extractProteinFamily(uniprotDoc?.keywords) ?? null,
        resolutionCoverage: {
            hgnc: !!hgncDoc,
            uniprot: !!uniprotDoc,
            ensembl: !!ensemblId,
            chembl: !!chemblId,
        },
    };
}

export interface AutocompleteCandidate {
    /** Approved HGNC symbol when known, otherwise the input symbol. */
    symbol: string;
    /** Full gene/protein name. */
    displayName: string | null;
    hgncId: string | null;
    ensemblId: string | null;
    uniprotId: string | null;
    /** Sorted synonyms across HGNC + UniProt. */
    synonyms: string[];
}

/**
 * Resolve a single gene-symbol query for the autocomplete UI by fanning
 * out HGNC + UniProt + Ensembl in parallel and merging into one canonical
 * candidate. Per `target-assessment/spec.md` "Autocomplete returns
 * canonical identifiers" — three identifiers populated on one row, not
 * three separate rows.
 *
 * Returns `null` when none of the upstream sources find a match. Throws
 * never — failures of individual sources degrade to `null` for that field.
 *
 * Symbol handling mirrors `resolveTarget` so both entry points behave the
 * same on edge cases:
 *   - The query is upper-cased before hitting upstream APIs (HGNC's
 *     `symbol` index is case-sensitive; `tp53` would miss).
 *   - HGNC is queried with a `symbol` → `alias_symbol` → `prev_symbol`
 *     fallback ladder so deprecated symbols still resolve.
 */
export async function searchTargetByName(symbol: string): Promise<AutocompleteCandidate | null> {
    const trimmed = symbol.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();

    async function lookupHgnc() {
        return (
            (await fetchHgncBy("symbol", upper).catch(() => null)) ??
            (await fetchHgncBy("alias_symbol", upper).catch(() => null)) ??
            (await fetchHgncBy("prev_symbol", upper).catch(() => null))
        );
    }

    const [hgncDoc, uniprotDoc, ensemblId] = await Promise.all([
        lookupHgnc(),
        fetchUniprotBySymbol(upper).catch(() => null),
        resolveSymbolToEnsemblId(upper).catch(() => null),
    ]);

    if (!hgncDoc && !uniprotDoc && !ensemblId) return null;

    const symbolFromHgnc = (hgncDoc as { symbol?: string } | null)?.symbol;
    const uniprotGene = uniprotDoc?.genes?.[0]?.geneName?.value;
    const resolvedSymbol = symbolFromHgnc ?? uniprotGene ?? upper;

    // Case-insensitive synonym dedup — UniProt and HGNC normalize differently
    // (e.g., HGNC "ERBB" vs. UniProt "Erbb"), and we don't want both shapes
    // landing in the synonyms list.
    const seenLower = new Set<string>([resolvedSymbol.toLowerCase()]);
    const synonyms: string[] = [];
    const addSynonym = (raw: string | undefined | null) => {
        if (!raw) return;
        const key = raw.toLowerCase();
        if (seenLower.has(key)) return;
        seenLower.add(key);
        synonyms.push(raw);
    };
    for (const s of (hgncDoc as { alias_symbol?: string[] } | null)?.alias_symbol ?? []) addSynonym(s);
    for (const s of (hgncDoc as { prev_symbol?: string[] } | null)?.prev_symbol ?? []) addSynonym(s);
    // Pull synonyms from every UniProt gene record — read-through transcripts
    // and multi-gene entries surface aliases beyond the primary record.
    for (const g of uniprotDoc?.genes ?? []) {
        for (const s of g.synonyms ?? []) addSynonym(s.value);
    }

    const hgncEnsembl = (hgncDoc as { ensembl_gene_id?: string } | null)?.ensembl_gene_id;

    return {
        symbol: resolvedSymbol,
        displayName: (hgncDoc as { name?: string } | null)?.name ?? uniprotDoc?.proteinDescription?.recommendedName?.fullName?.value ?? null,
        hgncId: (hgncDoc as { hgnc_id?: string } | null)?.hgnc_id ?? null,
        ensemblId: ensemblId ?? hgncEnsembl ?? null,
        uniprotId: uniprotDoc?.primaryAccession ?? null,
        synonyms: synonyms.sort((a, b) => a.localeCompare(b)),
    };
}
