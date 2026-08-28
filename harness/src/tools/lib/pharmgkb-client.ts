/**
 * Pure async client functions for the PharmGKB clinical annotations, which
 * ClinPGx now serves.
 *
 * Public API, no key required. Matching is an exact field filter, not a search:
 * `location.genes.symbol` for a gene, `relatedChemicals.name` for a drug.
 *
 * Absence policy: the sampled ClinPGx payloads carry no explicit `null`, and a
 * record omits the key of an absent value. Thus a maybe-absent field carries
 * `.optional()`, not `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { PHARMGKB_BASE, PHARMGKB_HEADERS } from "./pharmgkb-config.js";

// Raw ClinPGx clinicalAnnotation wire shape, validated at the fetch boundary.
export const PharmgkbAnnotationSchema = z.object({
    location: z.object({ genes: z.array(z.object({ symbol: z.string().optional() })).optional() }).optional(),
    relatedChemicals: z.array(z.object({ name: z.string().optional() })).optional(),
    levelOfEvidence: z.object({ term: z.string().optional() }).optional(),
});

// `data` is polymorphic by status: an array of annotation records on HTTP 200,
// and an error OBJECT (`{"errors":[…]}`) on a 4xx. The undeclared sibling key
// `status` carries `"success"` or `"fail"`. This schema models the 200 arm only,
// because the 4xx arm never reaches it — `apiFetch` reports a non-ok status as
// `http_status` before the body is parsed.
export const PharmgkbResponseSchema = z.object({
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
    if (res.isErr()) {
        // ClinPGx answers "no results matching criteria" with HTTP 404, not with
        // an empty array. A gene or a drug that the corpus does not annotate is
        // an expected miss, thus it gives an empty result. Every other failure
        // still throws, because it is an outage or a contract break.
        if (res.error.type === "http_status" && res.error.status === 404) return { annotations: [], totalFound: 0 };
        throw new Error(describeApiError(res.error));
    }

    const data = res.value?.data ?? [];
    const annotations = data.slice(0, limit).map((ann) => ({
        gene: ann.location?.genes?.map((g) => g.symbol).join(", ") ?? query,
        drug: ann.relatedChemicals?.map((c) => c.name).join(", ") ?? "",
        levelOfEvidence: ann.levelOfEvidence?.term ?? "Unknown",
    }));

    return { annotations, totalFound: data.length };
}
