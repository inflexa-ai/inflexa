/**
 * PubChem PUG-REST operations — the three lookups the PubChem tools expose.
 *
 * One home for the wire schemas, the URL construction, and the "PubChem 404
 * means no data" contract, so a caller cannot drift from it: every function
 * returns an empty collection for a 404 and throws on any other API failure.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "./pubchem-config.js";

export type PubChemSearchBy = "name" | "smiles" | "inchi" | "inchikey" | "cid";

const PROPERTY_LIST = [
    "MolecularFormula",
    "MolecularWeight",
    "CanonicalSMILES",
    "InChI",
    "InChIKey",
    "IUPACName",
    "XLogP",
    "TPSA",
    "HBondDonorCount",
    "HBondAcceptorCount",
    "RotatableBondCount",
    "Complexity",
].join(",");

// A single schema that both validates and normalizes one PUG-REST property row:
// the `.object(...)` half is the wire shape (every field optional — PubChem
// omits absent properties), the `.transform(...)` half maps it to the camelCase
// `PubChemCompound` we return. Parsing IS the validation, and because the
// transform rides on the schema, `z.infer` below is the OUTPUT type — no
// separate raw interface or mapper.
const PugPropertyRowSchema = z
    .object({
        CID: z.number().optional(),
        CanonicalSMILES: z.string().optional(),
        MolecularFormula: z.string().optional(),
        // PUG-REST serializes MolecularWeight as a string (e.g. "180.16") to
        // preserve significant figures; accept both and let the transform's
        // `Number(...)` normalize it.
        MolecularWeight: z.union([z.number(), z.string()]).optional(),
        IUPACName: z.string().optional(),
        InChI: z.string().optional(),
        InChIKey: z.string().optional(),
        XLogP: z.number().optional(),
        TPSA: z.number().optional(),
        HBondDonorCount: z.number().optional(),
        HBondAcceptorCount: z.number().optional(),
        RotatableBondCount: z.number().optional(),
        Complexity: z.number().optional(),
    })
    .transform((raw) => ({
        cid: raw.CID ?? 0,
        canonicalSmiles: raw.CanonicalSMILES ?? null,
        molecularFormula: raw.MolecularFormula ?? null,
        molecularWeight: raw.MolecularWeight != null ? Number(raw.MolecularWeight) : null,
        iupacName: raw.IUPACName ?? null,
        inchi: raw.InChI ?? null,
        inchiKey: raw.InChIKey ?? null,
        xlogp: raw.XLogP ?? null,
        tpsa: raw.TPSA ?? null,
        hbondDonorCount: raw.HBondDonorCount ?? null,
        hbondAcceptorCount: raw.HBondAcceptorCount ?? null,
        rotatableBondCount: raw.RotatableBondCount ?? null,
        complexity: raw.Complexity ?? null,
    }));

export type PubChemCompound = z.infer<typeof PugPropertyRowSchema>;

const PubChemPropertyResponseSchema = z.object({
    PropertyTable: z.object({ Properties: z.array(PugPropertyRowSchema).optional() }).optional(),
});

export interface PubChemCrossRef {
    source: string;
    id: string;
}

// The PUG-REST xrefs wire shape, validated at the fetch boundary: one
// `Information` entry per CID with parallel `RegistryID[]` / `SourceName[]`
// arrays. Every field is optional — PubChem omits absent values.
const PubChemXrefResponseSchema = z.object({
    InformationList: z
        .object({
            Information: z
                .array(
                    z.object({
                        CID: z.number().optional(),
                        RegistryID: z.array(z.string()).optional(),
                        SourceName: z.array(z.string()).optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});

export interface PubChemAssay {
    aid: number;
    assayName: string | null;
    targetName: string | null;
    activityOutcome: string | null;
    activityValue: number | null;
}

// The PUG-REST assay-summary wire shape (a table of columns + rows), validated
// at the fetch boundary; `parseAssaySummary` maps the heading-indexed cells into
// `PubChemAssay` records. Every field is optional — PubChem omits absent values.
const PugAssaySummarySchema = z.object({
    Table: z
        .object({
            Columns: z
                .object({
                    Column: z.array(z.object({ Heading: z.string().optional() })).optional(),
                })
                .optional(),
            Row: z
                .array(
                    z.object({
                        Cell: z
                            .array(
                                z.object({
                                    intval: z.number().optional(),
                                    fval: z.number().optional(),
                                    sval: z.string().optional(),
                                }),
                            )
                            .optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});
type PugAssaySummary = z.infer<typeof PugAssaySummarySchema>;

/** Build the PUG-REST URL path segment for the given search type. */
function buildNamespace(searchBy: string, query: string): string {
    switch (searchBy) {
        case "name":
            return `compound/name/${encodeURIComponent(query)}`;
        case "smiles":
            return `compound/smiles/${encodeURIComponent(query)}`;
        case "inchi":
            return `compound/inchi/${encodeURIComponent(query)}`;
        case "inchikey":
            return `compound/inchikey/${encodeURIComponent(query)}`;
        case "cid":
            return `compound/cid/${encodeURIComponent(query)}`;
        default:
            return `compound/name/${encodeURIComponent(query)}`;
    }
}

/** Resolve a compound to its identity + computed properties. Empty array = no match. */
export async function fetchPubchemCompounds(query: string, searchBy: PubChemSearchBy): Promise<PubChemCompound[]> {
    const namespace = buildNamespace(searchBy, query);
    const url = `${PUBCHEM_BASE}/${namespace}/property/${PROPERTY_LIST}/JSON`;

    const res = await apiFetchValidated(url, PubChemPropertyResponseSchema, { headers: HEADERS });

    if (res.isErr()) {
        // PubChem returns 404 when the query matches no compound — expected.
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    // Already validated + normalized by PugPropertyRowSchema's transform.
    return res.value.PropertyTable?.Properties ?? [];
}

/** External registry ids for a CID. Empty array = the CID is in no external registry. */
export async function fetchPubchemCrossRefs(cid: number): Promise<PubChemCrossRef[]> {
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/xrefs/RegistryID,SourceName/JSON`;

    const res = await apiFetchValidated(url, PubChemXrefResponseSchema, { headers: HEADERS });

    if (res.isErr()) {
        // PubChem returns 404 when the CID has no cross-references — expected.
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    // PUG-REST xrefs returns an InformationList with one entry per CID.
    // Each entry has parallel RegistryID[] and SourceName[] arrays.
    const info = res.value.InformationList?.Information?.[0];
    if (!info?.RegistryID?.length) return [];

    const crossRefs: PubChemCrossRef[] = [];
    const registryIds = info.RegistryID;
    const sourceNames = info.SourceName ?? [];

    for (let i = 0; i < registryIds.length; i++) {
        crossRefs.push({
            source: sourceNames[i] ?? "Unknown",
            id: registryIds[i] ?? "",
        });
    }

    return crossRefs;
}

/** Bioassay screening summaries for a CID. Empty array = never screened. */
export async function fetchPubchemAssays(cid: number, opts: { activeOnly: boolean; limit: number }): Promise<PubChemAssay[]> {
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/assaysummary/JSON`;

    const res = await apiFetchValidated(url, PugAssaySummarySchema, { headers: HEADERS });

    if (res.isErr()) {
        // PubChem returns 404 when the CID has no assay data — expected.
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    let assays = parseAssaySummary(res.value);

    if (opts.activeOnly) {
        assays = assays.filter((a) => a.activityOutcome?.toLowerCase() === "active");
    }

    return assays.slice(0, opts.limit);
}

function parseAssaySummary(data: PugAssaySummary): PubChemAssay[] {
    const columns = data.Table?.Columns?.Column ?? [];
    const rows = data.Table?.Row ?? [];

    // Find column indices by heading
    const headingIndex = new Map<string, number>();
    for (let i = 0; i < columns.length; i++) {
        if (columns[i].Heading) {
            headingIndex.set(columns[i].Heading!, i);
        }
    }

    const aidIdx = headingIndex.get("AID");
    const nameIdx = headingIndex.get("AssayName");
    const targetIdx = headingIndex.get("TargetName");
    const outcomeIdx = headingIndex.get("ActivityOutcome");
    const valueIdx = headingIndex.get("ActivityValue");

    const results: PubChemAssay[] = [];

    for (const row of rows) {
        const cells = row.Cell ?? [];

        const getCellStr = (idx: number | undefined): string | null => {
            if (idx === undefined || idx >= cells.length) return null;
            return cells[idx]?.sval ?? null;
        };
        const getCellNum = (idx: number | undefined): number | null => {
            if (idx === undefined || idx >= cells.length) return null;
            const cell = cells[idx];
            if (cell?.fval !== undefined) return cell.fval;
            if (cell?.intval !== undefined) return cell.intval;
            return null;
        };

        results.push({
            aid: getCellNum(aidIdx) ?? 0,
            assayName: getCellStr(nameIdx),
            targetName: getCellStr(targetIdx),
            activityOutcome: getCellStr(outcomeIdx),
            activityValue: getCellNum(valueIdx),
        });
    }

    return results;
}
