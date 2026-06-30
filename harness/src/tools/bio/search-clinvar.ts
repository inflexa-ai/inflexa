/**
 * searchClinvar — search NCBI ClinVar for clinical significance of variants.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchClinvar } from "../lib/clinvar-client.js";

export function createSearchClinvarTool(deps: { ncbiApiKey?: string }) {
    return defineTool({
        id: "search_clinvar",
        description:
            "Search NCBI ClinVar for clinical significance of genetic variants. Returns pathogenicity classifications, associated conditions, and review status. Use to assess whether variants identified in omics data have known clinical significance.",
        inputSchema: z.object({
            query: z.string().describe("Gene symbol (e.g. BRCA1), variant (e.g. NM_007294.4:c.5266dupC), dbSNP rsID (e.g. rs80357906), or condition name"),
            clinicalSignificance: z
                .enum(["pathogenic", "likely-pathogenic", "benign", "likely-benign", "uncertain"])
                .optional()
                .describe("Filter by clinical significance"),
            limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
        }),
        execute: async ({ query, clinicalSignificance, limit = 20 }) => {
            const { totalFound, variants } = await searchClinvar(deps.ncbiApiKey, query, {
                clinicalSignificance,
                limit,
            });
            return ok({ totalFound, variants });
        },
    });
}
