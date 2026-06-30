/**
 * searchBgeeExpression tool — cross-species baseline gene expression.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { SUPPORTED_SPECIES, bucketRank, getMultiSpeciesExpression, parseExpressionResponse } from "../lib/bgee-client.js";

export type { SupportedSpecies } from "../lib/bgee-client.js";
export { SUPPORTED_SPECIES, bucketRank, parseExpressionResponse };

export const searchBgeeExpressionTool = defineTool({
    id: "search_bgee_expression",
    description:
        "Get baseline gene expression across species (human, mouse, rat, dog, macaque) from Bgee. " +
        "Returns per-species tissue × expression-rank tables. Use to assess whether a target is " +
        "expressed in tissues of interest, and whether model organisms are suitable surrogates. " +
        "NOT for differential expression — use the analysis pipeline for that.",
    inputSchema: z.object({
        geneSymbol: z.string().min(1).describe("Human gene symbol, e.g. 'BRCA1'."),
        species: z
            .array(z.enum(SUPPORTED_SPECIES))
            .min(1)
            .default([...SUPPORTED_SPECIES])
            .describe(
                "Species to fetch. Defaults to all five supported: homo_sapiens, mus_musculus, " + "rattus_norvegicus, canis_lupus_familiaris, macaca_mulatta.",
            ),
    }),
    execute: async ({ geneSymbol, species }) => ok(await getMultiSpeciesExpression(geneSymbol, species)),
});
