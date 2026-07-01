/**
 * searchGene — look up gene information via the Ensembl REST API.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { lookupGenes } from "../lib/ensembl-client.js";

export const searchGeneTool = defineTool({
    id: "search_gene",
    description:
        "Look up gene information from Ensembl by gene symbol. " +
        "Returns Ensembl IDs, genomic coordinates, biotype, and descriptions. " +
        "Supports batch lookups of up to 200 symbols at once.",
    inputSchema: z.object({
        symbols: z.array(z.string()).min(1).max(200).describe("Gene symbols to look up (e.g. ['BRCA1', 'TP53'])"),
        species: z.string().default("homo_sapiens").describe("Species name (e.g. 'homo_sapiens', 'mus_musculus')"),
        expand: z.boolean().default(false).describe("Include transcript/exon details in the response"),
    }),
    execute: async ({ symbols, species, expand }) => ok(await lookupGenes(symbols, { species, expand })),
});
