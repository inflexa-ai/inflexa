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
        "Resolve gene symbols against Ensembl — the identifier step other tools depend on. Per symbol: Ensembl gene ID (ENSG…), coordinates, strand, " +
        "biotype, assembly, description; plus notFound[]. Gene-level only — no transcripts or exons. Batch up to 200 symbols per call. " +
        "notFound is valid no-data (deprecated, aliased or mistyped symbol, or wrong species) — do not retry unchanged.",
    inputSchema: z.object({
        symbols: z.array(z.string()).min(1).max(200).describe("Gene symbols to look up (e.g. ['BRCA1', 'TP53'])"),
        species: z.string().default("homo_sapiens").describe("Species name (e.g. 'homo_sapiens', 'mus_musculus')"),
    }),
    execute: async ({ symbols, species }) => ok(await lookupGenes(symbols, { species })),
});
