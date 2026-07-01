/**
 * searchCompounds tool — search ChEMBL for compounds by target, name, or SMILES.
 *
 * Supports three search modes:
 * - "target": resolves target ChEMBL ID, fetches activities, extracts unique molecules
 * - "compound": free-text search on molecule names
 * - "smiles": flexmatch on canonical SMILES
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { CHEMBL_BASE, CHEMBL_HEADERS as HEADERS } from "../lib/chembl-config.js";

interface Compound {
    chemblId: string;
    preferredCompoundName: string | null;
    canonicalSmiles: string | null;
    molecularWeight: number | null;
    alogp: number | null;
    molecularFormula: string | null;
}

interface MoleculeRecord {
    molecule_chembl_id?: string;
    pref_name?: string;
    molecule_structures?: {
        canonical_smiles?: string;
    };
    molecule_properties?: {
        full_mwt?: string;
        alogp?: string;
        molecular_formula?: string;
    };
}

interface TargetRecord {
    target_chembl_id?: string;
}

interface ActivityRecord {
    molecule_chembl_id?: string;
}

function mapMolecule(raw: MoleculeRecord): Compound {
    return {
        chemblId: raw.molecule_chembl_id ?? "",
        preferredCompoundName: raw.pref_name ?? null,
        canonicalSmiles: raw.molecule_structures?.canonical_smiles ?? null,
        molecularWeight: raw.molecule_properties?.full_mwt ? parseFloat(raw.molecule_properties.full_mwt) : null,
        alogp: raw.molecule_properties?.alogp ? parseFloat(raw.molecule_properties.alogp) : null,
        molecularFormula: raw.molecule_properties?.molecular_formula ?? null,
    };
}

async function searchByTarget(query: string, limit: number): Promise<Compound[]> {
    // Step 1: Search targets to resolve ChEMBL ID
    const targetRes = await apiFetch<{ targets?: TargetRecord[] }>(`${CHEMBL_BASE}/target/search.json?q=${encodeURIComponent(query)}&limit=1`, {
        headers: HEADERS,
    });
    if (targetRes.isErr()) {
        if (targetRes.error.type === "http_status" && targetRes.error.status === 404) return [];
        throw new Error(describeApiError(targetRes.error));
    }
    if (!targetRes.value.targets?.length) return [];

    const targetChemblId = targetRes.value.targets[0].target_chembl_id;
    if (!targetChemblId) return [];

    // Step 2: Fetch activities for that target
    const activityRes = await apiFetch<{ activities?: ActivityRecord[] }>(`${CHEMBL_BASE}/activity.json?target_chembl_id=${targetChemblId}&limit=${limit}`, {
        headers: HEADERS,
    });
    if (activityRes.isErr()) {
        if (activityRes.error.type === "http_status" && activityRes.error.status === 404) return [];
        throw new Error(describeApiError(activityRes.error));
    }
    if (!activityRes.value.activities?.length) return [];

    // Step 3: Extract unique molecule IDs
    const uniqueIds = new Set<string>();
    for (const act of activityRes.value.activities) {
        if (act.molecule_chembl_id) uniqueIds.add(act.molecule_chembl_id);
    }

    // Step 4: Fetch molecule details for unique compounds
    const compounds: Compound[] = [];
    const idArray = [...uniqueIds];
    // Fetch in batches of 50 to avoid overly long URLs
    const batchSize = 50;
    for (let i = 0; i < idArray.length; i += batchSize) {
        const batch = idArray.slice(i, i + batchSize);
        const idsParam = batch.join(";");
        const molRes = await apiFetch<{ molecules?: MoleculeRecord[] }>(`${CHEMBL_BASE}/molecule/set/${idsParam}.json`, { headers: HEADERS });
        if (molRes.isErr()) {
            if (!(molRes.error.type === "http_status" && molRes.error.status === 404)) {
                throw new Error(describeApiError(molRes.error));
            }
            continue;
        }
        if (molRes.value.molecules) {
            for (const mol of molRes.value.molecules) {
                compounds.push(mapMolecule(mol));
            }
        }
    }

    return compounds;
}

async function searchByCompound(query: string, limit: number): Promise<Compound[]> {
    const res = await apiFetch<{ molecules?: MoleculeRecord[] }>(`${CHEMBL_BASE}/molecule/search.json?q=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: HEADERS,
    });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return (res.value.molecules ?? []).map(mapMolecule);
}

async function searchBySmiles(smiles: string, limit: number): Promise<Compound[]> {
    const res = await apiFetch<{ molecules?: MoleculeRecord[] }>(
        `${CHEMBL_BASE}/molecule.json?molecule_structures__canonical_smiles__flexmatch=${encodeURIComponent(smiles)}&limit=${limit}`,
        { headers: HEADERS },
    );
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return (res.value.molecules ?? []).map(mapMolecule);
}

export const searchCompoundsTool = defineTool({
    id: "search_compounds",
    description:
        "Search ChEMBL for compounds by target name/ChEMBL ID, compound name, or SMILES. " +
        "Returns compound metadata including ChEMBL IDs, SMILES, molecular weight, and LogP. " +
        "Use searchType='target' to find compounds active against a target, " +
        "'compound' for name search, 'smiles' for structure matching.",
    inputSchema: z.object({
        query: z.string().min(1).describe("Search term: target name/ID, compound name, or SMILES string"),
        searchType: z
            .enum(["target", "compound", "smiles"])
            .describe("What to search by: 'target' (find active compounds), 'compound' (name search), 'smiles' (structure match)"),
        limit: z.number().int().min(1).max(500).default(500).describe("Maximum number of results to return"),
    }),
    execute: async ({ query, searchType, limit = 500 }) => {
        let compounds: Compound[];

        if (searchType === "target") {
            compounds = await searchByTarget(query, limit);
        } else if (searchType === "smiles") {
            compounds = await searchBySmiles(query, limit);
        } else {
            compounds = await searchByCompound(query, limit);
        }

        return ok({ compounds });
    },
});
