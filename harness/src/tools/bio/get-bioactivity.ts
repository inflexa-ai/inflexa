/**
 * getBioactivity tool — retrieve bioactivity data (IC50, EC50, Ki) from ChEMBL.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getBioactivity } from "../lib/chembl-client.js";

export const getBioactivityTool = defineTool({
    id: "get_bioactivity",
    description:
        "Get measured bioactivity rows (IC50, EC50, Ki, Kd, …) from ChEMBL — the curated, quotable potency data for a compound or a target. " +
        "Returns per activity: standardType, standardValue + standardUnits, pchemblValue (normalized -log10 potency), assayChemblId, assayType, compoundChemblId, targetChemblId. " +
        "Both `chemblId` and `type` are required — `type` declares which side of the activity table the ID indexes; resolve the ID first via search_compounds (compound) or search_targets (target). " +
        "Prefer this over get_pubchem_assays whenever you will quote a number: PubChem assay summaries are broader HTS screening outcomes, ChEMBL is curated. " +
        "An empty array is valid no-data (no recorded activity, or an activityType that matched nothing) — do not retry.",
    inputSchema: z.object({
        chemblId: z
            .string()
            .min(1)
            .describe(
                "A ChEMBL molecule ID (e.g. 'CHEMBL25' for aspirin) or target ID (e.g. 'CHEMBL203' for EGFR) — must agree with `type`. " +
                    "Obtain molecule IDs from search_compounds/get_drug_info and target IDs from search_targets.",
            ),
        type: z
            .enum(["compound", "target"])
            .describe(
                "Required. 'compound' — chemblId is a molecule ID; returns everything that molecule was assayed against. " +
                    "'target' — chemblId is a target ID; returns every compound assayed against that target.",
            ),
        activityType: z
            .string()
            .optional()
            .describe(
                "Optional exact ChEMBL standard_type filter, e.g. 'IC50', 'EC50', 'Ki', 'Kd'. Matched exactly (case-sensitive); omit to get all activity types.",
            ),
        limit: z.number().int().min(1).max(500).default(500).describe("Max activity records to return (default 500)."),
    }),
    execute: async ({ chemblId, type, activityType, limit }) => {
        const activities = await getBioactivity(chemblId, type, { activityType, limit });
        return ok({ activities });
    },
});
