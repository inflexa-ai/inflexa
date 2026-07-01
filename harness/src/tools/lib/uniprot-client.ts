/**
 * Pure async client functions for the UniProt REST API
 * (https://rest.uniprot.org/uniprotkb/).
 *
 * Used by target-assessment as the source of truth for:
 *   - ChEMBL cross-references — every ChEMBL target id linked to a UniProt
 *     accession (replaces the hand-curated ALTERNATE_CHEMBL_IDS map).
 *   - Protein family text — used together with IUPHAR family-target
 *     resolution to identify sibling receptors in the same pharmacological
 *     family (replaces the hand-curated RELATED_FAMILY_UNIPROTS map).
 */

import { apiFetch, describeApiError } from "./api-utils.js";
import { UNIPROT_BASE, UNIPROT_HEADERS } from "./uniprot-config.js";

export interface UniProtRecord {
    primaryAccession: string;
    uniProtkbId: string | null;
    geneNames: string[];
    chemblIds: string[];
    reactomePathwayIds: string[];
    proteinFamilyText: string | null;
}

interface RawXref {
    database?: string;
    id?: string;
}

interface RawGene {
    geneName?: { value?: string };
    synonyms?: Array<{ value?: string }>;
}

interface RawComment {
    commentType?: string;
    texts?: Array<{ value?: string }>;
}

interface RawUniProt {
    primaryAccession?: string;
    uniProtkbId?: string;
    genes?: RawGene[];
    uniProtKBCrossReferences?: RawXref[];
    comments?: RawComment[];
}

const FIELDS = ["accession", "id", "gene_names", "xref_chembl", "xref_reactome", "cc_similarity"].join(",");

function extractFamilyText(comments?: RawComment[]): string | null {
    if (!comments) return null;
    for (const c of comments) {
        if (c.commentType !== "SIMILARITY") continue;
        for (const t of c.texts ?? []) {
            const v = t.value?.trim();
            if (v) return v;
        }
    }
    return null;
}

function mapUniProt(raw: RawUniProt): UniProtRecord {
    const chemblIds: string[] = [];
    const reactomeIds: string[] = [];
    for (const x of raw.uniProtKBCrossReferences ?? []) {
        if (!x.id) continue;
        if (x.database === "ChEMBL") chemblIds.push(x.id);
        else if (x.database === "Reactome") reactomeIds.push(x.id);
    }
    const geneNames: string[] = [];
    for (const g of raw.genes ?? []) {
        const name = g.geneName?.value;
        if (name) geneNames.push(name);
    }
    return {
        primaryAccession: raw.primaryAccession ?? "",
        uniProtkbId: raw.uniProtkbId ?? null,
        geneNames,
        chemblIds,
        reactomePathwayIds: reactomeIds,
        proteinFamilyText: extractFamilyText(raw.comments),
    };
}

/**
 * Fetch a single UniProtKB entry by accession. Returns null on 404; throws
 * on other HTTP errors so callers can surface upstream outages.
 */
export async function getUniProtRecord(accession: string): Promise<UniProtRecord | null> {
    const url = `${UNIPROT_BASE}/uniprotkb/${encodeURIComponent(accession)}?fields=${FIELDS}&format=json`;
    const res = await apiFetch<RawUniProt>(url, { headers: UNIPROT_HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return null;
        throw new Error(describeApiError(res.error));
    }
    if (!res.value?.primaryAccession) return null;
    return mapUniProt(res.value);
}

/** All ChEMBL target ids cross-referenced from a UniProt accession. */
export async function getChemblIdsByUniProt(accession: string): Promise<string[]> {
    const rec = await getUniProtRecord(accession);
    return rec?.chemblIds ?? [];
}

/** All Reactome pathway ids cross-referenced from a UniProt accession. */
export async function getReactomePathwaysByUniProt(accession: string): Promise<string[]> {
    const rec = await getUniProtRecord(accession);
    return rec?.reactomePathwayIds ?? [];
}
