/**
 * searchTargets tool — search ChEMBL for biological targets.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchTargets } from "../lib/chembl-client.js";

export const searchTargetsTool = defineTool({
    id: "search_targets",
    description:
        "Search ChEMBL for biological targets by gene symbol, protein name, or ChEMBL ID. " +
        "Returns target metadata including ChEMBL IDs, target type, organism, and gene names.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Search term: gene symbol (e.g. 'EGFR'), protein name, or ChEMBL target ID"),
        limit: z.number().int().min(1).max(25).default(25).describe("Maximum number of targets to return"),
    }),
    execute: async ({ query, limit }) => {
        const targets = await searchTargets(query, limit);
        return ok({ targets });
    },
});
