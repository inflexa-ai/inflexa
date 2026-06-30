/**
 * getMechanism tool — retrieve mechanism of action data from ChEMBL.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getMechanism } from "../lib/chembl-client.js";

export const getMechanismTool = defineTool({
    id: "get_mechanism",
    description: "Get mechanism of action for a compound from ChEMBL. " + "Returns mechanism descriptions, action types, and associated target information.",
    inputSchema: z.object({
        chemblId: z.string().min(1).describe("Compound ChEMBL ID (e.g. 'CHEMBL25' for aspirin)"),
    }),
    execute: async ({ chemblId }) => {
        const mechanisms = await getMechanism(chemblId);
        return ok({ mechanisms });
    },
});
