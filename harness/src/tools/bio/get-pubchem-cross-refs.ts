/**
 * getPubchemCrossRefs tool — retrieve external database identifiers for a PubChem CID.
 *
 * Bridges PubChem compounds to ChEMBL, DrugBank, KEGG, PDB, and other registries.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { PUBCHEM_HEADERS as HEADERS, PUBCHEM_BASE } from "../lib/pubchem-config.js";

interface CrossRefEntry {
    source: string;
    id: string;
}

interface PugXrefRecord {
    RegistryID?: string;
    SourceName?: string;
}

function mapCrossRef(raw: PugXrefRecord): CrossRefEntry {
    return {
        source: raw.SourceName ?? "Unknown",
        id: raw.RegistryID ?? "",
    };
}

export const getPubchemCrossRefsTool = defineTool({
    id: "get_pubchem_cross_refs",
    description:
        "Get external database cross-references for a PubChem CID. " +
        "Returns linked identifiers from ChEMBL, DrugBank, KEGG, PDB, and other registries. " +
        "Use this to bridge PubChem compounds to other databases (e.g., get ChEMBL ID to then " +
        "query bioactivity via ChEMBL tools).",
    inputSchema: z.object({
        cid: z.number().int().positive().describe("PubChem Compound ID (CID)"),
    }),
    execute: async ({ cid }) => {
        const url = `${PUBCHEM_BASE}/compound/cid/${cid}/xrefs/RegistryID,SourceName/JSON`;

        const res = await apiFetch<{
            InformationList?: {
                Information?: Array<{
                    CID?: number;
                    RegistryID?: string[];
                    SourceName?: string[];
                }>;
            };
        }>(url, { headers: HEADERS });

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
