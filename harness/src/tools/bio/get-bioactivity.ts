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
        "Get bioactivity data (IC50, EC50, Ki, etc.) from ChEMBL for a compound or target. " +
        "Returns activity values, assay information, and pChEMBL values. " +
        "Optionally filter by activity type (e.g. 'IC50', 'EC50', 'Ki').",
    inputSchema: z.object({
        chemblId: z.string().min(1).describe("ChEMBL ID (e.g. 'CHEMBL25' for aspirin, 'CHEMBL203' for EGFR target)"),
        type: z.enum(["compound", "target"]).describe("Whether the ChEMBL ID refers to a compound or a target"),
        activityType: z.string().optional().describe("Filter by standard_type (e.g. 'IC50', 'EC50', 'Ki')"),
        limit: z.number().int().min(1).max(500).default(500).describe("Maximum number of activity records to return"),
    }),
    execute: async ({ chemblId, type, activityType, limit }) => {
        const activities = await getBioactivity(chemblId, type, { activityType, limit });
        return ok({ activities });
    },
});
