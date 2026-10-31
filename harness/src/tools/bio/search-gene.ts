/**
 * searchGene — resolve gene identifiers against the Ensembl REST API.
 *
 * Ensembl itself keys only on a symbol (`/lookup/symbol`), which makes an
 * ENSG, a UniProt accession, a ChEMBL target id or an HGNC id unusable as
 * input. That is the identifier a user pastes, so this tool takes it: an
 * input that is not a plain symbol goes through `resolveTarget`, which anchors
 * it on HGNC and UniProt, and the approved symbol it returns is what reaches
 * Ensembl. `resolvedFrom` reports each such translation, thus the caller can
 * see which input became which symbol.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { lookupGenes, type GeneInfo } from "../lib/ensembl-client.js";
import { resolveTarget } from "../lib/identifier-resolver.js";

/**
 * How many identifiers a detail names before it switches to a count plus a
 * sample. Eight identifiers of typical length stay well inside the emit-site
 * cap, so the listed form is never the thing that trips it.
 */
const IDENTIFIERS_LISTED_IN_FULL = 8;

/**
 * The identifier spaces that Ensembl cannot key on. Anything that matches none
 * of them is treated as a symbol and goes straight to Ensembl.
 */
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- each entry is the fixed issued shape of one identifier space (Ensembl, HGNC, ChEMBL, UniProt); the alternation of the four is what keys the resolver.
const NON_SYMBOL_PATTERNS = [/^ENSG\d{11}$/, /^HGNC:\d+$/, /^CHEMBL\d+$/, /^[A-Z][0-9][A-Z0-9]{3}[0-9](-\d+)?$/];

function isSymbol(identifier: string): boolean {
    return !NON_SYMBOL_PATTERNS.some((pattern) => pattern.test(identifier));
}

/** One input that was not a symbol, beside the approved symbol it became. */
type ResolvedIdentifier = {
    input: string;
    symbol: string;
};

const SearchGeneOutputSchema = z.object({
    genes: z.array(
        z.object({
            symbol: z.string(),
            id: z.string().describe("The Ensembl gene id (ENSG…), the key of the other gene lookups."),
            displayName: z.string(),
            description: z.string(),
            biotype: z.string(),
            start: z.number(),
            end: z.number(),
            strand: z.number(),
            assemblyName: z.string(),
            seqRegionName: z.string(),
        }),
    ),
    resolvedFrom: z.array(z.object({ input: z.string(), symbol: z.string() })),
    notFound: z.array(z.string()),
});

export const searchGeneTool = defineTool({
    id: "search_gene",
    description:
        "Resolve gene identifiers against Ensembl — the identifier step other tools depend on. Per gene: Ensembl gene ID (ENSG…), coordinates, strand, " +
        "biotype, assembly, description; plus resolvedFrom[] and notFound[]. Gene-level only — no transcripts or exons. Batch up to 200 identifiers per " +
        "call.\n" +
        "ACCEPTED IDENTIFIERS, mixed freely in one call: a HUGO gene symbol ('BRCA1'), an Ensembl gene ID ('ENSG00000012048'), an HGNC ID ('HGNC:1100'), " +
        "a six-character UniProt accession ('P38398') and a ChEMBL target ID ('CHEMBL5619'); a ten-character accession ('A0A0B4J1Y9') is read " +
        "as a symbol and lands in notFound. An input that is not a symbol is anchored on the HGNC and UniProt " +
        "registries first, and the approved symbol it yields is reported in resolvedFrom[] — that anchoring is human, so a non-symbol input with a " +
        "non-human `species` looks the ortholog up by the human approved symbol.\n" +
        "notFound is valid no-data (a deprecated, aliased or mistyped identifier, or one this species has no gene for) — report it and continue, do not " +
        "retry unchanged.",
    outputSchema: SearchGeneOutputSchema,
    inputSchema: z.object({
        identifiers: z
            .array(z.string())
            .min(1)
            .max(200)
            .describe("Gene identifiers to look up, mixed freely (e.g. ['BRCA1', 'ENSG00000141510', 'P38398', 'HGNC:1100', 'CHEMBL5619'])"),
        species: z.string().default("homo_sapiens").describe("Species name (e.g. 'homo_sapiens', 'mus_musculus')"),
    }),
    view: "none",
    // The identifiers are the call. A large batch is summarized here rather than
    // left to the emit-site cap: that cap cuts at a character, so a 200-symbol
    // join arrives ending in `TP5` — a fragment that reads as a real symbol and
    // says nothing about how many were dropped. The count leads, so a batch is
    // legible as a batch even when the sample after it is itself trimmed.
    describeCall: ({ identifiers }) =>
        identifiers.length <= IDENTIFIERS_LISTED_IN_FULL
            ? identifiers.join(", ")
            : `${identifiers.length} genes: ${identifiers.slice(0, IDENTIFIERS_LISTED_IN_FULL).join(", ")}, …`,
    execute: async ({ identifiers, species }) => {
        const symbols: string[] = [];
        const resolvedFrom: ResolvedIdentifier[] = [];
        const notFound: string[] = [];

        for (const identifier of identifiers) {
            const trimmed = identifier.trim();
            if (isSymbol(trimmed)) {
                symbols.push(trimmed);
                continue;
            }
            // `resolveTarget` throws when it can anchor the input on no human
            // gene. That is absence, so it becomes a notFound row.
            try {
                const resolved = await resolveTarget(trimmed);
                resolvedFrom.push({ input: trimmed, symbol: resolved.geneSymbol });
                symbols.push(resolved.geneSymbol);
            } catch {
                notFound.push(trimmed);
            }
        }

        const genes: GeneInfo[] = [];
        if (symbols.length > 0) {
            const lookup = await lookupGenes(symbols, { species });
            genes.push(...lookup.genes);
            notFound.push(...lookup.notFound);
        }

        return ok({ genes, resolvedFrom, notFound });
    },
});
