/**
 * searchOpenTargets — query Open Targets Platform for target-disease
 * associations, genetic evidence, tractability, and known drug scores.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchDiseaseAssociations, searchTargetAssociations } from "../lib/opentargets-client.js";

export const searchOpenTargetsTool = defineTool({
    id: "search_opentargets",
    description:
        "Search Open Targets Platform for target-disease associations, genetic evidence, tractability, and known drug scores. Query by Ensembl gene ID (target mode) or EFO disease ID (disease mode).",
    inputSchema: z.object({
        query: z.string().describe("Ensembl gene ID (e.g. ENSG00000141510) or EFO disease ID (e.g. EFO_0000311)"),
        searchType: z.enum(["target", "disease"]).describe("'target' to find diseases for a gene, 'disease' to find targets for a disease"),
        limit: z.number().int().min(1).max(100).default(25).describe("Max results to return"),
    }),
    execute: async ({ query, searchType, limit = 25 }) => {
        if (searchType === "target") {
            const targetInfo = await searchTargetAssociations(query, limit);
            return ok({ targetInfo, associations: targetInfo?.associations ?? [] });
        }
        const associations = await searchDiseaseAssociations(query, limit);
        return ok({ associations });
    },
});
