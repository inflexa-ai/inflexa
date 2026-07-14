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
        "Search FDA FAERS for post-market adverse-event reports on one marketed drug — the real-world safety signal for a specific molecule. " +
        "Returns totalReports and adverseEvents[]: { reaction (MedDRA preferred term), count }, most-reported first. " +
        "These are spontaneous report counts, NOT incidence rates: there is no denominator and reporting is heavily biased, so use them to rank signals, never to state a rate. " +
        "Matching is on the openFDA GENERIC name only — 'imatinib' works, the brand name 'Gleevec' does not. For mechanism-based liabilities of a target (rather than a drug), use get_target_safety. " +
        "An empty adverseEvents array is valid no-data (drug absent from FAERS under that generic name) — do not retry.",
    inputSchema: z.object({
        drugName: z.string().describe("Generic (INN) drug name, e.g. 'imatinib', 'pembrolizumab'. Brand names do not match."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max distinct adverse-reaction terms to return (default 25, max 100)."),
        serious: z.boolean().default(false).describe("When true, count only reports flagged serious (death, hospitalization, life-threatening, disabling)."),
    }),
    execute: async ({ drugName, limit = 25, serious = false }) => {
        const result = await getFaersByDrug(drugName, { limit, serious });
        return ok({
            totalReports: result.totalReports,
            adverseEvents: result.adverseEvents,
        });
    },
});
