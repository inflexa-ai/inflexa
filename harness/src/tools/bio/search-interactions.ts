/**
 * searchInteractions — query protein-protein interactions via STRING DB.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { getEnrichment, getInteractionNetwork, getInteractionPartners } from "../lib/string-client.js";

type InteractionsOutput = { enrichment: Awaited<ReturnType<typeof getEnrichment>> } | { interactions: Awaited<ReturnType<typeof getInteractionPartners>> };

export const searchInteractionsTool = defineTool({
    id: "search_interactions",
    description:
        "Query protein-protein interactions from STRING DB. " +
        "Actions: 'partners' finds interaction partners for proteins, " +
        "'network' gets the full interaction network between listed proteins, " +
        "'enrichment' returns functional enrichment analysis (GO, KEGG, Reactome).",
    inputSchema: z.object({
        identifiers: z.array(z.string()).min(1).max(100).describe("Protein/gene identifiers (e.g. ['TP53', 'BRCA1'])"),
        species: z.number().int().default(9606).describe("NCBI Taxonomy ID (9606 = human, 10090 = mouse)"),
        action: z.enum(["partners", "network", "enrichment"]).default("partners").describe("Query type"),
        minScore: z.number().int().min(0).max(1000).default(400).describe("Minimum confidence score (400=medium, 700=high, 900=highest)"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max interaction partners (partners action only)"),
    }),
    execute: async ({ identifiers, species, action, minScore, limit }): Promise<Result<InteractionsOutput, ToolError>> => {
        if (action === "enrichment") {
            const enrichment = await getEnrichment(identifiers, species);
            return ok({ enrichment });
        }
        const interactions =
            action === "partners"
                ? await getInteractionPartners(identifiers, { species, minScore, limit })
                : await getInteractionNetwork(identifiers, { species, minScore });
        return ok({ interactions });
    },
});
