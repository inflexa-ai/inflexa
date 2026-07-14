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
        "Get BASELINE (healthy, untreated) gene expression across species from Bgee — use it to judge tissue-of-action ('where is this target expressed?') and model-organism " +
        "suitability ('is the mouse a fair surrogate for this gene?'). " +
        "NOT for differential expression between conditions — that is the analysis pipeline's job, never this tool. " +
        "Takes a human gene symbol and resolves the per-species orthologs itself, returning a per-species tissue table: each tissue carries an expression score, a gold/silver confidence, " +
        "an expressed / not-expressed state, and a bucketed rank (absent | low | medium | high). Species with no ortholog are listed in notFound. " +
        "Sparse output is valid no-data: dog and macaque coverage is thin, and a null humanEnsemblId means the symbol did not resolve. Do NOT retry on empty output.",
    inputSchema: z.object({
        geneSymbol: z
            .string()
            .min(1)
            .describe(
                "HUMAN gene symbol, e.g. 'BRCA1' — one gene per call. Ensembl IDs and non-human symbols are not accepted; the human symbol is resolved to an ENSG and orthologs are looked up per species.",
            ),
        species: z
            .array(z.enum(SUPPORTED_SPECIES))
            .min(1)
            .default([...SUPPORTED_SPECIES])
            .describe(
                "Species to fetch, any subset of: homo_sapiens, mus_musculus, rattus_norvegicus, canis_lupus_familiaris, macaca_mulatta. " +
                    "Defaults to all five — narrow it only when the cross-species comparison is not needed.",
            ),
    }),
    execute: async ({ geneSymbol, species }) => ok(await getMultiSpeciesExpression(geneSymbol, species)),
});
