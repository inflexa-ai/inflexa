/**
 * Pure async client functions for the Ensembl REST API.
 *
 * Used by §1.1 (Entity resolution) and as a fallback for ID resolution.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";

const ENSEMBL_BASE = "https://rest.ensembl.org";
const HEADERS = {
    "Content-Type": "application/json",
    Accept: "application/json",
};

export interface GeneInfo {
    symbol: string;
    id: string;
    displayName: string;
    description: string;
    biotype: string;
    start: number;
    end: number;
    strand: number;
    assemblyName: string;
    seqRegionName: string;
}

// Raw Ensembl gene wire shape (snake_case), validated at the fetch boundary.
// Every field is optional because the API omits absent values; `mapGene`
// normalizes each into the camelCase `GeneInfo` we return.
const RawGeneSchema = z.object({
    id: z.string().optional(),
    display_name: z.string().optional(),
    description: z.string().optional(),
    biotype: z.string().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
    strand: z.number().optional(),
    assembly_name: z.string().optional(),
    seq_region_name: z.string().optional(),
});
type RawGene = z.infer<typeof RawGeneSchema>;

function mapGene(symbol: string, raw: RawGene): GeneInfo {
    return {
        symbol,
        id: raw.id ?? "",
        displayName: raw.display_name ?? "",
        description: raw.description ?? "",
        biotype: raw.biotype ?? "",
        start: raw.start ?? 0,
        end: raw.end ?? 0,
        strand: raw.strand ?? 0,
        assemblyName: raw.assembly_name ?? "",
        seqRegionName: raw.seq_region_name ?? "",
    };
}

export interface LookupOptions {
    species?: string;
    expand?: boolean;
}

export async function lookupGenes(symbols: string[], options: LookupOptions = {}): Promise<{ genes: GeneInfo[]; notFound: string[] }> {
    const species = options.species ?? "homo_sapiens";
    const expand = options.expand ?? false;

    if (symbols.length === 1) {
        const expandParam = expand ? "?expand=1" : "";
        const result = await apiFetchValidated(`${ENSEMBL_BASE}/lookup/symbol/${species}/${symbols[0]}${expandParam}`, RawGeneSchema, { headers: HEADERS });
        if (result.isErr()) {
            if (result.error.type === "http_status" && result.error.status === 400) {
                return { genes: [], notFound: [symbols[0]] };
            }
            throw new Error(describeApiError(result.error));
        }
        return { genes: [mapGene(symbols[0], result.value)], notFound: [] };
    }

    const result = await apiFetchValidated(`${ENSEMBL_BASE}/lookup/symbol/${species}`, z.record(z.string(), RawGeneSchema), {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ symbols }),
    });
    if (result.isErr()) throw new Error(describeApiError(result.error));

    const genes: GeneInfo[] = [];
    const notFound: string[] = [];
    for (const sym of symbols) {
        const raw = result.value[sym];
        if (raw) genes.push(mapGene(sym, raw));
        else notFound.push(sym);
    }
    return { genes, notFound };
}

/** Resolve a single human gene symbol to its canonical Ensembl ID. */
export async function resolveSymbolToEnsemblId(symbol: string): Promise<string | null> {
    const url = `${ENSEMBL_BASE}/lookup/symbol/homo_sapiens/${encodeURIComponent(symbol)}`;
    const res = await apiFetchValidated(url, z.object({ id: z.string().optional() }), { headers: HEADERS });
    if (res.isErr()) return null;
    if (typeof res.value.id !== "string" || !res.value.id.startsWith("ENSG")) return null;
    return res.value.id;
}
