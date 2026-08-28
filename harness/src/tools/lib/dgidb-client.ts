/**
 * Pure async client functions for the Drug-Gene Interaction Database (DGIdb)
 * GraphQL API. Free, no key required.
 *
 * DGIdb aggregates 30+ sources (ChEMBL, DrugBank, TTD, PharmGKB,
 * GuideToPharmacology, CIViC, …) and reports per-interaction source counts,
 * which the caller uses as a confidence signal.
 *
 * Absence policy: the nullability of the GraphQL SDL encodes an absent value.
 * DGIdb answers each requested field with a key and an explicit `null`, thus
 * the SDL gives each modifier and `.optional()` is wrong.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";

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

export interface DgidbInteraction {
    geneName: string;
    drugName: string;
    drugConceptId?: string;
    interactionTypes: { type: string; directionality?: string }[];
    interactionScore?: number;
    sourceCount: number;
    sources: string[];
    publicationCount: number;
    pmids: string[];
    attributes?: { name: string; value: string }[];
}

export interface DgidbResult {
    input: string;
    found: boolean;
    interactions: DgidbInteraction[];
    /** Interactions this input had before `limit` trimmed them. */
    totalInteractions: number;
}

// Shape of the DGIdb GraphQL payload as it arrives on the wire. Validated at
// the fetch boundary; `mapInteraction` normalizes each record. GraphQL always
// answers a requested field with a key, thus absence is an explicit `null` and
// never an omission. As a result each modifier below comes from the SDL:
// `Gene.name`, `InteractionClaimType.type` and `directionality` are nullable,
// and `GeneConnection.nodes` is a nullable list of nullable elements.
const RawInteractionSchema = z.object({
    interactionScore: z.number().nullable().optional(),
    interactionTypes: z.array(z.object({ type: z.string().nullable().optional(), directionality: z.string().nullable().optional() })).optional(),
    drug: z.object({ name: z.string().optional(), conceptId: z.string().nullable().optional() }).nullable().optional(),
    gene: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    interactionAttributes: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
    publications: z.array(z.object({ pmid: z.union([z.string(), z.number()]).optional() })).optional(),
    sources: z.array(z.object({ sourceDbName: z.string().optional() })).optional(),
});

const RawNodeSchema = z.object({
    name: z.string().nullable(),
    conceptId: z.string().nullable().optional(),
    interactions: z.array(RawInteractionSchema).optional(),
});

/** The response envelope. It is exported so that the golden-fixture table drives it. */
export const DgidbResponseSchema = z.object({
    data: z
        .object({
            genes: z.object({ nodes: z.array(RawNodeSchema.nullable()).nullish() }).optional(),
            drugs: z.object({ nodes: z.array(RawNodeSchema.nullable()).nullish() }).optional(),
        })
        .optional(),
    errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

type RawInteraction = z.infer<typeof RawInteractionSchema>;
type RawNode = z.infer<typeof RawNodeSchema>;

/** PMIDs kept per interaction — the count travels for the rest. */
const MAX_PMIDS = 5;
/** Attributes kept per interaction, and the per-value character ceiling. */
const MAX_ATTRIBUTES = 10;
const MAX_ATTRIBUTE_CHARS = 160;

export interface DgidbFilters {
    interactionTypes?: string[];
    sourceDbs?: string[];
    minSources?: number;
    includeAttributes?: boolean;
    limit?: number;
}

function mapInteraction(
    raw: RawInteraction,
    perspective: "gene" | "drug",
    inputSide: { geneName?: string; drugName?: string; drugConceptId?: string },
    includeAttributes: boolean,
): DgidbInteraction {
    const sources = (raw.sources ?? []).map((s) => s.sourceDbName ?? "").filter(Boolean);
    const pmids = (raw.publications ?? []).map((p) => (p.pmid != null ? String(p.pmid) : "")).filter(Boolean);
    const types = (raw.interactionTypes ?? []).map((t) => ({
        type: t.type ?? "",
        ...(t.directionality ? { directionality: t.directionality } : {}),
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
        pmids: pmids.slice(0, MAX_PMIDS),
        ...(includeAttributes
            ? {
                  attributes: (raw.interactionAttributes ?? []).slice(0, MAX_ATTRIBUTES).map((a) => ({
                      name: a.name ?? "",
                      value: (a.value ?? "").slice(0, MAX_ATTRIBUTE_CHARS),
                  })),
              }
            : {}),
    };
}

function applyFilters(interactions: DgidbInteraction[], filters: DgidbFilters): DgidbInteraction[] {
    let out = interactions;
    if (filters.interactionTypes?.length) {
        const needles = filters.interactionTypes.map((s) => s.toLowerCase());
        out = out.filter((i) => i.interactionTypes.some((t) => needles.some((n) => t.type.toLowerCase().includes(n))));
    }
    if (filters.sourceDbs?.length) {
        const needles = filters.sourceDbs.map((s) => s.toLowerCase());
        out = out.filter((i) => i.sources.some((s) => needles.some((n) => s.toLowerCase().includes(n))));
    }
    const minSources = filters.minSources ?? 1;
    if (minSources > 0) {
        out = out.filter((i) => i.sourceCount >= minSources);
    }
    return out;
}

/**
 * Query DGIdb for interactions of the given genes or drugs.
 *
 * `onPartialErrors` receives GraphQL partial errors that arrive alongside
 * usable data — the client itself never logs, so the caller decides.
 */
export async function searchDgidb(
    inputs: string[],
    searchType: "gene" | "drug",
    filters: DgidbFilters = {},
    onPartialErrors?: (errors: { message?: string }[]) => void,
): Promise<DgidbResult[]> {
    const isGene = searchType === "gene";
    const res = await apiFetchValidated(DGIDB_GRAPHQL_URL, DgidbResponseSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            query: isGene ? GENE_INTERACTIONS_QUERY : DRUG_INTERACTIONS_QUERY,
            variables: { [isGene ? "genes" : "drugs"]: inputs },
        }),
    });

    if (res.isErr()) throw new Error(describeApiError(res.error));

    const body = res.value;
    if (!body || !body.data) throw new Error("DGIdb returned no data");
    if (body.errors?.length) onPartialErrors?.(body.errors.slice(0, 3));

    const nodes = (isGene ? body.data.genes?.nodes : body.data.drugs?.nodes) ?? [];
    const nodeMap = new Map<string, RawNode & { name: string }>();
    for (const node of nodes) {
        // The node list and `Gene.name` are nullable in the SDL. The map keys on
        // the name, thus a null element and a null-named node have no key, and
        // the input that asked for them reports `found: false`.
        const name = node?.name;
        if (!node || !name) continue;
        const named = { ...node, name };
        nodeMap.set(name.toLowerCase(), named);
        if (!isGene && node.conceptId) nodeMap.set(node.conceptId.toLowerCase(), named);
    }

    const limit = filters.limit ?? 20;
    return inputs.map((input) => {
        const node = nodeMap.get(input.toLowerCase());
        if (!node) return { input, found: false, interactions: [], totalInteractions: 0 };

        const inputSide = isGene ? { geneName: node.name } : { drugName: node.name, drugConceptId: node.conceptId ?? undefined };
        const mapped = (node.interactions ?? []).map((raw) => mapInteraction(raw, searchType, inputSide, filters.includeAttributes ?? false));
        const filtered = applyFilters(mapped, filters);
        const sorted = filtered.sort((a, b) => {
            if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
            return (b.interactionScore ?? 0) - (a.interactionScore ?? 0);
        });

        return { input, found: true, interactions: sorted.slice(0, limit), totalInteractions: sorted.length };
    });
}
