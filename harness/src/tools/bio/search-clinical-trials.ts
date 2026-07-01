/**
 * searchClinicalTrials — search ClinicalTrials.gov for clinical trials.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchTrials } from "../lib/clinical-trials-client.js";

export const searchClinicalTrialsTool = defineTool({
    id: "search_clinical_trials",
    description:
        "Search ClinicalTrials.gov for clinical trials by condition, intervention (drug/gene therapy), or target gene. Use to understand the clinical landscape for a therapeutic target or disease indication.",
    inputSchema: z.object({
        query: z.string().describe("Search term: condition name, drug name, gene symbol, or NCT ID"),
        phase: z.enum(["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4"]).optional().describe("Filter by trial phase"),
        status: z.enum(["RECRUITING", "ACTIVE_NOT_RECRUITING", "COMPLETED", "NOT_YET_RECRUITING"]).optional().describe("Filter by recruitment status"),
        limit: z.number().int().min(1).max(50).default(20).describe("Max trials to return"),
    }),
    execute: async ({ query, phase, status, limit = 20 }) => {
        const result = await searchTrials(query, { phase, status, limit });
        return ok({ totalFound: result.totalFound, trials: result.trials });
    },
});
