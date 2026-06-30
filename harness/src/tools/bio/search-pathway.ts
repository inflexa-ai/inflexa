/**
 * searchPathway — search biological pathways via KEGG and Reactome.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { searchPathways } from "../lib/pathway-client.js";

export const searchPathwayTool = defineTool({
    id: "search_pathway",
    description:
        "Search biological pathways in KEGG and/or Reactome databases. " +
        "Returns pathway IDs, names, URLs, and optionally gene lists. " +
        "Use source='both' to query both databases in parallel.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Pathway search term (e.g. 'apoptosis', 'MAPK signaling')"),
        source: z.enum(["kegg", "reactome", "both"]).default("both").describe("Which database to search"),
        organism: z
            .string()
            .default("hsa")
            .describe("KEGG organism code (e.g. 'hsa' for human, 'mmu' for mouse). " + "Automatically mapped to species name for Reactome."),
        includeGenes: z.boolean().default(false).describe("Whether to fetch gene lists for each pathway (slower)"),
        maxResults: z.number().int().min(1).max(50).default(10),
    }),
    execute: async ({ query, source, organism, includeGenes, maxResults }) => {
        const pathways = await searchPathways(query, {
            source,
            organism,
            includeGenes,
            maxResults,
        });
        return ok({ pathways });
    },
});
