/**
 * getImpcKoProfile tool — mouse knockout phenotype profile via IMPC Solr.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { buildViabilityCalls, derivedViability, getKoPhenotypeProfile, parsePhenotypeResponse } from "../lib/impc-client.js";

export type { PhenotypeProfile, ViabilityCall, ViabilityCategory } from "../lib/impc-client.js";
export { buildViabilityCalls, derivedViability, parsePhenotypeResponse };

export const getImpcKoProfileTool = defineTool({
    id: "get_impc_ko_profile",
    description:
        "Get mouse knockout phenotype profile from IMPC: significant phenotype terms, " +
        "affected organ systems, sex-dimorphism, and pre-weaning viability " +
        "(lethal / subviable / viable, with per-zygosity breakdown). " +
        "Use to assess loss-of-function consequences and target tractability. " +
        "Single human gene symbol per call.",
    inputSchema: z.object({
        geneSymbol: z.string().min(1).describe("Human gene symbol, e.g. 'BRCA1'."),
    }),
    execute: async ({ geneSymbol }) => ok(await getKoPhenotypeProfile(geneSymbol)),
});
