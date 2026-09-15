/**
 * Pure async client functions for the UniProt REST API
 * (https://rest.uniprot.org/uniprotkb/).
 *
 * Absence policy: the OpenAPI document of UniProt marks no field as required,
 * and the API omits the key of an absent value. Thus a maybe-absent field
 * carries `.optional()`, not `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { UNIPROT_BASE, UNIPROT_HEADERS } from "./uniprot-config.js";

export interface UniProtRecord {
    primaryAccession: string;
    uniProtkbId: string | null;
    geneNames: string[];
    chemblIds: string[];
    reactomePathwayIds: string[];
    proteinFamilyText: string | null;
}

const RawCommentSchema = z.object({
    commentType: z.string().optional(),
    texts: z.array(z.object({ value: z.string().optional() })).optional(),
});
type RawComment = z.infer<typeof RawCommentSchema>;

const FIELDS = ["accession", "id", "gene_names", "xref_chembl", "xref_reactome", "cc_similarity"].join(",");

function extractFamilyText(comments?: RawComment[]): string | null {
    if (!comments) return null;
    for (const c of comments) {
        if (c.commentType !== "SIMILARITY") continue;
        for (const t of c.texts ?? []) {
            const v = t.value?.trim();
            if (v) return v;
        }
    }
    return null;
}

// A single schema that both validates the raw UniProtKB wire shape and
// normalizes it into the `UniProtRecord` we return. Every field is optional
// because the API omits absent values; parsing IS the validation, so a payload
// whose field TYPES drift is rejected as `invalid_response` rather than silently
// mis-mapped. `z.infer` of the transform is the `UniProtRecord` output type.
const UniProtRecordSchema = z
    .object({
        primaryAccession: z.string().optional(),
        uniProtkbId: z.string().optional(),
        genes: z
            .array(
                z.object({
                    geneName: z.object({ value: z.string().optional() }).optional(),
                    synonyms: z.array(z.object({ value: z.string().optional() })).optional(),
                }),
            )
            .optional(),
        uniProtKBCrossReferences: z.array(z.object({ database: z.string().optional(), id: z.string().optional() })).optional(),
        comments: z.array(RawCommentSchema).optional(),
    })
    .transform((raw): UniProtRecord => {
        const chemblIds: string[] = [];
        const reactomeIds: string[] = [];
        for (const x of raw.uniProtKBCrossReferences ?? []) {
            if (!x.id) continue;
            if (x.database === "ChEMBL") chemblIds.push(x.id);
            else if (x.database === "Reactome") reactomeIds.push(x.id);
        }
        const geneNames: string[] = [];
        for (const g of raw.genes ?? []) {
            const name = g.geneName?.value;
            if (name) geneNames.push(name);
        }
        return {
            primaryAccession: raw.primaryAccession ?? "",
            uniProtkbId: raw.uniProtkbId ?? null,
            geneNames,
            chemblIds,
            reactomePathwayIds: reactomeIds,
            proteinFamilyText: extractFamilyText(raw.comments),
        };
    });

/**
 * Fetch a single UniProtKB entry by accession. Returns null on 404; throws
 * on other HTTP errors so callers can surface upstream outages.
 */
export async function getUniProtRecord(accession: string): Promise<UniProtRecord | null> {
    const url = `${UNIPROT_BASE}/uniprotkb/${encodeURIComponent(accession)}?fields=${FIELDS}&format=json`;
    const res = await apiFetchValidated(url, UniProtRecordSchema, { headers: UNIPROT_HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return null;
        throw new Error(describeApiError(res.error));
    }
    if (!res.value.primaryAccession) return null;
    return res.value;
}

/** All ChEMBL target ids cross-referenced from a UniProt accession. */
export async function getChemblIdsByUniProt(accession: string): Promise<string[]> {
    const rec = await getUniProtRecord(accession);
    return rec?.chemblIds ?? [];
}

/** All Reactome pathway ids cross-referenced from a UniProt accession. */
export async function getReactomePathwaysByUniProt(accession: string): Promise<string[]> {
    const rec = await getUniProtRecord(accession);
    return rec?.reactomePathwayIds ?? [];
}

/** One protein of a UniProtKB search. */
export interface UniProtProtein {
    accession: string;
    /** The UniProtKB ID, for example `BRCA1_HUMAN`. */
    uniProtkbId: string | null;
    proteinName: string | null;
    geneNames: string[];
    sequenceLength: number | null;
    /** The curated FUNCTION comment, trimmed to a readable length. */
    function: string | null;
    /** The distinct curated subcellular locations, in the order UniProt lists them. */
    subcellularLocations: string[];
    /** True for a Swiss-Prot entry, false for a TrEMBL entry. */
    reviewed: boolean;
}

/**
 * The field list of the search. It is separate from `FIELDS` on purpose:
 * `FIELDS` feeds `getUniProtRecord`, thus a widening of it would change what
 * that function reads.
 */
const SEARCH_FIELDS = ["accession", "id", "protein_name", "gene_names", "length", "cc_function", "cc_subcellular_location"].join(",");

/** A FUNCTION comment runs to several hundred words; this is what one answer carries. */
const MAX_FUNCTION_CHARS = 1200;

/**
 * `entryType` reads `UniProtKB reviewed (Swiss-Prot)` or
 * `UniProtKB unreviewed (TrEMBL)`. The unreviewed value HOLDS the reviewed one
 * as a substring, thus the negative test must run first. A test for `reviewed`
 * alone answers true for every entry of either kind.
 */
const REVIEWED_ENTRY_TYPE = "reviewed";
const UNREVIEWED_ENTRY_TYPE = "unreviewed";

/** Is the entry a curated Swiss-Prot record, as opposed to a machine-annotated TrEMBL one? */
function isReviewedEntry(entryType: string | undefined): boolean {
    const value = (entryType ?? "").toLowerCase();
    if (value.includes(UNREVIEWED_ENTRY_TYPE)) return false;
    return value.includes(REVIEWED_ENTRY_TYPE);
}

const SearchCommentSchema = z.object({
    commentType: z.string().optional(),
    texts: z.array(z.object({ value: z.string().optional() })).optional(),
    subcellularLocations: z.array(z.object({ location: z.object({ value: z.string().optional() }).optional() })).optional(),
});

const ProteinNameSchema = z.object({ fullName: z.object({ value: z.string().optional() }).optional() });

/**
 * One result row of `uniprotkb/search`, with the same all-optional discipline as
 * `UniProtRecordSchema`: UniProt omits the key of an absent value, thus every
 * field carries `.optional()` and none carries `.nullable()`.
 *
 * A TrEMBL row can carry `submissionNames` in place of `recommendedName`
 * (`X5D778` is one), thus the name reader falls back rather than reporting the
 * protein as unnamed.
 */
export const UniProtSearchResultSchema = z.object({
    primaryAccession: z.string().optional(),
    uniProtkbId: z.string().optional(),
    entryType: z.string().optional(),
    proteinDescription: z
        .object({
            recommendedName: ProteinNameSchema.optional(),
            submissionNames: z.array(ProteinNameSchema).optional(),
        })
        .optional(),
    genes: z.array(z.object({ geneName: z.object({ value: z.string().optional() }).optional() })).optional(),
    sequence: z.object({ length: z.number().optional() }).optional(),
    comments: z.array(SearchCommentSchema).optional(),
});

/** The search envelope. It is exported so that the golden-fixture table drives it. */
export const UniProtSearchResponseSchema = z.object({
    results: z.array(UniProtSearchResultSchema).optional(),
});

type UniProtSearchResult = z.infer<typeof UniProtSearchResultSchema>;

/** Read the protein name, preferring the recommended name over a submitted one. */
function extractProteinName(raw: UniProtSearchResult): string | null {
    const description = raw.proteinDescription;
    const recommended = description?.recommendedName?.fullName?.value?.trim();
    if (recommended) return recommended;
    for (const submitted of description?.submissionNames ?? []) {
        const value = submitted.fullName?.value?.trim();
        if (value) return value;
    }
    return null;
}

/** Read the first FUNCTION comment, capped at {@link MAX_FUNCTION_CHARS}. */
function extractFunctionText(raw: UniProtSearchResult): string | null {
    for (const comment of raw.comments ?? []) {
        if (comment.commentType !== "FUNCTION") continue;
        for (const text of comment.texts ?? []) {
            const value = text.value?.trim();
            if (value) return value.length > MAX_FUNCTION_CHARS ? `${value.slice(0, MAX_FUNCTION_CHARS)}…` : value;
        }
    }
    return null;
}

/**
 * Read the distinct subcellular locations. UniProt splits them over more than
 * one SUBCELLULAR LOCATION comment, and it repeats a location across them, thus
 * the reader collects across every comment and keeps the first occurrence only.
 */
function extractSubcellularLocations(raw: UniProtSearchResult): string[] {
    const locations: string[] = [];
    const seen = new Set<string>();
    for (const comment of raw.comments ?? []) {
        if (comment.commentType !== "SUBCELLULAR LOCATION") continue;
        for (const entry of comment.subcellularLocations ?? []) {
            const value = entry.location?.value?.trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            locations.push(value);
        }
    }
    return locations;
}

function toProtein(raw: UniProtSearchResult): UniProtProtein {
    return {
        accession: raw.primaryAccession ?? "",
        uniProtkbId: raw.uniProtkbId ?? null,
        proteinName: extractProteinName(raw),
        geneNames: (raw.genes ?? []).map((gene) => gene.geneName?.value).filter((name): name is string => Boolean(name)),
        sequenceLength: raw.sequence?.length ?? null,
        function: extractFunctionText(raw),
        subcellularLocations: extractSubcellularLocations(raw),
        reviewed: isReviewedEntry(raw.entryType),
    };
}

/**
 * The accession forms that UniProt itself documents: the six-character form and
 * the ten-character form, with an optional isoform suffix.
 *
 * The shape does NOT tell an accession from a gene symbol, because the two
 * spaces overlap: `P2RY12`, `B3GAT1`, and their siblings are real gene symbols
 * that match this form. Thus the match decides only whether the `accession:`
 * clause is SAFE to send, never which space the query names.
 */
const ACCESSION_RE = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?$/i;

/**
 * Can the query ride in an `accession:` clause?
 *
 * UniProt validates the value of that clause, and it answers HTTP 400 for a
 * value that is not accession-shaped. Thus a plain symbol such as `BRCA1` must
 * never reach one, because the 400 fails the whole request.
 */
export function isUniProtAccession(query: string): boolean {
    return ACCESSION_RE.test(query.trim());
}

/**
 * Build the UniProtKB query.
 *
 * The organism filter and the reviewed filter narrow an ambiguous SYMBOL
 * search. An accession is a unique key, thus the filters must not reach it: a
 * lookup of `P02769` under the human default would otherwise answer nothing,
 * although the accession names bovine serum albumin.
 *
 * An accession-shaped input is ambiguous, because the two identifier spaces
 * overlap. Such an input searches both, and the unfiltered accession clause is
 * OR-ed with the filtered symbol clause. An input that is not
 * accession-shaped searches the symbol space alone.
 *
 * The accession side carries `active:true`, and that is the one filter it
 * takes. A deleted accession still answers an `accession:` query, as an
 * `Inactive` row with no name and no function, and `UniProtProtein` has no
 * field for the deletion reason. `B3GAT1` is such a case: the gene symbol also
 * names a deleted TrEMBL accession, thus without the filter the answer holds
 * the human protein and a hollow second row.
 */
function buildSearchQuery(query: string, organismId: number | undefined, reviewedOnly: boolean): string {
    const symbolClauses = [`gene_exact:${query}`];
    if (organismId !== undefined) symbolClauses.push(`organism_id:${organismId}`);
    if (reviewedOnly) symbolClauses.push("reviewed:true");
    const symbolQuery = symbolClauses.join(" AND ");

    if (!isUniProtAccession(query)) return symbolQuery;
    return `((accession:${query} AND active:true) OR (${symbolQuery}))`;
}

export interface SearchProteinsOptions {
    /** NCBI taxonomy id; omit to search every organism. */
    organismId?: number;
    /** Swiss-Prot only when true (the default), Swiss-Prot and TrEMBL when false. */
    reviewedOnly?: boolean;
    /** Max rows returned. */
    limit?: number;
}

export interface SearchProteinsResult {
    proteins: UniProtProtein[];
    /** True when UniProt held at least one row beyond `limit`. */
    hasMore: boolean;
}

/**
 * Search UniProtKB for a protein by gene symbol or by accession.
 *
 * An unknown query is HTTP 200 with `{"results":[]}`, never a 404, thus the
 * empty result is an ordinary answer and never an error. The request asks for
 * one row beyond `limit`, because UniProt reports its match count in the
 * `x-total-results` header and `apiFetch` exposes no header. The extra row is
 * what separates a trimmed answer from a complete one.
 */
export async function searchProteins(query: string, opts: SearchProteinsOptions = {}): Promise<SearchProteinsResult> {
    const { organismId, reviewedOnly = true, limit = 10 } = opts;
    const trimmed = query.trim();

    const params = new URLSearchParams({
        query: buildSearchQuery(trimmed, organismId, reviewedOnly),
        fields: SEARCH_FIELDS,
        format: "json",
        size: String(limit + 1),
    });
    const res = await apiFetchValidated(`${UNIPROT_BASE}/uniprotkb/search?${params.toString()}`, UniProtSearchResponseSchema, { headers: UNIPROT_HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    const rows = res.value.results ?? [];
    return { proteins: rows.slice(0, limit).map(toProtein), hasMore: rows.length > limit };
}
