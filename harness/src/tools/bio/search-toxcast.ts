/**
 * searchToxcast — search EPA ToxCast/Tox21 high-throughput screening data
 * for a chemical via the CTX Bioactivity API.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
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

// Raw CTX Bioactivity API wire shapes, validated at the fetch boundary. Fields
// are optional because the API omits absent values; `dtxsid` stays required
// because `resolveDtxsid` reads it without a guard, so a row missing it is a
// contract break surfaced as `invalid_response` rather than a runtime error.
// The row-shaping/filtering logic in `execute` stays put — it depends on the
// resolved chemical, the assay-name map, and the `activeOnly`/`limit` inputs.
const CtxChemicalSearchRowSchema = z.object({
    dtxsid: z.string(),
    preferredName: z.string().optional(),
    casrn: z.string().nullable().optional(),
});

const ToxcastMc5ParamSchema = z.object({
    ac50: z.number().optional(),
    acc: z.number().optional(),
});

const ToxcastMc6ParamSchema = z.object({
    flag: z.unknown().optional(),
});
type ToxcastMc6Param = z.infer<typeof ToxcastMc6ParamSchema>;

const ToxcastBioactivityRowSchema = z.object({
    aeid: z.number().optional(),
    hitc: z.number().optional(),
    maxMean: z.number().nullable().optional(),
    modl: z.string().optional(),
    mc5Param: ToxcastMc5ParamSchema.nullable().optional(),
    mc6Param: ToxcastMc6ParamSchema.nullable().optional(),
});
type ToxcastBioactivityRow = z.infer<typeof ToxcastBioactivityRowSchema>;

const ToxcastAssaySummaryRowSchema = z.object({
    aeid: z.number().optional(),
    aenm: z.string().optional(),
});

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
            const bioRes = await apiFetchValidated(bioUrl, z.array(ToxcastBioactivityRowSchema), { headers });
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
    const searchRes = await apiFetchValidated(searchUrl, z.array(CtxChemicalSearchRowSchema), { headers });
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
    const res = await apiFetchValidated(url, z.array(ToxcastAssaySummaryRowSchema), { headers });
    if (res.isOk() && Array.isArray(res.value)) {
        for (const s of res.value) {
            if (s.aeid != null && s.aenm) {
                map.set(s.aeid, s.aenm);
            }
        }
    }
    return map;
}
