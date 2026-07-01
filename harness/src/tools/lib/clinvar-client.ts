/**
 * Pure async client functions for the NCBI ClinVar API.
 *
 * Used by §3.4 (Genetic Alterations — ClinVar variants).
 */

import { apiFetch, describeApiError } from "./api-utils.js";
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
    const searchRes = await apiFetch<any>(searchUrl);
    if (searchRes.isErr()) throw new Error(describeApiError(searchRes.error));

    const ids: string[] = searchRes.value?.esearchresult?.idlist ?? [];
    const totalFound = Number(searchRes.value?.esearchresult?.count ?? ids.length);

    if (ids.length === 0) return { totalFound, variants: [] };

    const summaryUrl = ncbiUrl(ncbiApiKey, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", {
        db: "clinvar",
        id: ids.join(","),
        retmode: "json",
    });
    const summaryRes = await apiFetch<any>(summaryUrl);
    if (summaryRes.isErr()) throw new Error(describeApiError(summaryRes.error));

    const result = summaryRes.value?.result ?? {};
    const uids: string[] = result.uids ?? ids;

    const variants: ClinvarVariant[] = uids.map((uid) => {
        const rec = result[uid] ?? {};
        const genes = rec.genes ?? [];
        const geneSymbol = genes[0]?.symbol ?? "";
        // NCBI esummary v2 schema: germline_classification holds the primary
        // pathogenicity call. The legacy top-level clinical_significance field
        // no longer appears in responses — fall back gracefully for older cached data.
        const germline = rec.germline_classification ?? {};
        const clinSig = germline.description ?? rec.clinical_significance?.description ?? rec.clinical_significance ?? "";
        const reviewStatus = germline.review_status ?? rec.clinical_significance?.review_status ?? "";
        const conditions = (germline.trait_set ?? rec.trait_set ?? []).map((t: any) => t.trait_name ?? "");
        const molecularConsequence =
            rec.molecular_consequence_list?.join(", ") ??
            rec.variation_set
                ?.flatMap((vs: any) => vs.variation_loc ?? [])
                .map((vl: any) => vl.variant_type ?? "")
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
