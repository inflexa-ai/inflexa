/**
 * searchPubchemCompound tool — resolve compounds against PubChem's 110M+ database.
 *
 * Supports search by name, SMILES, InChI, InChIKey, or CID.
 * Returns compound identity and computed molecular properties.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
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

// A single schema that both validates and normalizes one PUG-REST property row:
// the `.object(...)` half is the wire shape (every field optional — PubChem
// omits absent properties), the `.transform(...)` half maps it to the camelCase
// `Compound` we return. Parsing IS the validation, and because the transform
// rides on the schema, `z.infer` below is the OUTPUT type — no separate raw
// interface or mapper.
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

const PubChemPropertyResponseSchema = z.object({
    PropertyTable: z.object({ Properties: z.array(PugPropertyRowSchema).optional() }).optional(),
});

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
        "Resolve a compound in PubChem (110M+ compounds) by name, SMILES, InChI, InChIKey, or CID. " +
        "Returns identity (cid, canonicalSmiles, inchi, inchiKey, iupacName, molecularFormula) and computed properties " +
        "(molecularWeight, xlogp, tpsa, hbondDonorCount, hbondAcceptorCount, rotatableBondCount, complexity). " +
        "Reach for this when ChEMBL misses the compound — PubChem covers metabolites, vendor chemicals, food additives and environmental compounds that ChEMBL does not. " +
        "It carries no curated mechanism or potency data: once resolved, bridge to ChEMBL with get_pubchem_cross_refs and query get_mechanism / get_bioactivity there. " +
        "An empty results array is a valid 'no match' — do not retry.",
    inputSchema: z.object({
        query: z
            .string()
            .min(1)
            .describe("The identifier itself; its form must match `searchBy` (a name, a SMILES string, an InChI, an InChIKey, or a numeric CID)."),
        searchBy: z
            .enum(["name", "smiles", "inchi", "inchikey", "cid"])
            .describe("Which PubChem namespace `query` is expressed in. All are exact-match lookups except 'name', which tolerates synonyms and trade names."),
    }),
    execute: async ({ query, searchBy }) => {
        const namespace = buildNamespace(searchBy, query);
        const url = `${PUBCHEM_BASE}/${namespace}/property/${PROPERTY_LIST}/JSON`;

        const res = await apiFetchValidated(url, PubChemPropertyResponseSchema, { headers: HEADERS });

        if (res.isErr()) {
            // PubChem returns 404 when the query matches no compound — expected.
            if (res.error.type === "http_status" && res.error.status === 404) return ok({ results: [] });
            throw new Error(describeApiError(res.error));
        }

        // Already validated + normalized by PugPropertyRowSchema's transform.
        const rows = res.value.PropertyTable?.Properties ?? [];
        return ok({ results: rows });
    },
});
