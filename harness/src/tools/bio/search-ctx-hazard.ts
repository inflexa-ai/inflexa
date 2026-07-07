/**
 * searchCtxHazard — search EPA CTX Hazard APIs (ToxValDB, ToxRefDB) for
 * toxicological hazard data on a chemical.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { EPA_CCTE_BASE, getEpaCcteHeaders } from "../lib/toxcast-config.js";

// Each schema below both validates one raw CTX hazard row and normalizes it
// into the curated output shape via `.transform`; `z.infer` is that output
// type. Every wire field is optional (the API omits absent values); the two
// numeric fields the API sends as string-or-number stay `z.unknown()` so
// `toNumberOrNull` can coerce them without the schema rejecting the row.
const ToxValSchema = z
    .object({
        source: z.string().optional(),
        toxvalType: z.string().optional(),
        toxvalNumeric: z.unknown().optional(),
        toxvalUnits: z.string().optional(),
        studyType: z.string().optional(),
        studyDurationClass: z.string().optional(),
        speciesCommon: z.string().optional(),
        exposureRoute: z.string().optional(),
        toxicologicalEffect: z.string().optional(),
        riskAssessmentClass: z.string().optional(),
        humanEco: z.string().optional(),
        year: z.unknown().optional(),
        quality: z.string().optional(),
    })
    .transform((r) => ({
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
type ToxValEntry = z.infer<typeof ToxValSchema>;

const GenetoxSchema = z
    .object({
        source: z.string().optional(),
        assayCategory: z.string().optional(),
        assayType: z.string().optional(),
        metabolicActivation: z.string().optional(),
        species: z.string().optional(),
        overallResult: z.string().optional(),
        year: z.unknown().optional(),
    })
    .transform((r) => ({
        source: r.source ?? "",
        assayCategory: r.assayCategory ?? "",
        assayType: r.assayType ?? "",
        metabolicActivation: r.metabolicActivation ?? "",
        species: r.species ?? "",
        overallResult: r.overallResult ?? "",
        year: toNumberOrNull(r.year),
    }));
type GenetoxSummary = z.infer<typeof GenetoxSchema>;

const CancerSchema = z
    .object({
        source: z.string().optional(),
        classification: z.string().optional(),
        cancerClassification: z.string().optional(),
        url: z.string().optional(),
    })
    .transform((r) => ({
        source: r.source ?? "",
        classification: r.classification ?? r.cancerClassification ?? "",
        url: r.url ?? "",
    }));
type CancerSummary = z.infer<typeof CancerSchema>;

interface CtxHazardOutput {
    found: true;
    dtxsid: string;
    preferredName: string;
    toxval?: ToxValEntry[];
    genetox?: GenetoxSummary[];
    cancer?: CancerSummary[];
}

type CtxHazardResult = { found: false; query: string } | CtxHazardOutput;

// The chemical-search endpoint returns rows the code reads `dtxsid` from
// unguarded, so `dtxsid` stays required — a row missing it is a contract break
// surfaced as `invalid_response`, not a silent `undefined`.
const CtxChemicalSearchRowSchema = z.object({
    dtxsid: z.string(),
    preferredName: z.string().optional(),
});

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
    const res = await apiFetchValidated(url, z.array(CtxChemicalSearchRowSchema), { headers });
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
    const res = await apiFetchValidated(url, z.array(ToxValSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit);
}

function toNumberOrNull(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

async function fetchGenetox(dtxsid: string, headers: Record<string, string>, limit: number): Promise<GenetoxSummary[]> {
    const url = `${EPA_CCTE_BASE}/hazard/genetox/summary/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(GenetoxSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit);
}

async function fetchCancer(dtxsid: string, headers: Record<string, string>): Promise<CancerSummary[]> {
    const url = `${EPA_CCTE_BASE}/hazard/cancer-summary/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(CancerSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value;
}
