/**
 * Pure async client functions for STRING DB protein-protein interactions.
 *
 * Used by §3.8 (PPI Network).
 *
 * Absence policy: STRING omits the key of an absent value, and it never sends
 * an explicit `null`. Thus a maybe-absent field carries `.optional()`, not
 * `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";

const STRING_BASE = "https://string-db.org/api/json";
const CALLER_IDENTITY = "inflexa_cortex";

export interface StringInteraction {
    proteinA: string;
    proteinB: string;
    score: number;
    experimentalScore?: number;
    databaseScore?: number;
    textminingScore?: number;
}

export interface StringEnrichment {
    category: string;
    term: string;
    description: string;
    pValue: number;
    fdr: number;
    geneCount: number;
    genes: string[];
}

function buildParams(identifiers: string[], species: number, extra: Record<string, string | number> = {}): URLSearchParams {
    const params = new URLSearchParams({
        identifiers: identifiers.join("%0d"),
        species: String(species),
        caller_identity: CALLER_IDENTITY,
    });
    for (const [k, v] of Object.entries(extra)) {
        params.set(k, String(v));
    }
    return params;
}

export interface InteractionOptions {
    species?: number;
    minScore?: number;
    limit?: number;
}

// One STRING interaction row (interaction/network endpoints). The `.object(...)` half is
// the raw wire shape (every field optional — the API omits absent values); the
// `.transform(...)` half normalizes it into the `StringInteraction` we return. Parsing IS
// the validation: `apiFetchValidated` runs this over the JSON, so a field whose type drifts
// is rejected as `invalid_response` rather than silently mis-mapped.
export const StringInteractionSchema = z
    .object({
        preferredName_A: z.string().optional(),
        preferredName_B: z.string().optional(),
        score: z.number().optional(),
        escore: z.number().optional(),
        dscore: z.number().optional(),
        tscore: z.number().optional(),
    })
    .transform((d) => ({
        proteinA: d.preferredName_A ?? "",
        proteinB: d.preferredName_B ?? "",
        score: d.score ?? 0,
        experimentalScore: d.escore ?? undefined,
        databaseScore: d.dscore ?? undefined,
        textminingScore: d.tscore ?? undefined,
    }));

// One STRING enrichment row. The `/api/json` renderer sends `preferredNames` as a
// JSON array of gene names on every row, thus the schema declares an array. A
// comma-joined string is a form of the tsv renderer, which this client never
// calls.
export const StringEnrichmentSchema = z
    .object({
        category: z.string().optional(),
        term: z.string().optional(),
        description: z.string().optional(),
        p_value: z.number().optional(),
        fdr: z.number().optional(),
        number_of_genes: z.number().optional(),
        preferredNames: z.array(z.string()).optional(),
    })
    .transform((d) => ({
        category: d.category ?? "",
        term: d.term ?? "",
        description: d.description ?? "",
        pValue: d.p_value ?? 1,
        fdr: d.fdr ?? 1,
        geneCount: d.number_of_genes ?? 0,
        genes: d.preferredNames ?? [],
    }));

/** Fetch interaction partners (one-hop) for the given identifiers. */
export async function getInteractionPartners(identifiers: string[], options: InteractionOptions = {}): Promise<StringInteraction[]> {
    const params = buildParams(identifiers, options.species ?? 9606, {
        required_score: options.minScore ?? 400,
        limit: options.limit ?? 20,
    });
    const res = await apiFetchValidated(`${STRING_BASE}/interaction_partners?${params}`, z.array(StringInteractionSchema));
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value.sort((a, b) => b.score - a.score);
}

/**
 * Fetch the network among the given identifiers.
 *
 * STRING has no server-side row cap on `/network` — edge count grows with the
 * square of the input set, so `limit` truncates the score-sorted rows here.
 * `totalEdges` reports the true count so a caller can tell a trimmed network
 * from a sparse one.
 */
export async function getInteractionNetwork(
    identifiers: string[],
    options: InteractionOptions = {},
): Promise<{ interactions: StringInteraction[]; totalEdges: number }> {
    const params = buildParams(identifiers, options.species ?? 9606, {
        required_score: options.minScore ?? 400,
    });
    const res = await apiFetchValidated(`${STRING_BASE}/network?${params}`, z.array(StringInteractionSchema));
    if (res.isErr()) throw new Error(describeApiError(res.error));
    const sorted = res.value.sort((a, b) => b.score - a.score);
    const limit = options.limit ?? sorted.length;
    return { interactions: sorted.slice(0, limit), totalEdges: sorted.length };
}

/**
 * Functional enrichment for a gene set.
 *
 * STRING returns every enriched term across all categories (GO, KEGG,
 * Reactome, Pfam, …) with the full member-gene list per term, so `limit`
 * truncates the FDR-sorted rows and `totalTerms` reports what was there.
 */
export async function getEnrichment(
    identifiers: string[],
    species = 9606,
    options: { limit?: number } = {},
): Promise<{ enrichment: StringEnrichment[]; totalTerms: number }> {
    const params = buildParams(identifiers, species);
    const res = await apiFetchValidated(`${STRING_BASE}/enrichment?${params}`, z.array(StringEnrichmentSchema));
    if (res.isErr()) throw new Error(describeApiError(res.error));
    const sorted = res.value.sort((a, b) => a.fdr - b.fdr);
    const limit = options.limit ?? sorted.length;
    return { enrichment: sorted.slice(0, limit), totalTerms: sorted.length };
}
