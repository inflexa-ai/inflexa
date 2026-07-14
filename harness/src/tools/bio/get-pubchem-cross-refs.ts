/**
 * getPubchemCrossRefs tool — retrieve external database identifiers for a PubChem CID.
 *
 * Bridges PubChem compounds to ChEMBL, DrugBank, KEGG, PDB, and other registries.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "../lib/pubchem-config.js";

interface CrossRefEntry {
    source: string;
    id: string;
}

interface PugXrefRecord {
    RegistryID?: string;
    SourceName?: string;
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

function mapCrossRef(raw: PugXrefRecord): CrossRefEntry {
    return {
        source: raw.SourceName ?? "Unknown",
        id: raw.RegistryID ?? "",
    };
}

export const getPubchemCrossRefsTool = defineTool({
    id: "get_pubchem_cross_refs",
    description:
        "Get external registry cross-references for a PubChem CID. " +
        "Returns a flat crossRefs array of { source, id } pairs — ChEMBL, DrugBank, KEGG, PDB and many other registries; filter by `source` for the one you want. " +
        "This is the bridge out of PubChem: resolve a compound with search_pubchem_compound, take its ChEMBL ID from here, then get curated data via get_mechanism / get_bioactivity. " +
        "An empty crossRefs array is valid no-data (the CID is in no external registry) — do not retry.",
    inputSchema: z.object({
        cid: z.number().int().positive().describe("PubChem Compound ID as an integer (e.g. 2244 for aspirin), from a prior search_pubchem_compound call."),
    }),
    execute: async ({ cid }) => {
        const url = `${PUBCHEM_BASE}/compound/cid/${cid}/xrefs/RegistryID,SourceName/JSON`;

        const res = await apiFetchValidated(url, PubChemXrefResponseSchema, { headers: HEADERS });

        if (res.isErr()) {
            // PubChem returns 404 when the CID has no cross-references — expected.
            if (res.error.type === "http_status" && res.error.status === 404) return ok({ crossRefs: [] });
            throw new Error(describeApiError(res.error));
        }

        // PUG-REST xrefs returns an InformationList with one entry per CID.
        // Each entry has parallel RegistryID[] and SourceName[] arrays.
        const info = res.value.InformationList?.Information?.[0];
        if (!info?.RegistryID?.length) {
            return ok({ crossRefs: [] });
        }

        const crossRefs: CrossRefEntry[] = [];
        const registryIds = info.RegistryID;
        const sourceNames = info.SourceName ?? [];

        for (let i = 0; i < registryIds.length; i++) {
            crossRefs.push(
                mapCrossRef({
                    RegistryID: registryIds[i],
                    SourceName: sourceNames[i],
                }),
            );
        }

        return ok({ crossRefs });
    },
});
