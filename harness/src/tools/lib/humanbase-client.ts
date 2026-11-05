/**
 * Pure async client functions for HumanBase (Flatiron Institute), which serves
 * the GIANT functional networks: one network for each tissue, cell type, or
 * biological-process context (Greene et al., Nature Genetics 2015).
 *
 * Absence policy: HumanBase keeps the key of an absent value and sends an
 * explicit `null` — `mincut` of a v3 network, and `term` and `version` of a
 * context. Thus a maybe-absent field carries `.nullable()`, not `.optional()`.
 *
 * HumanBase asks for no key and no caller identity. The shared
 * `HARNESS_USER_AGENT` of `apiFetch` names the caller.
 *
 * The GIANT version is a property of the slug: each v3 slug ends in `-v3`, and
 * no v1 slug does. The network endpoint refuses a `giant_version` that disagrees
 * with the slug (a 400 for a v3 slug under v1, a 404 for a v1 slug under v3),
 * thus the client derives the version from the slug and no caller states it.
 *
 * Only an HTTP 404 is an expected absence (an unknown slug, or no queried gene in
 * the network). A 400 carries the message of a refused request, thus it is not
 * read as "nothing there" — `isUnexpectedApiError` would read every 4xx that way.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, type ApiError } from "./api-utils.js";

const HUMANBASE_BASE = "https://hb.flatironinstitute.org/api/integrations";

/** The network endpoint refuses a larger query gene set with a 400. */
export const HUMANBASE_MAX_NETWORK_GENES = 30;

const V3_SLUG_SUFFIX = "-v3";

export type GiantVersion = "v1" | "v3";

/** The GIANT version of a context slug. */
export function giantVersionOf(slug: string): GiantVersion {
    return slug.endsWith(V3_SLUG_SUFFIX) ? "v3" : "v1";
}

export type HumanBaseContext = {
    /** The key of the network endpoint: 'blood', 'liver-v3', 'double-strand-break-repair'. */
    slug: string;
    title: string;
    giantVersion: GiantVersion;
    /**
     * The ontology term of a v1 context: a BRENDA Tissue Ontology term for a tissue,
     * or a GO biological-process term for a process. A v3 context carries none.
     */
    term: { id: string; ontology: string } | null;
};

export type HumanBaseScoredContext = HumanBaseContext & { score: number };

export type HumanBaseGene = {
    entrez: number;
    symbol: string;
    /**
     * The full name of the gene, from the wire key `description`. A result field named `description` would vanish from
     * the `run_script` catalog, which drops each key of that name as prose.
     */
    name: string;
    ensembl: string | null;
    hgnc: string | null;
    /** True for a gene of the query, false for a neighbor that HumanBase added. */
    query: boolean;
};

export type HumanBaseEdge = {
    geneA: string;
    geneB: string;
    /** The posterior probability of a functional relationship in this context. */
    weight: number;
};

export type HumanBaseNetwork = {
    context: string;
    giantVersion: GiantVersion;
    /** The `mincut` value of HumanBase for the subnetwork. Null for a v3 network. */
    mincut: number | null;
    genes: HumanBaseGene[];
    edges: HumanBaseEdge[];
    /** The edge count before `limit`. */
    totalEdges: number;
    /** The queried Entrez IDs that the answer does not hold. */
    notFound: number[];
};

const ContextSchema = z.object({
    title: z.string(),
    term: z
        .object({
            identifier: z.string(),
            database: z.object({ name: z.string() }),
        })
        .nullable(),
    version: z.object({ identifier: z.string() }).nullable(),
});

function toContext(slug: string, context: z.infer<typeof ContextSchema>): HumanBaseContext {
    return {
        slug,
        title: context.title,
        giantVersion: giantVersionOf(slug),
        term: context.term === null ? null : { id: context.term.identifier, ontology: context.term.database.name },
    };
}

/** One row of `GET /api/integrations/`. */
export const HumanBaseIntegrationSchema = z
    .object({
        slug: z.string(),
        context: ContextSchema,
    })
    .transform((d): HumanBaseContext => toContext(d.slug, d.context));

/** One row of `POST /api/integrations/relevant/`. */
export const HumanBaseRelevantSchema = z
    .object({
        slug: z.string(),
        context: ContextSchema,
        score: z.number(),
    })
    .transform((d): HumanBaseScoredContext => ({ ...toContext(d.slug, d.context), score: d.score }));

const XrefSchema = z.object({
    xrid: z.string(),
    crossrefdb: z.object({ name: z.string() }),
});

const NetworkGeneSchema = z.object({
    entrez: z.number().int(),
    standard_name: z.string(),
    description: z.string(),
    xrefs: z.array(XrefSchema),
    query: z.boolean(),
});

/** An edge names its two genes by their index in `genes`, not by an Entrez ID. */
const NetworkEdgeSchema = z.object({
    source: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    weight: z.number(),
});

function xrefOf(xrefs: z.infer<typeof XrefSchema>[], database: string): string | null {
    return xrefs.find((xref) => xref.crossrefdb.name === database)?.xrid ?? null;
}

/** The body of `GET /api/integrations/{slug}/network/`, with each edge resolved to the symbols of its genes. */
export const HumanBaseNetworkSchema = z
    .object({
        mincut: z.number().nullable(),
        genes: z.array(NetworkGeneSchema),
        edges: z.array(NetworkEdgeSchema),
    })
    .superRefine((d, ctx) => {
        for (const [index, edge] of d.edges.entries()) {
            if (edge.source >= d.genes.length || edge.target >= d.genes.length) {
                ctx.addIssue({ code: "custom", path: ["edges", index], message: "an edge names a gene index outside genes" });
            }
        }
    })
    .transform((d) => {
        const genes: HumanBaseGene[] = d.genes.map((gene) => ({
            entrez: gene.entrez,
            symbol: gene.standard_name,
            name: gene.description,
            ensembl: xrefOf(gene.xrefs, "Ensembl"),
            hgnc: xrefOf(gene.xrefs, "HGNC"),
            query: gene.query,
        }));
        const symbolAt = (index: number): string => genes[index]?.symbol ?? "";
        const edges: HumanBaseEdge[] = d.edges.map((edge) => ({ geneA: symbolAt(edge.source), geneB: symbolAt(edge.target), weight: edge.weight }));
        return { mincut: d.mincut, genes, edges };
    });

function isNotFound(error: ApiError): boolean {
    return error.type === "http_status" && error.status === 404;
}

/**
 * Each context that HumanBase serves, filtered by a case-insensitive substring of
 * the slug or the title. The list holds about 600 rows, thus `limit` trims it and
 * `totalFound` reports the count of the filtered list.
 */
export async function listContexts(options: { query?: string; limit?: number } = {}): Promise<{ contexts: HumanBaseContext[]; totalFound: number }> {
    const res = await apiFetchValidated(`${HUMANBASE_BASE}/`, z.array(HumanBaseIntegrationSchema));
    if (res.isErr()) throw new Error(describeApiError(res.error));
    const needle = options.query?.trim().toLowerCase() ?? "";
    const matched = needle === "" ? res.value : res.value.filter((c) => c.slug.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle));
    const limit = options.limit ?? matched.length;
    return { contexts: matched.slice(0, limit), totalFound: matched.length };
}

/**
 * The contexts ranked by their relevance to a gene set, best first.
 *
 * HumanBase ranks the v1 contexts only, and it gives an empty list when it knows
 * none of the genes. The endpoint takes each Entrez ID as a JSON string and
 * answers a JSON number with a 500.
 */
export async function getRelevantContexts(
    entrez: readonly number[],
    options: { limit?: number } = {},
): Promise<{ contexts: HumanBaseScoredContext[]; totalFound: number }> {
    const res = await apiFetchValidated(`${HUMANBASE_BASE}/relevant/`, z.array(HumanBaseRelevantSchema), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entrez: entrez.map(String) }),
    });
    if (res.isErr()) {
        // The published schema of the endpoint documents a 404 for an unknown gene.
        if (isNotFound(res.error)) return { contexts: [], totalFound: 0 };
        throw new Error(describeApiError(res.error));
    }
    const sorted = res.value.sort((a, b) => b.score - a.score);
    const limit = options.limit ?? sorted.length;
    return { contexts: sorted.slice(0, limit), totalFound: sorted.length };
}

/**
 * The functional subnetwork of the query genes in one context, plus `nodeSize`
 * neighbor genes that HumanBase adds. The answer holds an edge for each gene
 * pair, thus the edge count grows with the square of the gene count: `limit`
 * trims the weight-sorted edges, and `totalEdges` reports the true count.
 *
 * Gives `null` on an HTTP 404: the slug is unknown, or no query gene is in the
 * network.
 */
export async function getNetwork(
    slug: string,
    entrez: readonly number[],
    options: { nodeSize?: number; limit?: number } = {},
): Promise<HumanBaseNetwork | null> {
    const giantVersion = giantVersionOf(slug);
    const params = new URLSearchParams();
    for (const id of entrez) params.append("entrez", String(id));
    if (options.nodeSize !== undefined) params.set("node_size", String(options.nodeSize));
    params.set("giant_version", giantVersion);
    const res = await apiFetchValidated(`${HUMANBASE_BASE}/${encodeURIComponent(slug)}/network/?${params}`, HumanBaseNetworkSchema);
    if (res.isErr()) {
        if (isNotFound(res.error)) return null;
        throw new Error(describeApiError(res.error));
    }
    const returned = new Set(res.value.genes.map((gene) => gene.entrez));
    const edges = res.value.edges.sort((a, b) => b.weight - a.weight);
    const limit = options.limit ?? edges.length;
    return {
        context: slug,
        giantVersion,
        mincut: res.value.mincut,
        genes: res.value.genes,
        edges: edges.slice(0, limit),
        totalEdges: edges.length,
        notFound: entrez.filter((id) => !returned.has(id)),
    };
}
