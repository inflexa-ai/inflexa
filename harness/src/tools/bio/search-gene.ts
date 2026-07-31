/**
 * searchGene — look up gene information via the Ensembl REST API.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { lookupGenes } from "../lib/ensembl-client.js";

/**
 * How many symbols a detail names before it switches to a count plus a sample.
 * Eight symbols of typical length stay well inside the emit-site cap, so the
 * listed form is never the thing that trips it.
 */
const SYMBOLS_LISTED_IN_FULL = 8;

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
    // The symbols are the call. A large batch is summarized here rather than
    // left to the emit-site cap: that cap cuts at a character, so a 200-symbol
    // join arrives ending in `TP5` — a fragment that reads as a real symbol and
    // says nothing about how many were dropped. The count leads, so a batch is
    // legible as a batch even when the sample after it is itself trimmed.
    describeCall: ({ symbols }) =>
        symbols.length <= SYMBOLS_LISTED_IN_FULL ? symbols.join(", ") : `${symbols.length} genes: ${symbols.slice(0, SYMBOLS_LISTED_IN_FULL).join(", ")}, …`,
    execute: async ({ symbols, species }) => ok(await lookupGenes(symbols, { species })),
});
