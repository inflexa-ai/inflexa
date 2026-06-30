/**
 * Pure async client functions for STRING DB protein-protein interactions.
 *
 * Used by §3.8 (PPI Network).
 */

import { apiFetch, describeApiError } from "./api-utils.js";

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

/** Fetch interaction partners (one-hop) for the given identifiers. */
export async function getInteractionPartners(identifiers: string[], options: InteractionOptions = {}): Promise<StringInteraction[]> {
    const params = buildParams(identifiers, options.species ?? 9606, {
        required_score: options.minScore ?? 400,
        limit: options.limit ?? 20,
    });
    const res = await apiFetch<any[]>(`${STRING_BASE}/interaction_partners?${params}`);
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value
        .map((d: any) => ({
            proteinA: d.preferredName_A ?? "",
            proteinB: d.preferredName_B ?? "",
            score: d.score ?? 0,
            experimentalScore: d.escore ?? undefined,
            databaseScore: d.dscore ?? undefined,
            textminingScore: d.tscore ?? undefined,
        }))
        .sort((a, b) => b.score - a.score);
}

/** Fetch the network among the given identifiers. */
export async function getInteractionNetwork(identifiers: string[], options: InteractionOptions = {}): Promise<StringInteraction[]> {
    const params = buildParams(identifiers, options.species ?? 9606, {
        required_score: options.minScore ?? 400,
    });
    const res = await apiFetch<any[]>(`${STRING_BASE}/network?${params}`);
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value
        .map((d: any) => ({
            proteinA: d.preferredName_A ?? "",
            proteinB: d.preferredName_B ?? "",
            score: d.score ?? 0,
            experimentalScore: d.escore ?? undefined,
            databaseScore: d.dscore ?? undefined,
            textminingScore: d.tscore ?? undefined,
        }))
        .sort((a, b) => b.score - a.score);
}

/** Functional enrichment for a gene set. */
export async function getEnrichment(identifiers: string[], species = 9606): Promise<StringEnrichment[]> {
    const params = buildParams(identifiers, species);
    const res = await apiFetch<any[]>(`${STRING_BASE}/enrichment?${params}`);
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value
        .map((d: any) => ({
            category: d.category ?? "",
            term: d.term ?? "",
            description: d.description ?? "",
            pValue: d.p_value ?? 1,
            fdr: d.fdr ?? 1,
            geneCount: d.number_of_genes ?? 0,
            genes: Array.isArray(d.preferredNames) ? d.preferredNames : (d.preferredNames ?? "").split(",").filter(Boolean),
        }))
        .sort((a, b) => a.fdr - b.fdr);
}
