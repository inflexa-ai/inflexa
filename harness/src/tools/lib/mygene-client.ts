/**
 * Pure async client functions for MyGene.info (BioThings, Scripps), which maps a
 * gene across the identifier spaces of its sources: the HGNC symbol, the NCBI
 * Entrez Gene ID, the Ensembl gene ID, and the UniProt accession (Xin et al.,
 * Genome Biology 2016).
 *
 * Absence policy: MyGene omits the key of an absent value and never sends an
 * explicit `null`. Every field of a hit can be absent — an Ensembl-only gene has
 * no `symbol`, `name`, or `entrezgene`, and a noncoding gene has no `uniprot` —
 * thus each field carries `.optional()`.
 *
 * Two fields change their shape with their count: `ensembl` is one object or an
 * array of objects (a gene on alternate haplotypes, or a mouse gene with strain
 * copies), and `uniprot.Swiss-Prot` is one string or an array. The client
 * normalizes both to an array, in the wire order, which carries no rank.
 *
 * A miss is no error: the batch answers HTTP 200, and it marks the miss with
 * `notfound: true`.
 *
 * MyGene cuts the hits of each identifier at `size`, 10 by default, and the plain
 * batch answer gives no sign of the cut. Thus the client sends `size` and
 * `with_total`, and the answer is then an object: `max_total`, the largest hit
 * count of one identifier before the cut, and `hits`, the rows. An unknown species answers HTTP 400 with a message, which the
 * caller sees as an error.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, zWireNumber } from "./api-utils.js";

const MYGENE_QUERY_URL = "https://mygene.info/v3/query";

/**
 * The identifier spaces that a query matches. `alias` is not one of them: an old
 * or informal symbol matches several current genes with an equal score, and no
 * rule picks one.
 */
const SCOPES = "symbol,entrezgene,ensembl.gene,uniprot";

const FIELDS = "symbol,name,entrezgene,ensembl.gene,uniprot.Swiss-Prot";

/** The most hits that one identifier gives. A UniProt accession that a gene family shares gives a hit for each member. */
export const MYGENE_HITS_PER_ID = 100;

export type MyGeneHit = {
    /** The identifier of the request that this hit answers. */
    query: string;
    symbol: string | null;
    /** The full name of the gene. */
    name: string | null;
    entrez: number | null;
    ensembl: string[];
    /** The reviewed (Swiss-Prot) UniProt accessions. */
    uniprot: string[];
};

export type MyGeneRow = { kind: "hit"; hit: MyGeneHit } | { kind: "miss"; query: string };

export type GeneIdResolution = {
    genes: MyGeneHit[];
    /** Each identifier that matched no gene. */
    notFound: string[];
    /** Each identifier that matched more than one gene. Each of its genes is in `genes`. */
    ambiguous: string[];
    /** Each identifier whose hits were cut at `MYGENE_HITS_PER_ID`. `genes` holds the first of them only. */
    truncated: string[];
};

function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

const EnsemblRefSchema = z.object({ gene: z.string() });

const MissRowSchema = z.object({ query: z.string(), notfound: z.literal(true) });

const HitRowSchema = z.object({
    query: z.string(),
    _id: z.string(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    entrezgene: zWireNumber.optional(),
    ensembl: z.union([EnsemblRefSchema, z.array(EnsemblRefSchema)]).optional(),
    uniprot: z.object({ "Swiss-Prot": z.union([z.string(), z.array(z.string())]).optional() }).optional(),
});

/** One row of the batch answer of `POST /v3/query`: a hit, or the miss of one query. */
export const MyGeneBatchRowSchema = z.union([MissRowSchema, HitRowSchema]).transform((row): MyGeneRow => {
    if ("notfound" in row) return { kind: "miss", query: row.query };
    return {
        kind: "hit",
        hit: {
            query: row.query,
            symbol: row.symbol ?? null,
            name: row.name ?? null,
            entrez: row.entrezgene ?? null,
            ensembl: asArray(row.ensembl).map((ref) => ref.gene),
            uniprot: asArray(row.uniprot?.["Swiss-Prot"]),
        },
    };
});

/** The batch answer of `POST /v3/query` with `with_total`. */
export const MyGeneBatchAnswerSchema = z.object({
    max_total: z.number(),
    hits: z.array(MyGeneBatchRowSchema),
});

/**
 * Resolve a batch of gene identifiers, mixed freely, in one request. A duplicate
 * identifier is sent one time, and the order of the input is kept.
 *
 * `species` is a common name that MyGene knows ('human', 'mouse', 'rat',
 * 'zebrafish', …) or an NCBI Taxonomy ID as a string ('9606').
 */
export async function resolveGeneIds(identifiers: readonly string[], species: string): Promise<GeneIdResolution> {
    const queries = [...new Set(identifiers.map((id) => id.trim()).filter((id) => id !== ""))];
    if (queries.length === 0) return { genes: [], notFound: [], ambiguous: [], truncated: [] };
    const res = await apiFetchValidated(MYGENE_QUERY_URL, MyGeneBatchAnswerSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: queries, scopes: SCOPES, fields: FIELDS, species, size: MYGENE_HITS_PER_ID, with_total: true }),
    });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    const genes: MyGeneHit[] = [];
    const notFound: string[] = [];
    const hitCount = new Map<string, number>();
    for (const row of res.value.hits) {
        if (row.kind === "miss") {
            notFound.push(row.query);
            continue;
        }
        genes.push(row.hit);
        hitCount.set(row.hit.query, (hitCount.get(row.hit.query) ?? 0) + 1);
    }
    const ambiguous = [...hitCount].filter(([, count]) => count > 1).map(([query]) => query);
    // `max_total` is one number for the whole batch. Past the cap, each identifier that filled the cap can be the one
    // that was cut, thus each such identifier counts as cut.
    const truncated = res.value.max_total > MYGENE_HITS_PER_ID ? [...hitCount].filter(([, count]) => count >= MYGENE_HITS_PER_ID).map(([query]) => query) : [];
    return { genes, notFound, ambiguous, truncated };
}
