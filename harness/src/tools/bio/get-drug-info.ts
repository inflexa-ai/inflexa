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
        "Search ChEMBL's drug registry by drug name or by disease indication — use it to answer 'what drugs treat X?' or 'is drug Y approved, and since when?'. " +
        "Returns per drug: moleculeChemblId, preferredName, maxPhase (4 = approved), moleculeType (small molecule, antibody, …), firstApproval year, and indication. " +
        "If the drug endpoint yields nothing it falls back to a molecule search filtered to max_phase >= 4; rows from that fallback carry indication: null. " +
        "Use the returned moleculeChemblId as the input to get_mechanism or get_bioactivity. " +
        "An empty array means no approved drug matched — valid no-data, do not retry.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Drug name (e.g. 'imatinib') or a disease indication (e.g. 'melanoma', 'breast cancer')."),
        limit: z.number().int().min(1).max(25).default(25).describe("Max drug records to return (default 25)."),
    }),
    execute: async ({ query, limit }) => {
        const drugs = await getDrugInfo(query, limit);
        return ok({ drugs });
    },
});
