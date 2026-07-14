/**
 * searchPharmgkb — search PharmGKB for pharmacogenomic clinical annotations.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { PHARMGKB_BASE, PHARMGKB_HEADERS } from "../lib/pharmgkb-config.js";

// Raw PharmGKB clinicalAnnotation wire shape, validated at the fetch boundary.
// Every field is optional because the API omits absent values; the mapper in
// `execute` folds request context (`query`) into its output, so the schema
// models only the raw wire and the mapping stays where it is.
const PharmgkbAnnotationSchema = z.object({
    location: z.object({ genes: z.array(z.object({ symbol: z.string().optional() })).optional() }).optional(),
    relatedChemicals: z.array(z.object({ name: z.string().optional() })).optional(),
    levelOfEvidence: z.object({ term: z.string().optional() }).optional(),
});

const PharmgkbResponseSchema = z.object({
    data: z.array(PharmgkbAnnotationSchema).optional(),
});

export const searchPharmgkbTool = defineTool({
    id: "search_pharmgkb",
    description:
        "Search PharmGKB clinical annotations for a gene-drug pharmacogenomic link — use it to judge whether a gene affects a drug's metabolism, efficacy, or toxicity. " +
        "Returns annotations[]: { gene, drug, levelOfEvidence (PharmGKB 1A…4, where 1A is guideline-backed) }. The phenotype, guidelineSource and summary fields are always null " +
        "in this tool's output — treat levelOfEvidence as the only strength signal and do not attribute CPIC/DPWG guideline text to it. " +
        "Matching is an exact field filter, not a search: 'CYP2D6' resolves, 'cytochrome P450 2D6' does not. " +
        "An empty annotations array is valid no-data (no curated PGx link) — do not retry.",
    inputSchema: z.object({
        query: z
            .string()
            .describe(
                "Exact gene symbol (e.g. 'CYP2D6') when searchType='gene', or exact drug name (e.g. 'tamoxifen') when searchType='drug'. No fuzzy matching.",
            ),
        searchType: z.enum(["gene", "drug"]).describe("'gene' filters PharmGKB on location.genes.symbol; 'drug' filters on relatedChemicals.name."),
        limit: z.number().int().min(1).max(50).default(20).describe("Max annotations to return (default 20, max 50); applied client-side after the fetch."),
    }),
    execute: async ({ query, searchType, limit = 20 }) => {
        const filter = searchType === "gene" ? `location.genes.symbol=${encodeURIComponent(query)}` : `relatedChemicals.name=${encodeURIComponent(query)}`;
        const endpoint = `${PHARMGKB_BASE}/clinicalAnnotation?${filter}`;

        const res = await apiFetchValidated(endpoint, PharmgkbResponseSchema, { headers: PHARMGKB_HEADERS });
        if (res.isErr()) throw new Error(describeApiError(res.error));

        const data = res.value?.data ?? [];
        const annotations = data.slice(0, limit).map((ann) => ({
            gene: ann.location?.genes?.map((g) => g.symbol).join(", ") ?? query,
            drug: ann.relatedChemicals?.map((c) => c.name).join(", ") ?? "",
            phenotype: null,
            levelOfEvidence: ann.levelOfEvidence?.term ?? "Unknown",
            guidelineSource: null,
            summary: null,
        }));

        return ok({ annotations });
    },
});
