/**
 * getPubchemAssays tool — retrieve bioassay screening summaries for a PubChem CID.
 *
 * Returns per-assay activity outcomes (active/inactive/inconclusive),
 * target names, and assay descriptions. Broader coverage than ChEMBL's
 * curated bioactivity data.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "../lib/pubchem-config.js";

interface Assay {
    aid: number;
    assayName: string | null;
    targetName: string | null;
    activityOutcome: string | null;
    activityValue: number | null;
}

// The PUG-REST assay-summary wire shape (a table of columns + rows), validated
// at the fetch boundary; `parseAssaySummary` maps the heading-indexed cells into
// `Assay` records. Every field is optional — PubChem omits absent values.
const PugAssaySummarySchema = z.object({
    Table: z
        .object({
            Columns: z
                .object({
                    Column: z.array(z.object({ Heading: z.string().optional() })).optional(),
                })
                .optional(),
            Row: z
                .array(
                    z.object({
                        Cell: z
                            .array(
                                z.object({
                                    intval: z.number().optional(),
                                    fval: z.number().optional(),
                                    sval: z.string().optional(),
                                }),
                            )
                            .optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});
type PugAssaySummary = z.infer<typeof PugAssaySummarySchema>;

function parseAssaySummary(data: PugAssaySummary): Assay[] {
    const columns = data.Table?.Columns?.Column ?? [];
    const rows = data.Table?.Row ?? [];

    // Find column indices by heading
    const headingIndex = new Map<string, number>();
    for (let i = 0; i < columns.length; i++) {
        if (columns[i].Heading) {
            headingIndex.set(columns[i].Heading!, i);
        }
    }

    const aidIdx = headingIndex.get("AID");
    const nameIdx = headingIndex.get("AssayName");
    const targetIdx = headingIndex.get("TargetName");
    const outcomeIdx = headingIndex.get("ActivityOutcome");
    const valueIdx = headingIndex.get("ActivityValue");

    const results: Assay[] = [];

    for (const row of rows) {
        const cells = row.Cell ?? [];

        const getCellStr = (idx: number | undefined): string | null => {
            if (idx === undefined || idx >= cells.length) return null;
            return cells[idx]?.sval ?? null;
        };
        const getCellNum = (idx: number | undefined): number | null => {
            if (idx === undefined || idx >= cells.length) return null;
            const cell = cells[idx];
            if (cell?.fval !== undefined) return cell.fval;
            if (cell?.intval !== undefined) return cell.intval;
            return null;
        };

        results.push({
            aid: getCellNum(aidIdx) ?? 0,
            assayName: getCellStr(nameIdx),
            targetName: getCellStr(targetIdx),
            activityOutcome: getCellStr(outcomeIdx),
            activityValue: getCellNum(valueIdx),
        });
    }

    return results;
}

export const getPubchemAssaysTool = defineTool({
    id: "get_pubchem_assays",
    description:
        "Get PubChem bioassay screening summaries for a CID — use it to answer 'has this compound ever been screened, and against what?'. " +
        "Returns per assay: aid, assayName, targetName, activityOutcome (Active / Inactive / Inconclusive / Unspecified) and activityValue. " +
        "This is broad HTS screening coverage, not curated potency: for numbers you intend to quote (IC50/Ki), prefer ChEMBL's get_bioactivity. " +
        "An empty assays array is valid no-data (the compound was never screened) — do not retry.",
    inputSchema: z.object({
        cid: z.number().int().positive().describe("PubChem Compound ID as an integer (e.g. 2244 for aspirin), from a prior search_pubchem_compound call."),
        activeOnly: z.boolean().default(false).describe("Default false (all outcomes). Set true to keep only rows whose activityOutcome is 'Active'."),
        limit: z.number().int().min(1).max(500).default(50).describe("Max assay records to return (default 50). Applied after the activeOnly filter."),
    }),
    execute: async ({ cid, activeOnly = false, limit = 50 }) => {
        const url = `${PUBCHEM_BASE}/compound/cid/${cid}/assaysummary/JSON`;

        const res = await apiFetchValidated(url, PugAssaySummarySchema, { headers: HEADERS });

        if (res.isErr()) {
            // PubChem returns 404 when the CID has no assay data — expected.
            if (res.error.type === "http_status" && res.error.status === 404) return ok({ assays: [] });
            throw new Error(describeApiError(res.error));
        }

        let assays = parseAssaySummary(res.value);

        if (activeOnly) {
            assays = assays.filter((a) => a.activityOutcome?.toLowerCase() === "active");
        }

        return ok({ assays: assays.slice(0, limit) });
    },
});
