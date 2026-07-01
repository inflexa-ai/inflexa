/**
 * searchPubchemCompound tool — resolve compounds against PubChem's 110M+ database.
 *
 * Supports search by name, SMILES, InChI, InChIKey, or CID.
 * Returns compound identity and computed molecular properties.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "../lib/pubchem-config.js";

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

interface Compound {
    cid: number;
    canonicalSmiles: string | null;
    molecularFormula: string | null;
    molecularWeight: number | null;
    iupacName: string | null;
    inchi: string | null;
    inchiKey: string | null;
    xlogp: number | null;
    tpsa: number | null;
    hbondDonorCount: number | null;
    hbondAcceptorCount: number | null;
    rotatableBondCount: number | null;
    complexity: number | null;
}

interface PugPropertyRow {
    CID?: number;
    CanonicalSMILES?: string;
    MolecularFormula?: string;
    MolecularWeight?: number;
    IUPACName?: string;
    InChI?: string;
    InChIKey?: string;
    XLogP?: number;
    TPSA?: number;
    HBondDonorCount?: number;
    HBondAcceptorCount?: number;
    RotatableBondCount?: number;
    Complexity?: number;
}

function mapCompound(raw: PugPropertyRow): Compound {
    return {
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
    };
}

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

export const searchPubchemCompoundTool = defineTool({
    id: "search_pubchem_compound",
    description:
        "Search PubChem for a compound by name, SMILES, InChI, InChIKey, or CID. " +
        "Returns compound identity (CID, SMILES, InChI, IUPAC name) and computed properties " +
        "(molecular weight, XLogP, TPSA, HBD, HBA, rotatable bonds, complexity). " +
        "PubChem covers 110M+ compounds — use when ChEMBL doesn't find the compound.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Search term: compound name, SMILES, InChI, InChIKey, or CID"),
        searchBy: z.enum(["name", "smiles", "inchi", "inchikey", "cid"]).describe("Identifier type for the query"),
    }),
    execute: async ({ query, searchBy }) => {
        const namespace = buildNamespace(searchBy, query);
        const url = `${PUBCHEM_BASE}/${namespace}/property/${PROPERTY_LIST}/JSON`;

        const res = await apiFetch<{
            PropertyTable?: { Properties?: PugPropertyRow[] };
        }>(url, { headers: HEADERS });

        if (res.isErr()) {
            // PubChem returns 404 when the query matches no compound — expected.
            if (res.error.type === "http_status" && res.error.status === 404) return ok({ results: [] });
            throw new Error(describeApiError(res.error));
        }

        const rows = res.value.PropertyTable?.Properties ?? [];
        return ok({ results: rows.map(mapCompound) });
    },
});
