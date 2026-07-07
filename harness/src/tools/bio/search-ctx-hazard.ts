/**
 * searchCtxHazard — search EPA CTX Hazard APIs (ToxValDB, ToxRefDB) for
 * toxicological hazard data on a chemical.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { EPA_CCTE_BASE, getEpaCcteHeaders } from "../lib/toxcast-config.js";

interface ToxValEntry {
    source: string;
    toxvalType: string;
    toxvalNumeric: number | null;
    toxvalUnits: string;
    studyType: string;
    studyDurationClass: string;
    species: string;
    exposureRoute: string;
    toxicologicalEffect: string;
    riskAssessmentClass: string;
    humanEco: string;
    year: number | null;
    quality: string;
}

interface GenetoxSummary {
    source: string;
    assayCategory: string;
    assayType: string;
    metabolicActivation: string;
    species: string;
    overallResult: string;
    year: number | null;
}

interface CancerSummary {
    source: string;
    classification: string;
    url: string;
}

interface CtxHazardOutput {
    found: true;
    dtxsid: string;
    preferredName: string;
    toxval?: ToxValEntry[];
    genetox?: GenetoxSummary[];
    cancer?: CancerSummary[];
}

type CtxHazardResult = { found: false; query: string } | CtxHazardOutput;

interface CtxChemicalSearchRow {
    dtxsid: string;
    preferredName?: string;
}

interface RawToxValRow {
    source?: string;
    toxvalType?: string;
    toxvalNumeric?: unknown;
    toxvalUnits?: string;
    studyType?: string;
    studyDurationClass?: string;
    speciesCommon?: string;
    exposureRoute?: string;
    toxicologicalEffect?: string;
    riskAssessmentClass?: string;
    humanEco?: string;
    year?: unknown;
    quality?: string;
}

interface RawGenetoxRow {
    source?: string;
    assayCategory?: string;
    assayType?: string;
    metabolicActivation?: string;
    species?: string;
    overallResult?: string;
    year?: unknown;
}

interface RawCancerRow {
    source?: string;
    classification?: string;
    cancerClassification?: string;
    url?: string;
}

export function createSearchCtxHazardTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_ctx_hazard",
        description:
            "Search EPA CTX Hazard APIs (ToxValDB, ToxRefDB) for toxicological hazard data on a chemical. " +
            "Returns in-vivo toxicity values (NOAELs, LOAELs, LD50s, BMDs), " +
            "genetox summaries, and cancer classifications. " +
            "Use to assess toxicological hazard profile for safety evaluation. " +
            "Requires EPA_CCTE_API_KEY environment variable.",
        inputSchema: z.object({
            query: z.string().describe("Chemical identifier: DTXSID (e.g. DTXSID7020182), CASRN (e.g. 80-05-7), " + "or chemical name (e.g. bisphenol A)"),
            dataType: z
                .enum(["toxval", "genetox", "cancer", "all"])
                .default("all")
                .describe(
                    "'toxval' for ToxValDB dose-response data (NOAELs, LOAELs, LD50s), " +
                        "'genetox' for genotoxicity summaries, " +
                        "'cancer' for cancer classifications, " +
                        "'all' for combined results",
                ),
            limit: z.number().int().min(1).max(100).default(30).describe("Max results per category"),
        }),
        execute: async ({ query, dataType = "all", limit = 30 }): Promise<Result<CtxHazardResult, ToolError>> => {
            const headers = getEpaCcteHeaders(deps.apiKey);
            const resolved = await resolveDtxsid(query, headers);
            // "No chemical found" is an expected outcome — a data variant, not an error.
            if (!resolved) return ok({ found: false as const, query });

            const { dtxsid, preferredName } = resolved;
            const result: CtxHazardOutput = {
                found: true,
                dtxsid,
                preferredName,
            };

            const fetchers: Promise<void>[] = [];

            if (dataType === "toxval" || dataType === "all") {
                fetchers.push(
                    fetchToxval(dtxsid, headers, limit).then((v) => {
                        result.toxval = v;
                    }),
                );
            }
            if (dataType === "genetox" || dataType === "all") {
                fetchers.push(
                    fetchGenetox(dtxsid, headers, limit).then((v) => {
                        result.genetox = v;
                    }),
                );
            }
            if (dataType === "cancer" || dataType === "all") {
                fetchers.push(
                    fetchCancer(dtxsid, headers).then((v) => {
                        result.cancer = v;
                    }),
                );
            }

            await Promise.all(fetchers);

            return ok(result);
        },
    });
}

async function resolveDtxsid(query: string, headers: Record<string, string>): Promise<{ dtxsid: string; preferredName: string } | null> {
    if (query.startsWith("DTXSID")) {
        return { dtxsid: query, preferredName: query };
    }

    const url = `${EPA_CCTE_BASE}/chemical/search/equal/${encodeURIComponent(query)}`;
    const res = await apiFetch<CtxChemicalSearchRow[]>(url, { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    if (!res.value?.length) return null;

    const chem = res.value[0];
    return {
        dtxsid: chem.dtxsid,
        preferredName: chem.preferredName ?? query,
    };
}

async function fetchToxval(dtxsid: string, headers: Record<string, string>, limit: number): Promise<ToxValEntry[]> {
    const url = `${EPA_CCTE_BASE}/hazard/toxval/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetch<RawToxValRow[]>(url, { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit).map((r) => ({
        source: r.source ?? "",
        toxvalType: r.toxvalType ?? "",
        toxvalNumeric: toNumberOrNull(r.toxvalNumeric),
        toxvalUnits: r.toxvalUnits ?? "",
        studyType: r.studyType ?? "",
        studyDurationClass: r.studyDurationClass ?? "",
        species: r.speciesCommon ?? "",
        exposureRoute: r.exposureRoute ?? "",
        toxicologicalEffect: r.toxicologicalEffect ?? "",
        riskAssessmentClass: r.riskAssessmentClass ?? "",
        humanEco: r.humanEco ?? "",
        year: toNumberOrNull(r.year),
        quality: r.quality ?? "",
    }));
}

function toNumberOrNull(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

async function fetchGenetox(dtxsid: string, headers: Record<string, string>, limit: number): Promise<GenetoxSummary[]> {
    const url = `${EPA_CCTE_BASE}/hazard/genetox/summary/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetch<RawGenetoxRow[]>(url, { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit).map((r) => ({
        source: r.source ?? "",
        assayCategory: r.assayCategory ?? "",
        assayType: r.assayType ?? "",
        metabolicActivation: r.metabolicActivation ?? "",
        species: r.species ?? "",
        overallResult: r.overallResult ?? "",
        year: toNumberOrNull(r.year),
    }));
}

async function fetchCancer(dtxsid: string, headers: Record<string, string>): Promise<CancerSummary[]> {
    const url = `${EPA_CCTE_BASE}/hazard/cancer-summary/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetch<RawCancerRow[]>(url, { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.map((r) => ({
        source: r.source ?? "",
        classification: r.classification ?? r.cancerClassification ?? "",
        url: r.url ?? "",
    }));
}
