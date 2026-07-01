/**
 * searchFaers — search FDA FAERS for adverse event reports for a drug.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getFaersByDrug } from "../lib/openfda-client.js";

export const searchFaersTool = defineTool({
    id: "search_faers",
    description:
        "Search FDA FAERS (Adverse Event Reporting System) for adverse event reports associated with a drug. Returns the most frequently reported adverse reactions. Use to assess real-world safety signals for drugs or drug candidates targeting a specific gene/pathway.",
    inputSchema: z.object({
        drugName: z.string().describe("Drug generic name (e.g. imatinib, pembrolizumab)"),
        limit: z.number().int().min(1).max(100).default(25).describe("Max adverse event types to return"),
        serious: z.boolean().default(false).describe("Filter to serious adverse events only"),
    }),
    execute: async ({ drugName, limit = 25, serious = false }) => {
        const result = await getFaersByDrug(drugName, { limit, serious });
        return ok({
            totalReports: result.totalReports,
            adverseEvents: result.adverseEvents,
        });
    },
});
