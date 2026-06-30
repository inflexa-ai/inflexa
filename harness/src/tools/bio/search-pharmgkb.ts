/**
 * searchPharmgkb — search PharmGKB for pharmacogenomic clinical annotations.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { PHARMGKB_BASE, PHARMGKB_HEADERS } from "../lib/pharmgkb-config.js";

export const searchPharmgkbTool = defineTool({
    id: "search_pharmgkb",
    description:
        "Search PharmGKB for pharmacogenomic clinical annotations — gene-drug interactions, dosing guidelines (CPIC/DPWG), and variant-level clinical significance. Use to determine if a gene variant affects drug metabolism, efficacy, or toxicity.",
    inputSchema: z.object({
        query: z.string().describe("Gene symbol (e.g. CYP2D6) or drug name (e.g. tamoxifen)"),
        searchType: z.enum(["gene", "drug"]).describe("Search by gene or drug"),
        limit: z.number().int().min(1).max(50).default(20).describe("Max results"),
    }),
    execute: async ({ query, searchType, limit = 20 }) => {
        const filter = searchType === "gene" ? `location.genes.symbol=${encodeURIComponent(query)}` : `relatedChemicals.name=${encodeURIComponent(query)}`;
        const endpoint = `${PHARMGKB_BASE}/clinicalAnnotation?${filter}`;

        const res = await apiFetch<any>(endpoint, { headers: PHARMGKB_HEADERS });
        if (res.isErr()) throw new Error(describeApiError(res.error));

        const data = res.value?.data ?? [];
        const annotations = data.slice(0, limit).map((ann: any) => ({
            gene: ann.location?.genes?.map((g: any) => g.symbol).join(", ") ?? query,
            drug: ann.relatedChemicals?.map((c: any) => c.name).join(", ") ?? "",
            phenotype: null,
            levelOfEvidence: ann.levelOfEvidence?.term ?? "Unknown",
            guidelineSource: null,
            summary: null,
        }));

        return ok({ annotations });
    },
});
