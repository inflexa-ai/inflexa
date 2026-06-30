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
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "../lib/pubchem-config.js";

interface Assay {
    aid: number;
    assayName: string | null;
    targetName: string | null;
    activityOutcome: string | null;
    activityValue: number | null;
}

interface PugAssaySummary {
    Table?: {
        Columns?: {
            Column?: Array<{ Heading?: string }>;
        };
        Row?: Array<{
            Cell?: Array<{
                intval?: number;
                fval?: number;
                sval?: string;
            }>;
        }>;
    };
}

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
        "Get bioassay screening summaries for a PubChem CID. " +
        "Returns per-assay activity outcomes (Active/Inactive/Inconclusive), target names, " +
        "and activity values. Covers HTS screening data beyond ChEMBL's curated bioactivity. " +
        "Use activeOnly=true to filter for active results only.",
    inputSchema: z.object({
        cid: z.number().int().positive().describe("PubChem Compound ID (CID)"),
        activeOnly: z.boolean().default(false).describe("If true, return only assays where the compound was active"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum number of assay records to return"),
    }),
    execute: async ({ cid, activeOnly = false, limit = 50 }) => {
        const url = `${PUBCHEM_BASE}/compound/cid/${cid}/assaysummary/JSON`;

        const res = await apiFetch<PugAssaySummary>(url, { headers: HEADERS });

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
