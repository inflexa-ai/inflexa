/**
 * Pure async client functions for the Ensembl REST API.
 *
 * Used by §1.1 (Entity resolution) and as a fallback for ID resolution.
 */

import { apiFetch, describeApiError } from "./api-utils.js";

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

function mapGene(symbol: string, raw: Record<string, unknown>): GeneInfo {
    return {
        symbol,
        id: (raw.id as string) ?? "",
        displayName: (raw.display_name as string) ?? "",
        description: (raw.description as string) ?? "",
        biotype: (raw.biotype as string) ?? "",
        start: (raw.start as number) ?? 0,
        end: (raw.end as number) ?? 0,
        strand: (raw.strand as number) ?? 0,
        assemblyName: (raw.assembly_name as string) ?? "",
        seqRegionName: (raw.seq_region_name as string) ?? "",
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
        const result = await apiFetch<Record<string, unknown>>(`${ENSEMBL_BASE}/lookup/symbol/${species}/${symbols[0]}${expandParam}`, { headers: HEADERS });
        if (result.isErr()) {
            if (result.error.type === "http_status" && result.error.status === 400) {
                return { genes: [], notFound: [symbols[0]] };
            }
            throw new Error(describeApiError(result.error));
        }
        return { genes: [mapGene(symbols[0], result.value)], notFound: [] };
    }

    const result = await apiFetch<Record<string, Record<string, unknown>>>(`${ENSEMBL_BASE}/lookup/symbol/${species}`, {
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
    const res = await apiFetch<{ id?: string }>(url, { headers: HEADERS });
    if (res.isErr()) return null;
    if (typeof res.value.id !== "string" || !res.value.id.startsWith("ENSG")) return null;
    return res.value.id;
}
