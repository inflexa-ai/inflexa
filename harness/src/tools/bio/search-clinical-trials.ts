/**
 * searchClinicalTrials — search ClinicalTrials.gov for clinical trials, and
 * read one study back by the NCT id that a search returns.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`). `action` defaults to 'search', thus the
 * common call stays a query and nothing more.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { getTrialDetails, searchTrials, type ClinicalTrial, type TrialDetails } from "../lib/clinical-trials-client.js";

/** briefSummary preview length when `includeSummaries` is off. */
const SUMMARY_PREVIEW_CHARS = 300;

/** A listed trial keeps the full record, or the preview shape that trims it. */
type TrialListRow = ClinicalTrial | (Omit<ClinicalTrial, "detailedDescription"> & { summaryTruncated: boolean });

/** One result shape per action — the key names the records it carries. */
type ClinicalTrialsOutput = { trial: TrialDetails | null } | { totalFound: number; trials: TrialListRow[] };

export const searchClinicalTrialsTool = defineTool({
    id: "search_clinical_trials",
    description:
        "Search ClinicalTrials.gov — the trial registry of the U.S. National Library of Medicine, which holds interventional and observational studies " +
        "worldwide — to map the clinical development landscape for a target, drug, or indication: what is being tried, at what phase, by whom, and what " +
        "stopped.\n" +
        "action 'search' (the default) returns totalFound plus per trial: NCT ID, title, status, phase, conditions, interventions, enrollment, start and " +
        "completion dates, sponsor, whyStopped (the termination reason, when there is one) and a briefSummary preview — set includeSummaries for the full " +
        "protocol prose.\n" +
        "action 'details' takes ONE nctId and returns that study in full: the same trial record plus outcomes[] (each primary/secondary/other outcome " +
        "measure with its numeric effect where the sponsor posted results) and the reported adverse events with their per-arm counts. This is how you " +
        "read a result, as opposed to finding a trial.\n" +
        "ACCEPTED IDENTIFIERS: `query` is free text matched across the whole study record, so a gene symbol ('KRAS'), a drug or brand name ('imatinib', " +
        "'Gleevec'), a condition ('melanoma') or an NCT ID ('NCT00000102') all work. `nctId` takes one NCT ID and nothing else.\n" +
        "`status` is an optional server-side filter and `phase` narrows the returned page. Omit both to see the full landscape. totalFound reports the true " +
        "match count of `query` plus `status`, thus it can exceed the trials that a phase-narrowed answer carries.\n" +
        "ABSENCE IS NORMAL. An empty trials array is a valid 'nothing matched' (often an over-narrow filter) and a null trial from 'details' means the " +
        "registry holds no such NCT ID — report it and move on, do not retry the identical call. A trial with no posted results carries empty outcomes " +
        "and adverse events, which means unreported, never zero.",
    inputSchema: z
        .object({
            action: z
                .enum(["search", "details"])
                .default("search")
                .describe("'search' (default) — find trials with `query`. 'details' — read one trial, with its outcomes and adverse events, by `nctId`."),
            query: z.string().optional().describe("Required for 'search'. Free-text search term: condition name, drug/brand name, gene symbol, or an NCT ID."),
            nctId: z
                .string()
                .optional()
                .describe("Required for 'details'. One ClinicalTrials.gov registry ID, e.g. 'NCT00000102' — exactly as the nctId field of a search result."),
            phase: z
                .enum(["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4"])
                .optional()
                .describe(
                    "'search' only. Optional exact phase filter, applied to the returned page rather than to the whole query. Omit for all phases " +
                        "(observational and expanded-access studies carry no phase and are excluded when this is set). A narrow phase over a broad query " +
                        "can give fewer trials than `limit` asks for, even when the registry holds more.",
                ),
            status: z
                .enum(["RECRUITING", "ACTIVE_NOT_RECRUITING", "COMPLETED", "NOT_YET_RECRUITING", "TERMINATED", "WITHDRAWN", "SUSPENDED"])
                .optional()
                .describe(
                    "'search' only. Optional recruitment-status filter. Omit for all statuses. TERMINATED (stopped early), WITHDRAWN (stopped before " +
                        "enrollment) and SUSPENDED are the attrition record — filter on one of them to ask what failed, and read whyStopped for the reason.",
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(10)
                .describe("'search' only. Max trials to return (default 10, max 50). totalFound reports the true match count regardless."),
            includeSummaries: z
                .boolean()
                .default(false)
                .describe(
                    "'search' only. Default FALSE — briefSummary comes back as a 300-character preview and detailedDescription is omitted, which is enough " +
                        "to map a landscape. Set true for the full protocol prose, and narrow `limit` when you do: a full summary runs to several thousand " +
                        "characters per trial.",
                ),
        })
        .refine((d) => d.action === "details" || (d.query !== undefined && d.query.trim().length > 0), {
            message: "query is required when action is 'search' — the free text to match across the study records.",
            path: ["query"],
        })
        .refine((d) => d.action !== "details" || (d.nctId !== undefined && d.nctId.trim().length > 0), {
            message: "nctId is required when action is 'details' — one NCT ID, e.g. 'NCT00000102'. Find one with action 'search'.",
            path: ["nctId"],
        }),
    describeCall: "none",
    execute: async ({
        action = "search",
        query,
        nctId,
        phase,
        status,
        limit = 10,
        includeSummaries = false,
    }): Promise<Result<ClinicalTrialsOutput, ToolError>> => {
        if (action === "details") {
            return ok({ trial: await getTrialDetails(nctId!) });
        }

        const result = await searchTrials(query!, { phase, status, limit });
        const trials = includeSummaries
            ? result.trials
            : result.trials.map(({ detailedDescription: _detailedDescription, ...trial }) => ({
                  ...trial,
                  briefSummary: trial.briefSummary === null ? null : trial.briefSummary.slice(0, SUMMARY_PREVIEW_CHARS),
                  summaryTruncated: (trial.briefSummary?.length ?? 0) > SUMMARY_PREVIEW_CHARS,
              }));
        return ok({ totalFound: result.totalFound, trials });
    },
});
