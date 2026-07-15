/**
 * Pure async client functions for biological pathway lookups via KEGG and Reactome.
 *
 * Used by §3.7 (Pathway Context).
 */

import { z } from "zod";

import { apiFetch, apiFetchValidated, parseTSV } from "./api-utils.js";

const KEGG_BASE = "https://rest.kegg.jp";
const REACTOME_BASE = "https://reactome.org/ContentService";

export function stripHtmlAndCollapseWs(s: string): string {
    // Strip tags to a fixpoint: a single pass can leave a `<…>` behind when
    // removing an inner tag lets the surrounding angle brackets form a new one,
    // so repeat until the string stops changing.
    let out = s;
    let prev: string;
    do {
        prev = out;
        out = out.replace(/<[^>]+>/g, "");
    } while (out !== prev);
    return out.replace(/\s+/g, " ").trim();
}

const ORGANISM_MAP: Record<string, string> = {
    hsa: "Homo sapiens",
    mmu: "Mus musculus",
    rno: "Rattus norvegicus",
    dre: "Danio rerio",
    dme: "Drosophila melanogaster",
    cel: "Caenorhabditis elegans",
    sce: "Saccharomyces cerevisiae",
};

export type PathwaySource = "kegg" | "reactome";

export interface Pathway {
    id: string;
    name: string;
    source: PathwaySource;
    description?: string;
    genes?: string[];
    entity_uniprots?: string[]; // Reactome only — UniProt accessions of physical entities in the pathway
    url?: string;
}

// Reactome ContentService raw wire shapes, validated at the fetch boundary.
// Every field is optional because the API omits absent values.

/** A single hit from the Reactome ContentService search response. */
const ReactomeSearchEntrySchema = z.object({
    stId: z.string().optional(),
    name: z.string().optional(),
});
type ReactomeSearchEntry = z.infer<typeof ReactomeSearchEntrySchema>;

const ReactomeSearchResponseSchema = z.object({
    results: z.array(z.object({ entries: z.array(ReactomeSearchEntrySchema).optional() })).optional(),
});

/** Participant list — `searchReactome` reads `displayName` per participant. */
const ReactomeParticipantsSchema = z.array(z.object({ displayName: z.string().optional() }));

/** Participant list — `getPathwayMemberships` reads `refEntities` per participant. */
const ReactomeParticipantEntitiesSchema = z.array(
    z.object({
        refEntities: z.array(z.object({ schemaClass: z.string().optional(), identifier: z.string().optional() })).optional(),
    }),
);

export interface PathwaySearchOptions {
    source?: "kegg" | "reactome" | "both";
    organism?: string;
    includeGenes?: boolean;
    maxResults?: number;
}

export async function searchKegg(query: string, organism: string, maxResults: number, includeGenes: boolean): Promise<Pathway[]> {
    const searchRes = await apiFetch<string>(`${KEGG_BASE}/find/pathway/${encodeURIComponent(query)}`, { parseAs: "text" });
    if (searchRes.isErr()) return [];

    const rows = parseTSV(searchRes.value);
    const pathways: Pathway[] = rows.slice(0, maxResults).map((cols) => {
        const rawId = (cols[0] ?? "").replace("path:", "").replace("map", organism);
        return {
            id: rawId,
            name: (cols[1] ?? "").trim(),
            source: "kegg" as const,
            url: `https://www.kegg.jp/pathway/${rawId}`,
        };
    });

    if (includeGenes) {
        for (const pw of pathways) {
            const geneRes = await apiFetch<string>(`${KEGG_BASE}/link/${organism}/${pw.id}`, { parseAs: "text" });
            if (geneRes.isOk()) {
                const geneRows = parseTSV(geneRes.value);
                pw.genes = geneRows.map((r) => (r[1] ?? "").replace(`${organism}:`, ""));
            }
        }
    }
    return pathways;
}

export async function searchReactome(query: string, species: string, maxResults: number, includeGenes: boolean): Promise<Pathway[]> {
    const params = new URLSearchParams({
        query,
        species,
        types: "Pathway",
        cluster: "true",
        rows: String(maxResults),
    });
    const searchRes = await apiFetchValidated(`${REACTOME_BASE}/search/query?${params}`, ReactomeSearchResponseSchema, {
        headers: { Accept: "application/json" },
    });
    if (searchRes.isErr()) return [];

    const entries: ReactomeSearchEntry[] = [];
    for (const group of searchRes.value.results ?? []) {
        for (const entry of group.entries ?? []) entries.push(entry);
    }

    const pathways: Pathway[] = entries.slice(0, maxResults).map((e) => ({
        id: e.stId ?? "",
        name: stripHtmlAndCollapseWs(e.name ?? ""),
        source: "reactome" as const,
        url: `https://reactome.org/content/detail/${e.stId ?? ""}`,
    }));

    if (includeGenes) {
        for (const pw of pathways) {
            const partRes = await apiFetchValidated(`${REACTOME_BASE}/data/participants/${pw.id}`, ReactomeParticipantsSchema, {
                headers: { Accept: "application/json" },
            });
            if (partRes.isOk()) {
                const names = new Set<string>();
                for (const p of partRes.value) {
                    if (p.displayName) names.add(p.displayName);
                }
                pw.genes = [...names].sort();
            }
        }
    }
    return pathways;
}

export async function searchPathways(query: string, options: PathwaySearchOptions = {}): Promise<Pathway[]> {
    const source = options.source ?? "both";
    const organism = options.organism ?? "hsa";
    const includeGenes = options.includeGenes ?? false;
    const maxResults = options.maxResults ?? 10;
    const reactomeSpecies = ORGANISM_MAP[organism] ?? organism;

    const tasks: Promise<Pathway[]>[] = [];
    if (source === "kegg" || source === "both") {
        tasks.push(searchKegg(query, organism, maxResults, includeGenes));
    }
    if (source === "reactome" || source === "both") {
        tasks.push(searchReactome(query, reactomeSpecies, maxResults, includeGenes));
    }
    const results = await Promise.all(tasks);
    return results.flat();
}

/** Pathway memberships for a gene symbol — used directly by §3.7 collector. */
export async function getPathwayMemberships(geneSymbol: string): Promise<Pathway[]> {
    const [kegg, reactome] = await Promise.all([searchKegg(geneSymbol, "hsa", 25, false), searchReactome(geneSymbol, "Homo sapiens", 25, false)]);
    // For Reactome pathways, fetch participant UniProts (bounded to avoid rate limits).
    await Promise.all(
        reactome.slice(0, 50).map(async (pw) => {
            try {
                const partRes = await apiFetchValidated(`${REACTOME_BASE}/data/participants/${pw.id}`, ReactomeParticipantEntitiesSchema, {
                    headers: { Accept: "application/json" },
                });
                if (partRes.isErr()) return;
                const accs = new Set<string>();
                for (const entity of partRes.value) {
                    for (const ref of entity.refEntities ?? []) {
                        if (ref.schemaClass === "ReferenceGeneProduct" && ref.identifier) {
                            accs.add(ref.identifier);
                        }
                    }
                }
                pw.entity_uniprots = [...accs].sort();
            } catch {
                // Leave entity_uniprots undefined on fetch failure — graceful fallback in dedup
            }
        }),
    );
    return [...kegg, ...reactome];
}
