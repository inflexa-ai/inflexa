/**
 * searchInteractions — query protein-protein interactions via STRING DB.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { getEnrichment, getInteractionNetwork, getInteractionPartners, type StringEnrichment, type StringInteraction } from "../lib/string-client.js";

const DEFAULT_LIMIT = 20;

type InteractionsOutput =
    { enrichment: StringEnrichment[]; totalTerms: number } | { interactions: StringInteraction[] } | { interactions: StringInteraction[]; totalEdges: number };

export const searchInteractionsTool = defineTool({
    id: "search_interactions",
    description:
        "Query the STRING database — the protein-protein association network of EMBL, which folds experimental, database, co-expression and text-mined " +
        "evidence into one confidence score — for interactions and gene-set functional enrichment. " +
        "'partners' — the one-hop interaction partners of the input proteins, score-sorted: 'what else does this protein work with?'. " +
        "'network' — the interactions AMONG the input proteins only, no new nodes: 'is my gene set actually connected?'. " +
        "'enrichment' — statistical over-representation of GO, KEGG, Reactome and Pfam terms in the input set, FDR-sorted: the enrichment TEST, as " +
        "opposed to lookup_annotation, which just reads a vocabulary. " +
        "ACCEPTED IDENTIFIERS: STRING resolves each one itself, so a HUGO gene symbol ('TP53'), a UniProt accession ('P04637'), an Ensembl protein ID " +
        "('ENSP00000269305') and a full protein name all work, mixed in one call. `species` takes an NCBI Taxonomy ID (9606 = human).\n" +
        "`limit` applies to all three actions and defaults small: a network over N proteins grows with N² edges. `totalEdges` / `totalTerms` give the " +
        "pre-trim counts. An empty result is valid no-data (unconnected set, no enriched term, unresolvable identifiers) — report it and continue, do " +
        "not retry.",
    inputSchema: z.object({
        identifiers: z.array(z.string()).min(1).max(100).describe("Protein/gene identifiers (e.g. ['TP53', 'BRCA1'])"),
        species: z.number().int().default(9606).describe("NCBI Taxonomy ID (9606 = human, 10090 = mouse)"),
        action: z.enum(["partners", "network", "enrichment"]).default("partners").describe("Query type"),
        minScore: z
            .number()
            .int()
            .min(0)
            .max(1000)
            .default(400)
            .describe("Minimum confidence score, 'partners' and 'network' only (400=medium, 700=high, 900=highest). Raise it to cut a large network down."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .default(DEFAULT_LIMIT)
            .describe(
                `Max records returned — partners, network edges, or enriched terms depending on action (default ${DEFAULT_LIMIT}, max 500). ` +
                    "Rows are ordered best-first (score descending for interactions, FDR ascending for enrichment), so the default keeps the strongest.",
            ),
    }),
    describeCall: "none",
    execute: async ({ identifiers, species, action, minScore, limit }): Promise<Result<InteractionsOutput, ToolError>> => {
        if (action === "enrichment") {
            return ok(await getEnrichment(identifiers, species, { limit }));
        }
        if (action === "network") {
            return ok(await getInteractionNetwork(identifiers, { species, minScore, limit }));
        }
        return ok({ interactions: await getInteractionPartners(identifiers, { species, minScore, limit }) });
    },
});
