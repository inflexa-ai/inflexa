/**
 * Pure async client functions for the PubChem PUG-REST API
 * (https://pubchem.ncbi.nlm.nih.gov/rest/pug/).
 *
 * Used by the modulator-metadata enrichment step to refine ChEMBL's
 * `molecule_type` annotation when ChEMBL itself returns "Unknown" — PubChem
 * exposes molecular weight + SMILES + InChI properties that let us
 * heuristically classify peptides, small molecules, and proteins without a
 * hand-curated override table.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
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
    // The PUG-REST schema renamed the small-molecule SMILES field to
    // ConnectivitySMILES in late 2024; CanonicalSMILES still works but is
    // deprecated. We request both and fall back through them.
    "ConnectivitySMILES",
    "CanonicalSMILES",
    "HBondDonorCount",
    "HBondAcceptorCount",
].join(",");

// A single record from the PUG-REST `PropertyTable.Properties` array, validated
// at the fetch boundary. Every field is optional — PubChem omits absent
// properties, and a row missing `CID` is handled gracefully by the caller's
// guard (returns null) rather than being a contract break.
const RawPubChemPropertySchema = z.object({
    CID: z.number().optional(),
    MolecularWeight: z.unknown(),
    InChIKey: z.unknown(),
    ConnectivitySMILES: z.unknown(),
    CanonicalSMILES: z.unknown(),
    HBondDonorCount: z.unknown(),
    HBondAcceptorCount: z.unknown(),
});
type RawPubChemProperty = z.infer<typeof RawPubChemPropertySchema>;

const PubChemPropertyResponseSchema = z.object({
    PropertyTable: z.object({ Properties: z.array(RawPubChemPropertySchema).optional() }).optional(),
});

const PubChemCidListResponseSchema = z.object({
    IdentifierList: z.object({ CID: z.array(z.number()).optional() }).optional(),
});

function parseNumber(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function mapProps(raw: RawPubChemProperty): PubChemCompoundProperties {
    return {
        cid: raw.CID ?? 0,
        molecularWeight: parseNumber(raw.MolecularWeight),
        inchiKey: typeof raw.InChIKey === "string" ? raw.InChIKey : null,
        canonicalSmiles:
            typeof raw.ConnectivitySMILES === "string" ? raw.ConnectivitySMILES : typeof raw.CanonicalSMILES === "string" ? raw.CanonicalSMILES : null,
        hBondDonorCount: typeof raw.HBondDonorCount === "number" ? raw.HBondDonorCount : parseNumber(raw.HBondDonorCount),
        hBondAcceptorCount: typeof raw.HBondAcceptorCount === "number" ? raw.HBondAcceptorCount : parseNumber(raw.HBondAcceptorCount),
    };
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
    return mapProps(props);
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
