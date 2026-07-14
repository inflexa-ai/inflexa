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
        "Search ClinicalTrials.gov to map the clinical development landscape for a target, drug, or indication — what is being tried, at what phase, by whom, and what stopped. " +
        "Returns totalFound plus per trial: NCT ID, title, status, phase, conditions, interventions, enrollment, start and completion dates, sponsor, brief summary, and whyStopped " +
        "(the termination reason, when there is one). " +
        "`query` is free text matched across the whole study record, so a gene symbol, a drug name, a condition, or an NCT ID all work. " +
        "`phase` and `status` are optional server-side filters — omit them to see the full landscape; totalFound reports the true match count even when it exceeds the page returned. " +
        "An empty trials array is a valid 'nothing matched' (often an over-narrow filter) — do not retry the identical query.",
    inputSchema: z.object({
        query: z.string().describe("Free-text search term: condition name, drug/intervention name, gene symbol, or an NCT ID."),
        phase: z
            .enum(["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4"])
            .optional()
            .describe(
                "Optional exact phase filter. Omit for all phases (observational and expanded-access studies carry no phase and are excluded when this is set).",
            ),
        status: z
            .enum(["RECRUITING", "ACTIVE_NOT_RECRUITING", "COMPLETED", "NOT_YET_RECRUITING"])
            .optional()
            .describe(
                "Optional recruitment-status filter. Omit for all statuses — note TERMINATED/WITHDRAWN trials are not selectable here and appear only in an unfiltered search.",
            ),
        limit: z.number().int().min(1).max(50).default(20).describe("Max trials to return (default 20, max 50)."),
    }),
    execute: async ({ query, phase, status, limit = 20 }) => {
        const result = await searchTrials(query, { phase, status, limit });
        return ok({ totalFound: result.totalFound, trials: result.trials });
    },
});
