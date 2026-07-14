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
        "Search ChEMBL for biological targets by gene symbol, protein name, or ChEMBL target ID. " +
        "This is the resolution step that turns a gene symbol into the target ChEMBL ID required by get_bioactivity (type='target') and search_compounds (searchType='target'). " +
        "Returns per target: targetChemblId, preferredName, targetType (e.g. SINGLE PROTEIN, PROTEIN COMPLEX), organism, geneNames. " +
        "Results span organisms — check `organism` before using an ID, since the top hit for a human gene symbol may be a non-human ortholog. " +
        "An empty array is a valid 'no match' — do not retry.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Gene symbol (e.g. 'EGFR', 'ABL1'), protein name, or a ChEMBL target ID."),
        limit: z.number().int().min(1).max(25).default(25).describe("Max targets to return (default 25)."),
    }),
    execute: async ({ query, limit }) => {
        const targets = await searchTargets(query, limit);
        return ok({ targets });
    },
});
