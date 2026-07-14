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
        "Get the mouse-knockout phenotype profile for a gene from IMPC — the in-vivo loss-of-function evidence for target tractability and essentiality " +
        "('what happens to PAX5 knockout mice?', 'is loss of CASP8 lethal?'). " +
        "Takes a human gene symbol and maps it to the mouse ortholog itself. Returns a top-line pre-weaning viability call (lethal_pre_weaning | subviable | viable | null) with its " +
        "per-zygosity breakdown, the significant MP phenotype terms ordered by best p-value, the affected organ systems ranked by phenotype count, and a sex-dimorphism flag. " +
        "An all-empty profile (null mouseMarkerSymbol, null viability, no phenotype terms) means the gene has not been IMPC-phenotyped — common and valid. Do NOT retry on empty output.",
    inputSchema: z.object({
        geneSymbol: z
            .string()
            .min(1)
            .describe(
                "HUMAN gene symbol, e.g. 'BRCA1' — one gene per call. The mouse ortholog is resolved internally; do not pass a mouse symbol or an MGI ID.",
            ),
    }),
    execute: async ({ geneSymbol }) => ok(await getKoPhenotypeProfile(geneSymbol)),
});
