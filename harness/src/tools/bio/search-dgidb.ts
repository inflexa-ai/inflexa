/**
 * searchDgidb tool — query drug-gene interactions via DGIdb GraphQL.
 *
 * DGIdb aggregates interactions from 30+ sources (ChEMBL, DrugBank, TTD,
 * PharmGKB, GuideToPharmacology, CIViC, etc.). Free, no API key required.
 *
 * Two directions:
 *   - searchType="gene": input HUGO symbols, returns drugs interacting with each.
 *   - searchType="drug": input drug names/concept IDs, returns genes each acts on.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";

const DGIDB_GRAPHQL_URL = "https://dgidb.org/api/graphql";

const GENE_INTERACTIONS_QUERY = `query($genes: [String!]!) {
  genes(names: $genes) {
    nodes {
      name
      interactions {
        interactionScore
        interactionTypes { type directionality }
        drug { name conceptId }
        interactionAttributes { name value }
        publications { pmid }
        sources { sourceDbName }
      }
    }
  }
}`;

const DRUG_INTERACTIONS_QUERY = `query($drugs: [String!]!) {
  drugs(names: $drugs) {
    nodes {
      name
      conceptId
      interactions {
        interactionScore
        interactionTypes { type directionality }
        gene { name }
        interactionAttributes { name value }
        publications { pmid }
        sources { sourceDbName }
      }
    }
  }
}`;

const InteractionSchema = z.object({
    geneName: z.string(),
    drugName: z.string(),
    drugConceptId: z.string().optional(),
    interactionTypes: z.array(
        z.object({
            type: z.string(),
            directionality: z.string().optional(),
        }),
    ),
    interactionScore: z.number().optional(),
    sourceCount: z.number().int(),
    sources: z.array(z.string()),
    publicationCount: z.number().int(),
    pmids: z.array(z.string()).max(10),
    attributes: z
        .array(
            z.object({
                name: z.string(),
                value: z.string(),
            }),
        )
        .max(20),
});

type Interaction = z.infer<typeof InteractionSchema>;

interface RawInteraction {
    interactionScore?: number | null;
    interactionTypes?: { type?: string; directionality?: string | null }[];
    drug?: { name?: string; conceptId?: string | null } | null;
    gene?: { name?: string } | null;
    interactionAttributes?: { name?: string; value?: string }[];
    publications?: { pmid?: string | number }[];
    sources?: { sourceDbName?: string }[];
}

interface RawNode {
    name: string;
    conceptId?: string | null;
    interactions?: RawInteraction[];
}

interface DgidbResponse {
    data?: {
        genes?: { nodes?: RawNode[] };
        drugs?: { nodes?: RawNode[] };
    };
    errors?: { message?: string }[];
}

function mapInteraction(
    raw: RawInteraction,
    perspective: "gene" | "drug",
    inputSide: { geneName?: string; drugName?: string; drugConceptId?: string },
): Interaction {
    const sources = (raw.sources ?? []).map((s) => s.sourceDbName ?? "").filter(Boolean);
    const pmids = (raw.publications ?? []).map((p) => (p.pmid != null ? String(p.pmid) : "")).filter(Boolean);
    const types = (raw.interactionTypes ?? []).map((t) => ({
        type: t.type ?? "",
        ...(t.directionality ? { directionality: t.directionality } : {}),
    }));
    const attributes = (raw.interactionAttributes ?? []).slice(0, 20).map((a) => ({
        name: a.name ?? "",
        value: (a.value ?? "").slice(0, 200),
    }));

    const geneName = perspective === "gene" ? (inputSide.geneName ?? "") : (raw.gene?.name ?? "");
    const drugName = perspective === "drug" ? (inputSide.drugName ?? "") : (raw.drug?.name ?? "");
    const drugConceptId = perspective === "drug" ? inputSide.drugConceptId : (raw.drug?.conceptId ?? undefined);

    return {
        geneName,
        drugName,
        ...(drugConceptId ? { drugConceptId } : {}),
        interactionTypes: types,
        ...(raw.interactionScore != null ? { interactionScore: raw.interactionScore } : {}),
        sourceCount: sources.length,
        sources,
        publicationCount: pmids.length,
        pmids: pmids.slice(0, 10),
        attributes,
    };
}

function applyFilters(
    interactions: Interaction[],
    filters: {
        interactionTypes?: string[];
        sources?: string[];
        minSources: number;
    },
): Interaction[] {
    let out = interactions;
    if (filters.interactionTypes?.length) {
        const needles = filters.interactionTypes.map((s) => s.toLowerCase());
        out = out.filter((i) => i.interactionTypes.some((t) => needles.some((n) => t.type.toLowerCase().includes(n))));
    }
    if (filters.sources?.length) {
        const needles = filters.sources.map((s) => s.toLowerCase());
        out = out.filter((i) => i.sources.some((s) => needles.some((n) => s.toLowerCase().includes(n))));
    }
    if (filters.minSources > 0) {
        out = out.filter((i) => i.sourceCount >= filters.minSources);
    }
    return out;
}

export const searchDgidbTool = defineTool({
    id: "search_dgidb",
    description:
        "Query the Drug-Gene Interaction Database (DGIdb) for drug-gene interactions. " +
        "DGIdb aggregates 30+ sources (ChEMBL, DrugBank, TTD, PharmGKB, GuideToPharmacology, CIViC, etc.) " +
        "and returns source counts as a confidence signal. " +
        "searchType='gene' returns drugs interacting with input HUGO gene symbols (most common: 'what drugs hit my gene set?'). " +
        "searchType='drug' returns the genes each input drug is known to act on. " +
        "Free, no API key required. Sorted by source count desc.",
    inputSchema: z.object({
        query: z
            .union([z.string(), z.array(z.string()).max(50)])
            .describe("Single identifier or list of up to 50. For searchType='gene': HUGO symbols. For searchType='drug': drug names or DGIdb concept IDs."),
        searchType: z.enum(["gene", "drug"]).default("gene"),
        interactionTypes: z.array(z.string()).optional().describe("Case-insensitive substring filter on interaction type. e.g. ['inhibitor', 'antagonist']"),
        sources: z.array(z.string()).optional().describe("Restrict to interactions from these source DBs (case-insensitive substring)."),
        minSources: z.number().int().min(1).default(1).describe("Drop interactions supported by fewer than this many sources."),
        limit: z.number().int().min(1).max(200).default(50).describe("Max interactions per input gene/drug after filtering."),
    }),
    execute: async ({ query, searchType = "gene", interactionTypes, sources, minSources = 1, limit = 50 }) => {
        const inputs = typeof query === "string" ? [query] : query;
        if (inputs.length === 0 || inputs.every((s) => !s.trim())) {
            throw new Error("query must contain at least one identifier");
        }

        const isGene = searchType === "gene";
        const variableName = isGene ? "genes" : "drugs";
        const queryString = isGene ? GENE_INTERACTIONS_QUERY : DRUG_INTERACTIONS_QUERY;

        const res = await apiFetch<DgidbResponse>(DGIDB_GRAPHQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: queryString,
                variables: { [variableName]: inputs },
            }),
        });

        if (res.isErr()) throw new Error(describeApiError(res.error));

        const body = res.value;
        if (!body || !body.data) throw new Error("DGIdb returned no data");

        if (body.errors?.length) {
            console.warn("dgidb.partial_errors", { errors: body.errors.slice(0, 3) });
        }

        const nodes = (isGene ? body.data.genes?.nodes : body.data.drugs?.nodes) ?? [];

        const nodeMap = new Map<string, RawNode>();
        for (const node of nodes) {
            nodeMap.set(node.name.toLowerCase(), node);
            if (!isGene && node.conceptId) {
                nodeMap.set(node.conceptId.toLowerCase(), node);
            }
        }

        const results = inputs.map((input) => {
            const node = nodeMap.get(input.toLowerCase());
            if (!node) {
                return { input, found: false, interactions: [] };
            }
            const inputSide = isGene
                ? { geneName: node.name }
                : {
                      drugName: node.name,
                      drugConceptId: node.conceptId ?? undefined,
                  };

            const mapped = (node.interactions ?? []).map((raw) => mapInteraction(raw, searchType, inputSide));

            const filtered = applyFilters(mapped, {
                interactionTypes,
                sources,
                minSources,
            });

            const sorted = filtered.sort((a, b) => {
                if (b.sourceCount !== a.sourceCount) {
                    return b.sourceCount - a.sourceCount;
                }
                return (b.interactionScore ?? 0) - (a.interactionScore ?? 0);
            });

            return {
                input,
                found: true,
                interactions: sorted.slice(0, limit),
            };
        });

        return ok({ results });
    },
});
