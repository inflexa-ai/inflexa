/**
 * Pure async client functions for PharmGKB clinical annotations.
 *
 * Public API, no key required. Matching is an exact field filter, not a search:
 * `location.genes.symbol` for a gene, `relatedChemicals.name` for a drug.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { PHARMGKB_BASE, PHARMGKB_HEADERS } from "./pharmgkb-config.js";

// Raw PharmGKB clinicalAnnotation wire shape, validated at the fetch boundary.
// Every field is optional because the API omits absent values.
const PharmgkbAnnotationSchema = z.object({
    location: z.object({ genes: z.array(z.object({ symbol: z.string().optional() })).optional() }).optional(),
    relatedChemicals: z.array(z.object({ name: z.string().optional() })).optional(),
    levelOfEvidence: z.object({ term: z.string().optional() }).optional(),
});

const PharmgkbResponseSchema = z.object({
    data: z.array(PharmgkbAnnotationSchema).optional(),
});

/**
 * One PharmGKB clinical annotation.
 *
 * `levelOfEvidence` is the only strength signal this endpoint carries — the
 * phenotype, guideline source and summary live on other PharmGKB resources, so
 * they are absent here rather than present-and-null.
 */
export interface PharmgkbAnnotation {
    gene: string;
    drug: string;
    levelOfEvidence: string;
}

export async function searchPharmgkb(
    query: string,
    searchType: "gene" | "drug",
    limit = 20,
): Promise<{ annotations: PharmgkbAnnotation[]; totalFound: number }> {
    const filter = searchType === "gene" ? `location.genes.symbol=${encodeURIComponent(query)}` : `relatedChemicals.name=${encodeURIComponent(query)}`;

    const res = await apiFetchValidated(`${PHARMGKB_BASE}/clinicalAnnotation?${filter}`, PharmgkbResponseSchema, { headers: PHARMGKB_HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    const data = res.value?.data ?? [];
    const annotations = data.slice(0, limit).map((ann) => ({
        gene: ann.location?.genes?.map((g) => g.symbol).join(", ") ?? query,
        drug: ann.relatedChemicals?.map((c) => c.name).join(", ") ?? "",
        levelOfEvidence: ann.levelOfEvidence?.term ?? "Unknown",
    }));

    return { annotations, totalFound: data.length };
}
