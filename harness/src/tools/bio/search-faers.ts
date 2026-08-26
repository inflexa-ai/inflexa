/**
 * searchFaers — one tool over the two openFDA drug corpora: the FAERS
 * spontaneous adverse-event reports and the Structured Product Labels.
 *
 * The three actions answer one question between them — what is known about
 * the post-market safety of this molecule. `adverse_events` ranks the reported
 * reactions, `seriousness` counts the outcome flags behind them, and `label`
 * gives the regulatory answer: the boxed warning, the Section 5 warnings, and
 * whether a REMS program constrains the drug.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`).
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    getDrugLabelActions,
    getFaersByDrug,
    getFaersSeriousness,
    type AdverseEventCount,
    type DrugLabelAction,
    type SeriousnessProfile,
} from "../lib/openfda-client.js";

/** `label` returns whole prose sections, so its ceiling is far below the others. */
const LABEL_MAX_LIMIT = 10;
const LABEL_DEFAULT_LIMIT = 3;

/** One result shape per action — the key names the records it carries. */
type FaersOutput =
    { totalReports: number | undefined; adverseEvents: AdverseEventCount[] } | { seriousness: SeriousnessProfile | null } | { labels: DrugLabelAction[] };

export const searchFaersTool = defineTool({
    id: "search_faers",
    description:
        "openFDA — the post-market drug record of the U.S. Food and Drug Administration, across two corpora: FAERS (the FDA Adverse Event Reporting " +
        "System, spontaneous reports) and the Structured Product Labels (the approved prescribing information, served through DailyMed). Three lookups; " +
        "pick with `action`.\n" +
        "'adverse_events' (default) — totalReports and adverseEvents[] { reaction (MedDRA preferred term), count }, most-reported first. These are " +
        "spontaneous report COUNTS, not incidence rates: there is no denominator and reporting is heavily biased, so use them to rank signals, never to " +
        "state a rate.\n" +
        "'seriousness' — the outcome breakdown behind those reports: totalReports plus fatalCount, hospitalizationCount, lifeThreateningCount, " +
        "disablingCount, congenitalAnomalyCount and otherSeriousCount. This is how you tell a common nuisance reaction from a lethal one; the same " +
        "no-denominator caveat holds.\n" +
        "'label' — the regulatory position on the drug: boxedWarning text, the Section 5 warningsAndCautions excerpt, a REMS indicator, the brand and " +
        "generic names, the application number, the label effective date and a citable DailyMed URL. This is the only action that carries an official " +
        "warning rather than a report count.\n" +
        "ACCEPTED IDENTIFIERS: a drug name in `drugName`. 'adverse_events' and 'seriousness' match the openFDA GENERIC name only — 'imatinib' works, the " +
        "brand name 'Gleevec' does not. 'label' matches the generic OR the brand name, so a brand name goes in there and the genericName field of each " +
        "row gives you the generic to use for the other two actions.\n" +
        "For mechanism-based liabilities of a TARGET (rather than a marketed drug), use target_safety; for a chemical's toxicology use comptox.\n" +
        "ABSENCE IS NORMAL: an empty adverseEvents array, a null seriousness, or an empty labels array means the drug is absent from that corpus under " +
        "that name — say so and continue, do not retry the same name.",
    inputSchema: z
        .object({
            action: z
                .enum(["adverse_events", "seriousness", "label"])
                .default("adverse_events")
                .describe(
                    "'adverse_events' (default) — the ranked reaction terms. 'seriousness' — the outcome-flag breakdown for the same reports. 'label' — " +
                        "the FDA label: boxed warning, Section 5 warnings and REMS.",
                ),
            drugName: z
                .string()
                .min(1)
                .describe(
                    "The drug name. Generic (INN) for 'adverse_events' and 'seriousness', e.g. 'imatinib' or 'pembrolizumab' — a brand name matches " +
                        "nothing there. 'label' also accepts a brand name, e.g. 'Gleevec'.",
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe(
                    `'adverse_events': max distinct adverse-reaction terms to return, most-reported first (default 15, max 100); totalReports covers the ` +
                        `whole drug regardless. 'label': max label versions, newest first (default ${LABEL_DEFAULT_LIMIT}, max ${LABEL_MAX_LIMIT}) — a ` +
                        `boxed warning runs to thousands of characters, so raise it only to trace how a warning changed. Ignored by 'seriousness'.`,
                ),
            serious: z
                .boolean()
                .default(false)
                .describe(
                    "'adverse_events' only. When true, count only reports flagged serious (death, hospitalization, life-threatening, disabling). For the " +
                        "breakdown of WHICH serious outcome, use action 'seriousness' instead.",
                ),
        })
        .refine((d) => d.action !== "label" || d.limit === undefined || d.limit <= LABEL_MAX_LIMIT, {
            message: `limit is capped at ${LABEL_MAX_LIMIT} for action 'label' — each label version carries whole prose sections`,
            path: ["limit"],
        }),
    describeCall: "none",
    execute: async ({ action = "adverse_events", drugName, limit, serious = false }): Promise<Result<FaersOutput, ToolError>> => {
        switch (action) {
            case "seriousness":
                return ok({ seriousness: await getFaersSeriousness(drugName) });
            case "label":
                return ok({ labels: await getDrugLabelActions(drugName, { limit: limit ?? LABEL_DEFAULT_LIMIT }) });
            case "adverse_events": {
                const result = await getFaersByDrug(drugName, { limit: limit ?? 15, serious });
                return ok({ totalReports: result.totalReports, adverseEvents: result.adverseEvents });
            }
        }
    },
});
