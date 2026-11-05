/**
 * humanbase — the GIANT tissue-specific functional networks of HumanBase.
 *
 * One database, three questions, thus one tool with an `action` (the barrel
 * rule in `index.ts`). The input is a flat object with an `action` enum, not a
 * `z.discriminatedUnion`, because model tool calling needs a top-level
 * `"type":"object"`. The argument of each action is optional in the schema, and
 * a `.refine` makes it required for its action.
 *
 * The GIANT version is not an input: the client derives it from the slug.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    getNetwork,
    getRelevantContexts,
    HUMANBASE_MAX_NETWORK_GENES,
    listContexts,
    type HumanBaseContext,
    type HumanBaseNetwork,
    type HumanBaseScoredContext,
} from "../lib/humanbase-client.js";

const DEFAULTS = { nodeSize: 10, networkEdges: 50, relevantContexts: 10, contexts: 20 } as const;
const MAX_NODE_SIZE = 50;
const MAX_RELEVANT_GENES = 200;
const MAX_LIMIT = 1000;

/** How many Entrez IDs a call detail names before it switches to a count plus a sample. */
const IDS_LISTED_IN_FULL = 8;

export type HumanBaseOutput =
    | ({ found: true } & HumanBaseNetwork)
    | { found: false; context: string }
    | { contexts: HumanBaseScoredContext[]; totalFound: number }
    | { contexts: HumanBaseContext[]; totalFound: number };

function listIds(ids: readonly number[] | undefined): string {
    if (ids === undefined) return "";
    if (ids.length <= IDS_LISTED_IN_FULL) return ids.join(", ");
    return `${ids.length} genes: ${ids.slice(0, IDS_LISTED_IN_FULL).join(", ")}, …`;
}

const inputSchema = z
    .object({
        action: z
            .enum(["network", "relevant", "contexts"])
            .describe(
                "'network' (needs entrez, max 30, and context) — the functional subnetwork of the genes in ONE context, plus nodeSize neighbor genes. " +
                    "'relevant' (needs entrez) — the contexts ranked by how relevant each is to the gene set, best first. " +
                    "'contexts' — the context slugs that HumanBase serves, filtered by query.",
            ),
        entrez: z
            .array(z.number().int().positive())
            .min(1)
            .max(MAX_RELEVANT_GENES)
            .optional()
            .describe(
                `Required for 'network' (max ${HUMANBASE_MAX_NETWORK_GENES}) and 'relevant' (max ${MAX_RELEVANT_GENES}). NCBI Entrez Gene IDs as ` +
                    "numbers (672 = BRCA1, 3553 = IL1B) — not symbols, not Ensembl IDs.",
            ),
        context: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Required for 'network'. A context slug, copied from a 'contexts' or a 'relevant' result ('blood', 'liver-v3')."),
        nodeSize: z
            .number()
            .int()
            .min(0)
            .max(MAX_NODE_SIZE)
            .optional()
            .describe(`'network' only: the neighbor genes that HumanBase adds to the query genes (default ${DEFAULTS.nodeSize}, max ${MAX_NODE_SIZE}).`),
        query: z
            .string()
            .optional()
            .describe("'contexts' only: a case-insensitive substring of the slug or the title ('liver', 'neuron', '-v3'). Omit it to list every context."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_LIMIT)
            .optional()
            .describe(
                `Max rows returned — the edges of 'network' (default ${DEFAULTS.networkEdges}, highest weight first), the contexts of 'relevant' ` +
                    `(default ${DEFAULTS.relevantContexts}, best first), or the contexts of 'contexts' (default ${DEFAULTS.contexts}).`,
            ),
    })
    .refine((d) => d.action === "contexts" || d.entrez !== undefined, {
        message: "entrez is required when action is 'network' or 'relevant' — pass NCBI Entrez Gene IDs as numbers",
        path: ["entrez"],
    })
    .refine((d) => d.action !== "network" || d.context !== undefined, {
        message: "context is required when action is 'network' — copy a slug from a 'contexts' or a 'relevant' result",
        path: ["context"],
    })
    .refine((d) => d.action !== "network" || (d.entrez?.length ?? 0) <= HUMANBASE_MAX_NETWORK_GENES, {
        message: `action 'network' takes at most ${HUMANBASE_MAX_NETWORK_GENES} entrez IDs — rank a larger set with 'relevant'`,
        path: ["entrez"],
    })
    .refine((d) => d.action !== "contexts" || d.entrez === undefined, {
        message: "entrez does not apply to action 'contexts'",
        path: ["entrez"],
    })
    .refine((d) => d.action === "network" || (d.context === undefined && d.nodeSize === undefined), {
        message: "context and nodeSize apply to action 'network' only",
        path: ["action"],
    })
    .refine((d) => d.action === "contexts" || d.query === undefined, {
        message: "query applies to action 'contexts' only",
        path: ["action"],
    });

export const humanbaseTool = defineTool({
    id: "humanbase",
    description:
        "HumanBase — the GIANT functional networks of the Flatiron Institute (Greene et al., Nature Genetics 2015): for each tissue, cell type, or " +
        "biological process, a genome-wide network whose edge weight is the posterior probability that two genes work together IN THAT CONTEXT, " +
        "integrated from the expression, interaction and other data of about 14,000 publications. It answers 'which genes act with my genes in the liver?' and " +
        "'which tissues does my gene set point to?' — questions that the context-free STRING network of search_interactions cannot.\n" +
        "'network' — the subnetwork of the query genes in one context, plus nodeSize neighbor genes. Each gene carries its Entrez ID, symbol, " +
        "Ensembl ID, HGNC ID, and `query` (false for an added neighbor). Each edge is { geneA, geneB, weight }, highest weight first; " +
        "`totalEdges` gives the count before limit (one edge per gene pair, thus it grows with the square of the gene count). `notFound` lists " +
        "the query IDs that the network does not hold. found: false means HumanBase holds no network for the request: an unknown context slug, " +
        "or no query gene in the network.\n" +
        "'relevant' — the contexts ranked by relevance to the gene set, each with a score from 0 to 1. It ranks the v1 contexts only.\n" +
        "'contexts' — the slugs. Each context has a GIANT version: a slug that ends in '-v3' is a v3 (GIANT 3) network of a tissue or a cell type; " +
        "every other slug is v1, which holds the tissue contexts (with a BRENDA Tissue Ontology term) and the biological-process contexts " +
        "(with a GO term). 'global' and 'global-v3' are the networks with no context. The tool sets the version from the slug.\n" +
        "IDENTIFIERS: NCBI Entrez Gene IDs only, as numbers (672 = BRCA1). search_gene answers with Ensembl IDs, which this tool does not take. " +
        "HUMAN genes only.\n" +
        "An empty result (no ranked context, no matched context, found: false) is valid no-data — report it and continue, do not retry.",
    inputSchema,
    view: "none",
    // One tool, three jobs: each action names its own subject — the context and
    // the genes, the genes, or the filter of the list.
    describeCall: (input) => {
        switch (input.action) {
            case "network":
                return `network ${input.context ?? ""}: ${listIds(input.entrez)}`;
            case "relevant":
                return `relevant: ${listIds(input.entrez)}`;
            case "contexts":
                return input.query === undefined ? "contexts" : `contexts ${input.query}`;
        }
    },
    execute: async (input): Promise<Result<HumanBaseOutput, ToolError>> => {
        switch (input.action) {
            case "network": {
                if (input.entrez === undefined || input.context === undefined) throw new Error("network requires entrez and context");
                const network = await getNetwork(input.context, input.entrez, {
                    nodeSize: input.nodeSize ?? DEFAULTS.nodeSize,
                    limit: input.limit ?? DEFAULTS.networkEdges,
                });
                if (network === null) return ok({ found: false as const, context: input.context });
                return ok({ found: true as const, ...network });
            }
            case "relevant": {
                if (input.entrez === undefined) throw new Error("relevant requires entrez");
                return ok(await getRelevantContexts(input.entrez, { limit: input.limit ?? DEFAULTS.relevantContexts }));
            }
            case "contexts":
                return ok(await listContexts({ query: input.query, limit: input.limit ?? DEFAULTS.contexts }));
        }
    },
});
