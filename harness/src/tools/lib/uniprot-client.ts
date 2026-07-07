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

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { UNIPROT_BASE, UNIPROT_HEADERS } from "./uniprot-config.js";

export interface UniProtRecord {
    primaryAccession: string;
    uniProtkbId: string | null;
    geneNames: string[];
    chemblIds: string[];
    reactomePathwayIds: string[];
    proteinFamilyText: string | null;
}

const RawCommentSchema = z.object({
    commentType: z.string().optional(),
    texts: z.array(z.object({ value: z.string().optional() })).optional(),
});
type RawComment = z.infer<typeof RawCommentSchema>;

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

// A single schema that both validates the raw UniProtKB wire shape and
// normalizes it into the `UniProtRecord` we return. Every field is optional
// because the API omits absent values; parsing IS the validation, so a payload
// whose field TYPES drift is rejected as `invalid_response` rather than silently
// mis-mapped. `z.infer` of the transform is the `UniProtRecord` output type.
const UniProtRecordSchema = z
    .object({
        primaryAccession: z.string().optional(),
        uniProtkbId: z.string().optional(),
        genes: z
            .array(
                z.object({
                    geneName: z.object({ value: z.string().optional() }).optional(),
                    synonyms: z.array(z.object({ value: z.string().optional() })).optional(),
                }),
            )
            .optional(),
        uniProtKBCrossReferences: z.array(z.object({ database: z.string().optional(), id: z.string().optional() })).optional(),
        comments: z.array(RawCommentSchema).optional(),
    })
    .transform((raw): UniProtRecord => {
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
    });

/**
 * Fetch a single UniProtKB entry by accession. Returns null on 404; throws
 * on other HTTP errors so callers can surface upstream outages.
 */
export async function getUniProtRecord(accession: string): Promise<UniProtRecord | null> {
    const url = `${UNIPROT_BASE}/uniprotkb/${encodeURIComponent(accession)}?fields=${FIELDS}&format=json`;
    const res = await apiFetchValidated(url, UniProtRecordSchema, { headers: UNIPROT_HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return null;
        throw new Error(describeApiError(res.error));
    }
    if (!res.value.primaryAccession) return null;
    return res.value;
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
