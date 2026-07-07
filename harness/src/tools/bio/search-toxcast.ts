/**
 * searchToxcast — search EPA ToxCast/Tox21 high-throughput screening data
 * for a chemical via the CTX Bioactivity API.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { EPA_CCTE_BASE, getEpaCcteHeaders } from "../lib/toxcast-config.js";

interface ToxcastAssayResult {
    aeid: number;
    assayEndpoint: string;
    ac50: number | null;
    hitCall: number;
    maxMean: number | null;
    model: string;
    flags: string[];
}

type ToxcastOutput =
    | { found: false; query: string }
    | {
          found: true;
          chemical: {
              dtxsid: string;
              preferredName: string;
              casrn: string | null;
              totalAssays: number;
              activeAssays: number;
              activeHitRate: number;
              results: ToxcastAssayResult[];
          };
      };

interface CtxChemicalSearchRow {
    dtxsid: string;
    preferredName?: string;
    casrn?: string | null;
}

interface ToxcastMc5Param {
    ac50?: number;
    acc?: number;
}

interface ToxcastMc6Param {
    flag?: unknown;
}

interface ToxcastBioactivityRow {
    aeid?: number;
    hitc?: number;
    maxMean?: number | null;
    modl?: string;
    mc5Param?: ToxcastMc5Param | null;
    mc6Param?: ToxcastMc6Param | null;
}

interface ToxcastAssaySummaryRow {
    aeid?: number;
    aenm?: string;
}

export function createSearchToxcastTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_toxcast",
        description:
            "Search EPA ToxCast/Tox21 high-throughput screening data for a chemical via the CTX Bioactivity API. " +
            "Returns in-vitro bioactivity results across hundreds of assay endpoints " +
            "(nuclear receptors, stress response, mitochondrial toxicity, etc.). " +
            "Use to assess toxicological liability of compounds or drug targets. " +
            "Requires EPA_CCTE_API_KEY environment variable.",
        inputSchema: z.object({
            query: z.string().describe("Chemical identifier: DTXSID (e.g. DTXSID7020182), CASRN (e.g. 80-05-7), " + "or chemical name (e.g. bisphenol A)"),
            activeOnly: z.boolean().default(true).describe("Return only active (hit) assays. Set false for all tested assays."),
            limit: z.number().int().min(1).max(200).default(50).describe("Max assay results to return (sorted by AC50 ascending for actives)"),
        }),
        execute: async ({ query, activeOnly = true, limit = 50 }): Promise<Result<ToxcastOutput, ToolError>> => {
            const headers = getEpaCcteHeaders(deps.apiKey);
            const resolved = await resolveDtxsid(query, headers);
            // "No chemical found" is an expected outcome — a data variant, not an error.
            if (!resolved) return ok({ found: false as const, query });

            const { dtxsid, preferredName, casrn } = resolved;

            const aeidMap = await fetchAssayNames(dtxsid, headers);

            const bioUrl = `${EPA_CCTE_BASE}/bioactivity/data/search/by-dtxsid/${dtxsid}`;
            const bioRes = await apiFetch<ToxcastBioactivityRow[]>(bioUrl, { headers });
            if (bioRes.isErr()) throw new Error(describeApiError(bioRes.error));

            const allResults = bioRes.value ?? [];
            const totalAssays = allResults.length;
            const activeAssays = allResults.filter((r) => r.hitc === 1).length;

            const filtered = activeOnly ? allResults.filter((r) => r.hitc === 1) : allResults;

            filtered.sort((a, b) => extractAc50(a) - extractAc50(b));

            const results = filtered.slice(0, limit).map((r) => {
                const aeid = r.aeid ?? 0;
                const mc6: ToxcastMc6Param = r.mc6Param ?? {};
                const flags: string[] = Array.isArray(mc6.flag) ? mc6.flag : [];

                return {
                    aeid,
                    assayEndpoint: aeidMap.get(aeid) ?? `aeid:${aeid}`,
                    ac50: extractAc50Raw(r),
                    hitCall: r.hitc ?? 0,
                    maxMean: r.maxMean ?? null,
                    model: r.modl ?? "",
                    flags,
                };
            });

            return ok({
                found: true as const,
                chemical: {
                    dtxsid,
                    preferredName,
                    casrn,
                    totalAssays,
                    activeAssays,
                    activeHitRate: totalAssays > 0 ? Math.round((activeAssays / totalAssays) * 1000) / 1000 : 0,
                    results,
                },
            });
        },
    });
}

function extractAc50(r: ToxcastBioactivityRow): number {
    return extractAc50Raw(r) ?? Infinity;
}

function extractAc50Raw(r: ToxcastBioactivityRow): number | null {
    const mc5 = r.mc5Param;
    if (mc5 && typeof mc5 === "object") {
        if (typeof mc5.ac50 === "number") return mc5.ac50;
        if (typeof mc5.acc === "number") return mc5.acc;
    }
    return null;
}

async function resolveDtxsid(query: string, headers: Record<string, string>): Promise<{ dtxsid: string; preferredName: string; casrn: string | null } | null> {
    if (query.startsWith("DTXSID")) {
        return { dtxsid: query, preferredName: query, casrn: null };
    }

    const searchUrl = `${EPA_CCTE_BASE}/chemical/search/equal/${encodeURIComponent(query)}`;
    const searchRes = await apiFetch<CtxChemicalSearchRow[]>(searchUrl, { headers });
    if (searchRes.isErr()) throw new Error(describeApiError(searchRes.error));
    if (!searchRes.value?.length) return null;

    const chem = searchRes.value[0];
    return {
        dtxsid: chem.dtxsid,
        preferredName: chem.preferredName ?? query,
        casrn: chem.casrn ?? null,
    };
}

async function fetchAssayNames(dtxsid: string, headers: Record<string, string>): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const url = `${EPA_CCTE_BASE}/bioactivity/data/summary/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetch<ToxcastAssaySummaryRow[]>(url, { headers });
    if (res.isOk() && Array.isArray(res.value)) {
        for (const s of res.value) {
            if (s.aeid != null && s.aenm) {
                map.set(s.aeid, s.aenm);
            }
        }
    }
    return map;
}
