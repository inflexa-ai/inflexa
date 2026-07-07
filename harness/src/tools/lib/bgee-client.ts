/**
 * Pure async client functions for the Bgee multi-species expression API.
 *
 * Resolves a human gene symbol to its Ensembl ID, fans out to ortholog
 * lookups for the configured non-human species (Ensembl REST), then
 * queries Bgee per (species, ortholog ENSG) for tissue-level expression
 * calls. Returns a per-species table of tissue × expression-rank.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, isUnexpectedApiError } from "./api-utils.js";

const ENSEMBL_BASE = "https://rest.ensembl.org";
const BGEE_BASE = "https://www.bgee.org/api";

export const SUPPORTED_SPECIES = ["homo_sapiens", "mus_musculus", "rattus_norvegicus", "canis_lupus_familiaris", "macaca_mulatta"] as const;
export type SupportedSpecies = (typeof SUPPORTED_SPECIES)[number];

export const SPECIES_TAXON: Record<SupportedSpecies, number> = {
    homo_sapiens: 9606,
    mus_musculus: 10090,
    rattus_norvegicus: 10116,
    canis_lupus_familiaris: 9615,
    macaca_mulatta: 9544,
};

const ENSEMBL_HEADERS = {
    Accept: "application/json",
    "Content-Type": "application/json",
};

export type ExpressionRank = "absent" | "low" | "medium" | "high";

export interface TissueRow {
    tissue: string;
    cellType: string | null;
    expressionScore: number | null;
    confidence: "gold" | "silver" | null;
    expressionState: "expressed" | "not expressed";
    rank: ExpressionRank;
}

export interface SpeciesEntry {
    species: SupportedSpecies;
    taxonId: number;
    ensemblId: string;
    tissues: TissueRow[];
}

export interface MultiSpeciesExpression {
    geneSymbol: string;
    humanEnsemblId: string | null;
    bySpecies: SpeciesEntry[];
    notFound: string[];
}

export function bucketRank(expressionState: string, score: number | null): ExpressionRank {
    if (expressionState === "not expressed") return "absent";
    if (score === null) return "low";
    if (score >= 75) return "high";
    if (score >= 25) return "medium";
    return "low";
}

// A single expression call from the Bgee API `data.calls` array, plus the envelope that
// wraps them. Validated at the fetch boundary; `parseExpressionResponse` reads the fields
// defensively. Every field optional — the API omits absent values.
const BgeeCallSchema = z.object({
    condition: z
        .object({
            anatEntity: z.object({ name: z.string().optional() }).optional(),
            cellType: z.object({ name: z.string().optional() }).optional(),
        })
        .optional(),
    expressionScore: z.object({ expressionScore: z.union([z.string(), z.number()]).optional() }).optional(),
    expressionQuality: z.string().optional(),
    expressionState: z.string().optional(),
});
type BgeeCall = z.infer<typeof BgeeCallSchema>;

const BgeeExpressionResponseSchema = z.object({
    data: z.object({ calls: z.array(BgeeCallSchema).optional() }).optional(),
});

// Ensembl REST response shapes consumed by the ortholog-resolution path.
const EnsemblLookupSchema = z.object({ id: z.string().optional() });
const EnsemblHomologyResponseSchema = z.object({
    data: z.array(z.object({ homologies: z.array(z.object({ id: z.string().optional(), type: z.string().optional() })).optional() })).optional(),
});

export function parseExpressionResponse(raw: unknown): TissueRow[] {
    // `raw` is the untyped Bgee API payload; `.data.calls` is reached defensively and
    // the `Array.isArray` guard below means a shape mismatch degrades to an empty list.
    const calls = (raw as { data?: { calls?: BgeeCall[] } } | null)?.data?.calls;
    if (!Array.isArray(calls)) return [];

    const out: TissueRow[] = [];
    for (const call of calls) {
        const anatName: string = call?.condition?.anatEntity?.name ?? "";
        const tissue = anatName.trim().toLowerCase();
        if (!tissue) continue;

        const cellTypeName: string | undefined = call?.condition?.cellType?.name;
        const cellType = typeof cellTypeName === "string" && cellTypeName.trim() !== "" ? cellTypeName.trim().toLowerCase() : null;

        const rawScore = call?.expressionScore?.expressionScore;
        let expressionScore: number | null = null;
        if (typeof rawScore === "string" || typeof rawScore === "number") {
            const n = typeof rawScore === "number" ? rawScore : parseFloat(rawScore);
            expressionScore = Number.isFinite(n) ? n : null;
        }

        const quality = call?.expressionQuality;
        const confidence: "gold" | "silver" | null = quality === "gold" || quality === "silver" ? quality : null;

        const stateRaw = call?.expressionState;
        const expressionState: "expressed" | "not expressed" = stateRaw === "not expressed" ? "not expressed" : "expressed";

        out.push({
            tissue,
            cellType,
            expressionScore,
            confidence,
            expressionState,
            rank: bucketRank(expressionState, expressionScore),
        });
    }
    return out;
}

async function resolveHumanEnsembl(symbol: string): Promise<string | null> {
    const url = `${ENSEMBL_BASE}/lookup/symbol/homo_sapiens/${encodeURIComponent(symbol)}`;
    const res = await apiFetchValidated(url, EnsemblLookupSchema, { headers: ENSEMBL_HEADERS });
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return null;
    }
    if (typeof res.value.id !== "string" || !res.value.id.startsWith("ENSG")) return null;
    return res.value.id;
}

async function resolveOrtholog(symbol: string, targetSpecies: SupportedSpecies): Promise<string | null> {
    const url =
        `${ENSEMBL_BASE}/homology/symbol/homo_sapiens/${encodeURIComponent(symbol)}` + `?type=orthologues;target_species=${targetSpecies};format=condensed`;
    const res = await apiFetchValidated(url, EnsemblHomologyResponseSchema, { headers: ENSEMBL_HEADERS });
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return null;
    }
    const homologies = res.value.data?.[0]?.homologies ?? [];
    const onetoone = homologies.find((h) => h.type === "ortholog_one2one");
    return (onetoone?.id ?? homologies[0]?.id ?? null) || null;
}

async function fetchBgeeForSpecies(ensemblId: string, taxonId: number): Promise<TissueRow[]> {
    const url = `${BGEE_BASE}/?page=gene&action=expression&display_type=json` + `&gene_id=${encodeURIComponent(ensemblId)}&species_id=${taxonId}`;
    const res = await apiFetchValidated(url, BgeeExpressionResponseSchema);
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return [];
    }
    return parseExpressionResponse(res.value);
}

/** Fetch multi-species expression for a human gene symbol. */
export async function getMultiSpeciesExpression(geneSymbol: string, species: SupportedSpecies[] = [...SUPPORTED_SPECIES]): Promise<MultiSpeciesExpression> {
    const humanEnsemblId = await resolveHumanEnsembl(geneSymbol);
    if (!humanEnsemblId) {
        return { geneSymbol, humanEnsemblId: null, bySpecies: [], notFound: [] };
    }

    const idEntries = await Promise.all(
        species.map(async (sp) => {
            if (sp === "homo_sapiens") return { sp, id: humanEnsemblId };
            const id = await resolveOrtholog(geneSymbol, sp);
            return { sp, id };
        }),
    );

    const bySpecies: SpeciesEntry[] = [];
    const notFound: string[] = [];
    await Promise.all(
        idEntries.map(async ({ sp, id }) => {
            if (!id) {
                notFound.push(sp);
                return;
            }
            const tissues = await fetchBgeeForSpecies(id, SPECIES_TAXON[sp]);
            bySpecies.push({ species: sp, taxonId: SPECIES_TAXON[sp], ensemblId: id, tissues });
        }),
    );

    return { geneSymbol, humanEnsemblId, bySpecies, notFound };
}
