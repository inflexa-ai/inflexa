/**
 * Pure async client functions for the PubChem PUG-REST API
 * (https://pubchem.ncbi.nlm.nih.gov/rest/pug/).
 *
 * Used by the modulator-metadata enrichment step to refine ChEMBL's
 * `molecule_type` annotation when ChEMBL itself returns "Unknown" — PubChem
 * exposes molecular weight + SMILES + InChI properties that let us
 * heuristically classify peptides, small molecules, and proteins without a
 * hand-curated override table.
 *
 * Absence policy: PubChem omits the key of an absent value, per `minOccurs=0`
 * in its XSD, and it never sends an explicit `null`. Thus a maybe-absent field
 * carries `.optional()`, not `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, zWireNumber } from "./api-utils.js";
import { PUBCHEM_BASE, PUBCHEM_HEADERS } from "./pubchem-config.js";

export interface PubChemCompoundProperties {
    cid: number;
    molecularWeight: number | null;
    inchiKey: string | null;
    canonicalSmiles: string | null;
    hBondDonorCount: number | null;
    hBondAcceptorCount: number | null;
}

const PROPERTY_FIELDS = [
    "MolecularWeight",
    "InChIKey",
    // PubChem retired the response key `CanonicalSMILES`, and it answers a request
    // for that name with `ConnectivitySMILES`. Thus the request names the live key.
    "ConnectivitySMILES",
    "HBondDonorCount",
    "HBondAcceptorCount",
].join(",");

// A single record from the PUG-REST `PropertyTable.Properties` array, validated
// at the fetch boundary. PubChem omits an absent property and it never sends
// `null`, thus each property carries `.optional()` and a declared type. Under
// zod 4 a bare `z.unknown()` is required, which rejects an omission.
const RawPubChemPropertySchema = z.object({
    CID: z.number().optional(),
    // PUG-REST serializes MolecularWeight as a string (e.g. "180.16") to
    // preserve significant figures, thus it reads through the wire-number helper.
    MolecularWeight: zWireNumber.optional(),
    InChIKey: z.string().optional(),
    ConnectivitySMILES: z.string().optional(),
    HBondDonorCount: z.number().optional(),
    HBondAcceptorCount: z.number().optional(),
});
type RawPubChemProperty = z.infer<typeof RawPubChemPropertySchema>;

export const PubChemPropertyResponseSchema = z.object({
    PropertyTable: z.object({ Properties: z.array(RawPubChemPropertySchema).optional() }).optional(),
});

export const PubChemCidListResponseSchema = z.object({
    IdentifierList: z.object({ CID: z.array(z.number()).optional() }).optional(),
});

function mapProps(raw: RawPubChemProperty): PubChemCompoundProperties {
    return {
        cid: raw.CID ?? 0,
        molecularWeight: raw.MolecularWeight ?? null,
        inchiKey: raw.InChIKey ?? null,
        canonicalSmiles: raw.ConnectivitySMILES ?? null,
        hBondDonorCount: raw.HBondDonorCount ?? null,
        hBondAcceptorCount: raw.HBondAcceptorCount ?? null,
    };
}

/**
 * Does the record hold a property?
 *
 * PubChem answers HTTP 200 for a CID that does not exist, with one row that
 * carries the `CID` alone. Thus a record with no property is an absence, and a
 * caller must not read it as a compound.
 */
function carriesProperties(props: PubChemCompoundProperties): boolean {
    return Object.entries(props).some(([key, value]) => key !== "cid" && value !== null);
}

export async function getCompoundPropertiesByCID(cid: number): Promise<PubChemCompoundProperties | null> {
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/property/${PROPERTY_FIELDS}/JSON`;
    const res = await apiFetchValidated(url, PubChemPropertyResponseSchema, {
        headers: PUBCHEM_HEADERS,
    });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return null;
        throw new Error(describeApiError(res.error));
    }
    const props = res.value.PropertyTable?.Properties?.[0];
    if (!props || typeof props.CID !== "number") return null;
    const mapped = mapProps(props);
    return carriesProperties(mapped) ? mapped : null;
}

/**
 * Look up a PubChem compound by InChI key (the canonical hash of the 3-D
 * structure that we can lift from ChEMBL's molecule_structures payload).
 * Returns null when the key is unknown to PubChem.
 */
export async function getCompoundPropertiesByInChIKey(inchiKey: string): Promise<PubChemCompoundProperties | null> {
    const cidUrl = `${PUBCHEM_BASE}/compound/inchikey/${encodeURIComponent(inchiKey)}/cids/JSON`;
    const cidRes = await apiFetchValidated(cidUrl, PubChemCidListResponseSchema, {
        headers: PUBCHEM_HEADERS,
    });
    if (cidRes.isErr()) {
        if (cidRes.error.type === "http_status" && cidRes.error.status === 404) return null;
        throw new Error(describeApiError(cidRes.error));
    }
    const cid = cidRes.value.IdentifierList?.CID?.[0];
    if (cid == null) return null;
    return getCompoundPropertiesByCID(cid);
}

const AMIDE_BOND_RE = /C\(=O\)N/g;

/**
 * Heuristic molecule-type classifier driven by PubChem properties.
 *
 *   MW < 1500            → "Small molecule"
 *   MW 1500–100,000      → "Peptide" when the SMILES carries ≥5 amide bonds, else "Unknown"
 *   MW > 100,000         → "Protein"
 *   No MW available      → "Unknown"
 *
 * The amide-bond floor (≥5) is a tractable check that catches insulin-class,
 * calcitonin-class, and other small/medium peptide drugs while rejecting
 * polyketides and macrocyclic small molecules of similar MW. We don't try to
 * distinguish antibody/oligonucleotide modalities here — ChEMBL annotates
 * those reliably; this heuristic only fires on its "Unknown" rows.
 */
export function classifyMoleculeType(props: PubChemCompoundProperties): string {
    const mw = props.molecularWeight;
    if (mw == null || mw <= 0) return "Unknown";
    if (mw > 100_000) return "Protein";
    if (mw >= 1500) {
        const amideCount = (props.canonicalSmiles ?? "").match(AMIDE_BOND_RE)?.length ?? 0;
        if (amideCount >= 5) return "Peptide";
        return "Unknown";
    }
    return "Small molecule";
}
