/**
 * PubChem PUG-REST operations — the three lookups the PubChem tools expose.
 *
 * One home for the wire schemas, the URL construction, and the "PubChem 404
 * means no data" contract, so a caller cannot drift from it: every function
 * returns an empty collection for a 404 and throws on any other API failure.
 *
 * Absence policy: PubChem omits the key of an absent value, per `minOccurs=0`
 * in its XSD, and it never sends an explicit `null`. Thus a maybe-absent field
 * carries `.optional()`, not `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, parseWireNumber, zWireNumber } from "./api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "./pubchem-config.js";

export type PubChemSearchBy = "name" | "smiles" | "inchi" | "inchikey" | "cid";

const PROPERTY_LIST = [
    "MolecularFormula",
    "MolecularWeight",
    // PubChem retired the response key `CanonicalSMILES`, and it answers a request
    // for that name with `ConnectivitySMILES`. Thus the request names the live key.
    "ConnectivitySMILES",
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
        ConnectivitySMILES: z.string().optional(),
        MolecularFormula: z.string().optional(),
        // PUG-REST serializes MolecularWeight as a string (e.g. "180.16") to
        // preserve significant figures, thus it reads through the wire-number helper.
        MolecularWeight: zWireNumber.optional(),
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
        canonicalSmiles: raw.ConnectivitySMILES ?? null,
        molecularFormula: raw.MolecularFormula ?? null,
        molecularWeight: raw.MolecularWeight ?? null,
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

export const PubChemPropertyResponseSchema = z.object({
    PropertyTable: z.object({ Properties: z.array(PugPropertyRowSchema).optional() }).optional(),
});

export interface PubChemCrossRef {
    /** The registry that the identifier pattern names, or `null` when no pattern matches. */
    source: string | null;
    id: string;
}

// The PUG-REST xrefs wire shape, validated at the fetch boundary: one
// `Information` entry per CID with its `RegistryID[]` list. Every field is
// optional — PubChem omits absent values.
export const PubChemXrefResponseSchema = z.object({
    InformationList: z
        .object({
            Information: z
                .array(
                    z.object({
                        CID: z.number().optional(),
                        RegistryID: z.array(z.string()).optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});

/**
 * The registry of each identifier pattern that PubChem serves in `RegistryID`.
 *
 * The `RegistryID` and `SourceName` lists of the endpoint are not parallel and
 * they hold a different number of entries, thus an index cannot pair them. The
 * identifier itself carries the registry, and the pattern reads it.
 *
 * A loose pattern runs last, thus a specific registry claims its own id first.
 */
const REGISTRY_PATTERNS: ReadonlyArray<readonly [source: string, pattern: RegExp]> = [
    ["ChEMBL", /^CHEMBL\d+$/],
    ["ChEBI", /^CHEBI:\d+$/],
    ["DrugBank", /^DB\d{5}$/],
    ["KEGG", /^[CD]\d{5}$/],
    ["HMDB", /^HMDB\d+$/],
    ["CAS", /^\d{2,7}-\d{2}-\d$/],
    // A PDB id is four characters that start with a digit. The lookahead demands a
    // letter as well, thus a plain registry number does not read as a structure.
    ["PDB", /^[1-9](?=.*[A-Za-z])[0-9A-Za-z]{3}$/],
    // A UNII is ten alphanumeric characters, and the lookahead demands a letter
    // among them. A plain ten-digit registry number, such as `0000050782`, matches
    // the pattern without it, and the row then names the wrong registry.
    ["UNII", /^(?=.*[A-Z])[A-Z0-9]{10}$/],
];

/** The registry of one identifier, or `null` when no pattern matches it. */
export function classifyRegistryId(id: string): string | null {
    for (const [source, pattern] of REGISTRY_PATTERNS) {
        if (pattern.test(id)) return source;
    }
    return null;
}

export interface PubChemAssay {
    aid: number;
    assayName: string | null;
    targetName: string | null;
    activityOutcome: string | null;
    activityValue: number | null;
}

// The PUG-REST assay-summary wire shape, validated at the fetch boundary: one
// `Column` list of plain heading strings, and one `Cell` list of plain strings
// for each row, with an entry for each column. An empty cell is the empty
// string. `parseAssaySummary` maps the heading-indexed cells into `PubChemAssay`
// records. Every field is optional — PubChem omits absent values.
export const PugAssaySummarySchema = z.object({
    Table: z
        .object({
            Columns: z.object({ Column: z.array(z.string()).optional() }).optional(),
            Row: z.array(z.object({ Cell: z.array(z.string()).optional() })).optional(),
        })
        .optional(),
});
type PugAssaySummary = z.infer<typeof PugAssaySummarySchema>;

/** The wire headings that the assay summary carries. They hold spaces and a unit. */
const ASSAY_HEADINGS = {
    aid: "AID",
    assayName: "Assay Name",
    targetAccession: "Target Accession",
    activityOutcome: "Activity Outcome",
    activityValue: "Activity Value [uM]",
} as const;

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
    return (res.value.PropertyTable?.Properties ?? []).filter(carriesProperties);
}

/**
 * Does the row hold a property?
 *
 * PubChem answers HTTP 200 for a CID that does not exist, with one row that
 * carries the `CID` alone. Thus a row with no property is an absence, and a
 * caller must not read it as a compound.
 */
function carriesProperties(row: PubChemCompound): boolean {
    return Object.entries(row).some(([key, value]) => key !== "cid" && value !== null);
}

/** External registry ids for a CID. Empty array = the CID is in no external registry. */
export async function fetchPubchemCrossRefs(cid: number): Promise<PubChemCrossRef[]> {
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/xrefs/RegistryID/JSON`;

    const res = await apiFetchValidated(url, PubChemXrefResponseSchema, { headers: HEADERS });

    if (res.isErr()) {
        // PubChem returns 404 when the CID has no cross-references — expected.
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    // PUG-REST xrefs returns an InformationList with one entry per CID.
    const info = res.value.InformationList?.Information?.[0];
    if (!info?.RegistryID?.length) return [];

    return info.RegistryID.map((id) => ({ source: classifyRegistryId(id), id }));
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

/**
 * Read the assay table by its wire headings.
 *
 * The `targetName` of a record is the target accession, because the table names
 * no protein. The accession resolves against UniProt or against a ChEMBL target.
 */
export function parseAssaySummary(data: PugAssaySummary): PubChemAssay[] {
    const columns = data.Table?.Columns?.Column ?? [];
    const rows = data.Table?.Row ?? [];

    const headingIndex = new Map<string, number>();
    for (const [index, heading] of columns.entries()) {
        headingIndex.set(heading, index);
    }

    const aidIdx = headingIndex.get(ASSAY_HEADINGS.aid);
    const nameIdx = headingIndex.get(ASSAY_HEADINGS.assayName);
    const targetIdx = headingIndex.get(ASSAY_HEADINGS.targetAccession);
    const outcomeIdx = headingIndex.get(ASSAY_HEADINGS.activityOutcome);
    const valueIdx = headingIndex.get(ASSAY_HEADINGS.activityValue);

    const results: PubChemAssay[] = [];

    for (const row of rows) {
        const cells = row.Cell ?? [];

        // An empty cell is the empty string, which carries no value.
        const getCellStr = (idx: number | undefined): string | null => {
            if (idx === undefined) return null;
            const cell = cells[idx];
            return cell !== undefined && cell !== "" ? cell : null;
        };
        const getCellNum = (idx: number | undefined): number | null => parseWireNumber(getCellStr(idx));

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
