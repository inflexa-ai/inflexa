/**
 * Pure async client functions for the NCBI ClinVar API.
 *
 * Used by §3.4 (Genetic Alterations — ClinVar variants).
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { ncbiUrl } from "./ncbi-utils.js";

export type ClinicalSignificance = "pathogenic" | "likely-pathogenic" | "benign" | "likely-benign" | "uncertain";

export interface ClinvarVariant {
    variationId: string;
    title: string;
    clinicalSignificance: string;
    reviewStatus: string;
    geneSymbol: string;
    molecularConsequence: string;
    conditions: string[];
    accession: string;
}

// NCBI esummary wire shapes, validated at the fetch boundary. Every field is
// optional — esummary omits absent values, and the record mapping below tolerates
// partial payloads, so an over-strict schema would regress graceful degradation.

/** NCBI esummary v2 germline classification block. */
const ClinvarClassificationSchema = z.object({
    description: z.string().optional(),
    review_status: z.string().optional(),
    trait_set: z.array(z.object({ trait_name: z.string().optional() })).optional(),
});
type ClinvarClassification = z.infer<typeof ClinvarClassificationSchema>;

/**
 * A single ClinVar esummary record.
 *
 * `variant_type` is a field of `variation_set[]`, and never of the nested
 * `variation_loc[]`, which carries the assembly coordinates alone.
 */
const ClinvarSummaryRecordSchema = z.object({
    title: z.string().optional(),
    accession: z.string().optional(),
    genes: z.array(z.object({ symbol: z.string().optional() })).optional(),
    germline_classification: ClinvarClassificationSchema.optional(),
    molecular_consequence_list: z.array(z.string()).optional(),
    variation_set: z.array(z.object({ variant_type: z.string().optional() })).optional(),
});
type ClinvarSummaryRecord = z.infer<typeof ClinvarSummaryRecordSchema>;

export const ClinvarSearchResponseSchema = z.object({
    esearchresult: z
        .object({
            idlist: z.array(z.string()).optional(),
            count: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
});

// esummary keys each record under its UID; the `uids` key holds a string[] of
// the returned UIDs, so a record value is a summary object OR that string[].
// The array member is listed first so an actual array never falls through to
// the object schema (which rejects arrays).
export const ClinvarSummaryResponseSchema = z.object({
    result: z.record(z.string(), z.union([z.array(z.string()), ClinvarSummaryRecordSchema])).optional(),
});

const SIG_MAP: Record<ClinicalSignificance, string> = {
    pathogenic: "clinsig_pathogenic",
    "likely-pathogenic": "clinsig_likely_pathogenic",
    benign: "clinsig_benign",
    "likely-benign": "clinsig_likely_benign",
    uncertain: "clinsig_vus",
};

/** Filter out uninformative ClinVar entries (literal "not provided", placeholders). */
export function filterInformative(variants: ClinvarVariant[]): ClinvarVariant[] {
    const noise = /^(not provided|not specified|reclassified)$/i;
    return variants.filter((v) => {
        const sig = (v.clinicalSignificance ?? "").trim();
        if (!sig || noise.test(sig)) return false;
        return true;
    });
}

export async function searchClinvar(
    ncbiApiKey: string | undefined,
    query: string,
    options: { clinicalSignificance?: ClinicalSignificance; limit?: number } = {},
): Promise<{ totalFound: number; variants: ClinvarVariant[] }> {
    const limit = options.limit ?? 20;
    let searchTerm = query;
    if (options.clinicalSignificance) {
        searchTerm += ` AND ${SIG_MAP[options.clinicalSignificance]}[Properties]`;
    }

    const searchUrl = ncbiUrl(ncbiApiKey, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", {
        db: "clinvar",
        term: searchTerm,
        retmax: String(limit),
        retmode: "json",
    });
    const searchRes = await apiFetchValidated(searchUrl, ClinvarSearchResponseSchema);
    if (searchRes.isErr()) throw new Error(describeApiError(searchRes.error));

    const ids: string[] = searchRes.value?.esearchresult?.idlist ?? [];
    const totalFound = Number(searchRes.value?.esearchresult?.count ?? ids.length);

    if (ids.length === 0) return { totalFound, variants: [] };

    const summaryUrl = ncbiUrl(ncbiApiKey, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", {
        db: "clinvar",
        id: ids.join(","),
        retmode: "json",
    });
    const summaryRes = await apiFetchValidated(summaryUrl, ClinvarSummaryResponseSchema);
    if (summaryRes.isErr()) throw new Error(describeApiError(summaryRes.error));

    return { totalFound, variants: mapClinvarVariants(ids, summaryRes.value) };
}

/**
 * Map one ClinVar esummary answer onto the variant records.
 *
 * `ids` is the id list of the search, and it names the order of the answer when
 * the answer carries no `uids` key. The function is pure, thus the
 * golden-fixture table exercises it against a stored payload.
 */
export function mapClinvarVariants(ids: string[], summary: z.infer<typeof ClinvarSummaryResponseSchema>): ClinvarVariant[] {
    const result: Record<string, ClinvarSummaryRecord | string[] | undefined> = summary?.result ?? {};
    const rawUids = result.uids;
    const uids: string[] = Array.isArray(rawUids) ? rawUids : ids;

    return uids.map((uid) => {
        const recEntry = result[uid];
        const rec: ClinvarSummaryRecord = recEntry && !Array.isArray(recEntry) ? recEntry : {};
        const genes = rec.genes ?? [];
        const geneSymbol = genes[0]?.symbol ?? "";
        // NCBI esummary v2: `germline_classification` holds the primary
        // pathogenicity call, and it holds the conditions.
        const germline: ClinvarClassification = rec.germline_classification ?? {};
        const clinSig = germline.description ?? "";
        const reviewStatus = germline.review_status ?? "";
        const conditions = (germline.trait_set ?? []).map((t) => t.trait_name ?? "");
        // The record of a copy-number variant carries an empty consequence list,
        // and the variant type of the variation set is the answer there. Thus an
        // empty list must fall through, and it must not join to an empty string.
        const consequences = rec.molecular_consequence_list ?? [];
        const variantTypes = (rec.variation_set ?? []).map((vs) => vs.variant_type ?? "").filter(Boolean);
        const molecularConsequence = (consequences.length > 0 ? consequences : variantTypes).join(", ");
        return {
            variationId: uid,
            title: rec.title ?? "",
            clinicalSignificance: clinSig,
            reviewStatus,
            geneSymbol,
            molecularConsequence,
            conditions,
            accession: rec.accession ?? `VCV${uid.padStart(9, "0")}`,
        };
    });
}
