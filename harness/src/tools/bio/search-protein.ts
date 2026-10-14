/**
 * searchProtein — resolve a protein against UniProtKB.
 *
 * `search_gene` accepts a UniProt accession, but it answers with Ensembl gene
 * records, thus nothing gave an agent the protein itself: the name, the length,
 * the curated function, and where in the cell it acts. This tool answers that,
 * and its accession is the key that the structural tools take.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { searchProteins, type UniProtProtein } from "../lib/uniprot-client.js";

/** Rows returned by default. An exact gene symbol resolves to one reviewed protein. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export type SearchProteinOutput = {
    readonly proteins: UniProtProtein[];
    /** True when UniProt held at least one row beyond `limit`. */
    readonly hasMore: boolean;
};

export const searchProteinTool = defineTool({
    id: "search_protein",
    description:
        "UniProtKB — the curated protein knowledgebase of EMBL-EBI, SIB and PIR. Resolves a protein and answers with its accession, its UniProtKB ID " +
        "('BRCA1_HUMAN'), its recommended name, its gene names, its sequence length, its curated FUNCTION summary, and its subcellular locations.\n" +
        "ACCEPTED IDENTIFIERS: a HUGO gene symbol ('BRCA1'), matched exactly, or a UniProt accession ('P38398', 'A0A0B4J1Y9'). The two spaces overlap — " +
        "'P2RY12' is both a real symbol and a valid accession shape — so an accession-shaped input searches BOTH, and either kind resolves. A protein " +
        "NAME is not accepted; resolve the symbol first.\n" +
        "This is the tool that produces a UniProt accession, which is the key that the structure tools take. Prefer it over search_gene when the " +
        "question is about the PROTEIN — what it does, how long it is, where it acts — and search_gene when the question is about the gene locus, its " +
        "coordinates or its Ensembl ID.\n" +
        "`reviewedOnly` defaults to true, thus an answer holds Swiss-Prot entries only: manually curated, one entry per gene, and the right default for " +
        "a human question. Set it false to reach TrEMBL as well, which is machine-annotated and holds many isoform-level rows per gene — needed for a " +
        "protein that Swiss-Prot has not curated.\n" +
        "`organismId` takes an NCBI Taxonomy ID and defaults to 9606 (human); pass 10090 for mouse, or null to search every organism. Both this and " +
        "`reviewedOnly` narrow a SYMBOL match only — an accession is a unique key, so it resolves whatever its organism or review status.\n" +
        "An empty `proteins` array is valid no-data (an unrecognized symbol, or one this organism has no entry for) — report it and continue, do not " +
        "retry the same call. `hasMore` true means the answer was trimmed to `limit`.",
    inputSchema: z.object({
        query: z.string().min(1).describe("A gene symbol ('BRCA1') or a UniProt accession ('P38398')."),
        organismId: z
            .number()
            .int()
            .positive()
            .nullable()
            .default(9606)
            .describe("NCBI Taxonomy ID (9606 = human, 10090 = mouse). Null searches every organism, which is how to reach a non-model species."),
        reviewedOnly: z.boolean().default(true).describe("True (default) keeps Swiss-Prot entries only. False also returns machine-annotated TrEMBL entries."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LIMIT)
            .default(DEFAULT_LIMIT)
            .describe(
                `Max proteins returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). An exact symbol under reviewedOnly resolves to one entry, so raise ` +
                    "this only for a reviewedOnly=false survey, where a gene carries many TrEMBL rows.",
            ),
    }),
    describeCall: ({ query }) => query,
    execute: async ({ query, organismId, reviewedOnly, limit }): Promise<Result<SearchProteinOutput, ToolError>> => {
        const result = await searchProteins(query, {
            organismId: !(organismId === null) ? organismId : undefined,
            reviewedOnly,
            limit,
        });
        return ok(result);
    },
});
