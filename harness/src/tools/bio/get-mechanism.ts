/**
 * getMechanism tool — retrieve mechanism of action data from ChEMBL.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getMechanism } from "../lib/chembl-client.js";

export const getMechanismTool = defineTool({
    id: "get_mechanism",
    description:
        "Get ChEMBL's curated mechanism of action for one compound — use it to answer 'how does drug X work?'. " +
        "Returns per mechanism: mechanismOfAction (prose), actionType (e.g. INHIBITOR, AGONIST, ANTAGONIST), targetChemblId and the resolved targetName, moleculeChemblId. " +
        "Takes a ChEMBL molecule ID, not a name: resolve the compound first with search_compounds or get_drug_info (or, from a PubChem hit, get_pubchem_cross_refs). " +
        "An empty array is valid no-data — ChEMBL curates mechanisms mainly for clinical/approved molecules, so tool compounds often have none. Do not retry.",
    inputSchema: z.object({
        chemblId: z
            .string()
            .min(1)
            .describe(
                "ChEMBL molecule ID (e.g. 'CHEMBL25' for aspirin), as returned by search_compounds / get_drug_info. " +
                    "Not a compound name and not a target ChEMBL ID.",
            ),
    }),
    execute: async ({ chemblId }) => {
        const mechanisms = await getMechanism(chemblId);
        return ok({ mechanisms });
    },
});
