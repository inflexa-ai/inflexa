/**
 * resolveGeneIds — map gene identifiers across the HGNC symbol, the Entrez Gene
 * ID, the Ensembl gene ID, and the UniProt accession, through MyGene.info.
 *
 * `search_gene` answers with Ensembl records only. A source keyed on Entrez IDs
 * (`humanbase`) needs the mapping step that this tool gives, and in a script the
 * `entrez` field of a hit goes straight into the `entrez` argument of such a tool.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { MYGENE_HITS_PER_ID, resolveGeneIds, type GeneIdResolution } from "../lib/mygene-client.js";

const MAX_IDENTIFIERS = 200;

/**
 * How many identifiers a detail names before it switches to a count plus a
 * sample. Eight identifiers of typical length stay well inside the emit-site
 * cap, so the listed form is never the thing that trips it.
 */
const IDENTIFIERS_LISTED_IN_FULL = 8;

/** The ok value. A script reads it as data, thus the catalog of `run_script` shows this type. */
const outputSchema = z.object({
    genes: z.array(
        z.object({
            query: z.string(),
            symbol: z.string().nullable(),
            name: z.string().nullable(),
            entrez: z.number().nullable(),
            ensembl: z.array(z.string()),
            uniprot: z.array(z.string()),
        }),
    ),
    notFound: z.array(z.string()),
    ambiguous: z.array(z.string()),
    truncated: z.array(z.string()),
});

export const resolveGeneIdsTool = defineTool({
    id: "resolve_gene_ids",
    description:
        "Map gene identifiers across the HGNC symbol, the NCBI Entrez Gene ID, the Ensembl gene ID and the reviewed UniProt accession, through " +
        "MyGene.info — the ID step for a tool keyed on an ID that search_gene does not give, such as the Entrez IDs of humanbase.\n" +
        "ACCEPTED IDENTIFIERS, mixed freely in one call of up to 200: a current symbol ('BRCA1', any case), an Entrez ID ('672'), an Ensembl gene " +
        "ID ('ENSG00000012048'), or a UniProt accession ('P38398'). An old or informal symbol does not resolve, because an alias can name several " +
        "current genes: resolve it to its current HGNC symbol first.\n" +
        "Each hit carries the `query` that it answers, `symbol`, `name` (the full gene name), `entrez` (a number, or null for a gene with no " +
        "Entrez record), `ensembl` and `uniprot` (arrays: several Ensembl IDs mean copies on alternate haplotypes or strains, and their order " +
        "carries no rank). `notFound` lists each identifier with no gene. `ambiguous` lists each identifier with more than one gene, and each of " +
        "those genes is in `genes` — a UniProt accession shared by a family of genes gives every member. An identifier gives at most " +
        `${MYGENE_HITS_PER_ID} genes, and \`truncated\` lists each identifier that had more.\n` +
        "`species` takes a common name ('human', the default, 'mouse', 'rat', 'zebrafish') or an NCBI Taxonomy ID as a string ('9606').\n" +
        "notFound is valid no-data — report it and continue, do not retry unchanged.",
    inputSchema: z.object({
        identifiers: z
            .array(z.string())
            .min(1)
            .max(MAX_IDENTIFIERS)
            .describe(`Gene identifiers to map, mixed freely, max ${MAX_IDENTIFIERS} (e.g. ['BRCA1', '7157', 'ENSG00000146648', 'P38398']).`),
        species: z.string().trim().min(1).default("human").describe("A common name ('human', 'mouse') or an NCBI Taxonomy ID as a string ('9606')."),
    }),
    outputSchema,
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
    execute: async ({ identifiers, species }): Promise<Result<GeneIdResolution, ToolError>> => ok(await resolveGeneIds(identifiers, species)),
});
