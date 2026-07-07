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

/** NCBI esummary v2 classification block (germline or legacy). */
interface ClinvarClassification {
    description?: string;
    review_status?: string;
    trait_set?: Array<{ trait_name?: string }>;
}

/** A single ClinVar esummary record. */
interface ClinvarSummaryRecord {
    title?: string;
    accession?: string;
    genes?: Array<{ symbol?: string }>;
    germline_classification?: ClinvarClassification;
    clinical_significance?: ClinvarClassification | string;
    trait_set?: Array<{ trait_name?: string }>;
    molecular_consequence_list?: string[];
    variation_set?: Array<{ variation_loc?: Array<{ variant_type?: string }> }>;
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
    const searchRes = await apiFetch<{ esearchresult?: { idlist?: string[]; count?: string | number } }>(searchUrl);
    if (searchRes.isErr()) throw new Error(describeApiError(searchRes.error));

    const ids: string[] = searchRes.value?.esearchresult?.idlist ?? [];
    const totalFound = Number(searchRes.value?.esearchresult?.count ?? ids.length);

    if (ids.length === 0) return { totalFound, variants: [] };

    const summaryUrl = ncbiUrl(ncbiApiKey, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", {
        db: "clinvar",
        id: ids.join(","),
        retmode: "json",
    });
    const summaryRes = await apiFetch<{ result?: Record<string, ClinvarSummaryRecord | string[] | undefined> }>(summaryUrl);
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
