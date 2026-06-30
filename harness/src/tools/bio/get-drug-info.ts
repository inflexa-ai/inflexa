/**
 * getDrugInfo tool — search ChEMBL for approved drugs by indication or name.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getDrugInfo } from "../lib/chembl-client.js";

export const getDrugInfoTool = defineTool({
    id: "get_drug_info",
    description:
        "Search ChEMBL for approved drugs by indication or drug name. " +
        "Returns drug metadata including approval phase, molecule type, " +
        "first approval year, and indications. Falls back to molecule search " +
        "filtered by max_phase >= 4 if the drug endpoint yields no results.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Drug name or indication to search for (e.g. 'imatinib', 'breast cancer')"),
        limit: z.number().int().min(1).max(25).default(25).describe("Maximum number of results to return"),
    }),
    execute: async ({ query, limit }) => {
        const drugs = await getDrugInfo(query, limit);
        return ok({ drugs });
    },
});
