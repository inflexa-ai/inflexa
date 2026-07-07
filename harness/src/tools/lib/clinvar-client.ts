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

/** NCBI esummary v2 classification block (germline or legacy). */
const ClinvarClassificationSchema = z.object({
    description: z.string().optional(),
    review_status: z.string().optional(),
    trait_set: z.array(z.object({ trait_name: z.string().optional() })).optional(),
});
type ClinvarClassification = z.infer<typeof ClinvarClassificationSchema>;

/** A single ClinVar esummary record. */
const ClinvarSummaryRecordSchema = z.object({
    title: z.string().optional(),
    accession: z.string().optional(),
    genes: z.array(z.object({ symbol: z.string().optional() })).optional(),
    germline_classification: ClinvarClassificationSchema.optional(),
    clinical_significance: z.union([ClinvarClassificationSchema, z.string()]).optional(),
    trait_set: z.array(z.object({ trait_name: z.string().optional() })).optional(),
    molecular_consequence_list: z.array(z.string()).optional(),
    variation_set: z.array(z.object({ variation_loc: z.array(z.object({ variant_type: z.string().optional() })).optional() })).optional(),
});
type ClinvarSummaryRecord = z.infer<typeof ClinvarSummaryRecordSchema>;

const ClinvarSearchResponseSchema = z.object({
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
const ClinvarSummaryResponseSchema = z.object({
    result: z.record(z.string(), z.union([z.array(z.string()), ClinvarSummaryRecordSchema])).optional(),
});

const SIG_MAP: Record<ClinicalSignificance, string> = {
    pathogenic: "clinsig_pathogenic",
    "likely-pathogenic": "clinsig_likely_pathogenic",
    benign: "clinsig_benign",
    "likely-benign": "clinsig_likely_benign",
    uncertain: "clinsig_uncertain",
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

    const result: Record<string, ClinvarSummaryRecord | string[] | undefined> = summaryRes.value?.result ?? {};
    const rawUids = result.uids;
    const uids: string[] = Array.isArray(rawUids) ? rawUids : ids;

    const variants: ClinvarVariant[] = uids.map((uid) => {
        const recEntry = result[uid];
        const rec: ClinvarSummaryRecord = recEntry && !Array.isArray(recEntry) ? recEntry : {};
        const genes = rec.genes ?? [];
        const geneSymbol = genes[0]?.symbol ?? "";
        // NCBI esummary v2 schema: germline_classification holds the primary
        // pathogenicity call. The legacy top-level clinical_significance field
        // no longer appears in responses — fall back gracefully for older cached data.
        const germline: ClinvarClassification = rec.germline_classification ?? {};
        // The legacy field is either a classification object or a bare string.
        const legacy = rec.clinical_significance;
        const legacyObj = typeof legacy === "object" ? legacy : null;
        const legacyStr = typeof legacy === "string" ? legacy : null;
        const clinSig = germline.description ?? legacyObj?.description ?? legacyStr ?? "";
        const reviewStatus = germline.review_status ?? legacyObj?.review_status ?? "";
        const conditions = (germline.trait_set ?? rec.trait_set ?? []).map((t) => t.trait_name ?? "");
        const molecularConsequence =
            rec.molecular_consequence_list?.join(", ") ??
            rec.variation_set
                ?.flatMap((vs) => vs.variation_loc ?? [])
                .map((vl) => vl.variant_type ?? "")
                .filter(Boolean)
                .join(", ") ??
            "";
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

    return { totalFound, variants };
}
