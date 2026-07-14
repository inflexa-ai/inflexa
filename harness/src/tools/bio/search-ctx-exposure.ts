/**
 * searchCtxExposure — look up chemical exposure data from EPA's CTX
 * Exposure APIs.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { EPA_CCTE_BASE, getEpaCcteHeaders } from "../lib/toxcast-config.js";

interface SeemPrediction {
    dtxsid: string;
    productionVolume: number | null;
    units: string;
    probabilityDietary: number | null;
    probabilityResidential: number | null;
    probabilityPesticide: number | null;
    probabilityIndustrial: number | null;
}

interface HttkParameter {
    parameter: string;
    measured: number | null;
    predicted: number | null;
    units: string;
    model: string;
    species: string;
    reference: string;
}

interface FunctionalUse {
    functionCategory: string;
    reportedFunction: string;
    docTitle: string;
}

interface ProductData {
    productName: string;
    generalCategory: string;
    productFamily: string;
    productType: string;
    centralWeightFraction: number | null;
    weightFractionType: string;
}

interface ExposureOutput {
    found: true;
    dtxsid: string;
    seem?: SeemPrediction;
    httk?: HttkParameter[];
    functionalUse?: FunctionalUse[];
    productData?: ProductData[];
}

type ExposureResult = { found: false; query: string } | ExposureOutput;

// The chemical-search endpoint returns rows the code reads `[0].dtxsid` from
// after a length guard, so `dtxsid` stays required — a row missing it is a
// contract break surfaced as `invalid_response`, not a silent `undefined`.
const CtxChemicalSearchRowSchema = z.object({
    dtxsid: z.string(),
});

// SEEM exposure-prediction wire shape (endpoint returns a single object or an
// array). `probabilityPesticde` is the API's own misspelling, read as a
// fallback before the corrected `probabilityPesticide`, so both stay modeled.
const RawSeemPredictionSchema = z.object({
    dtxsid: z.string().optional(),
    productionVolume: z.number().nullable().optional(),
    units: z.string().nullable().optional(),
    probabilityDietary: z.number().nullable().optional(),
    probabilityResidential: z.number().nullable().optional(),
    probabilityPesticde: z.number().nullable().optional(),
    probabilityPesticide: z.number().nullable().optional(),
    probabilityIndustrial: z.number().nullable().optional(),
});

const RawHttkRowSchema = z.object({
    parameter: z.string().nullable().optional(),
    measured: z.number().nullable().optional(),
    predicted: z.number().nullable().optional(),
    units: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    species: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
});

const RawFunctionalUseRowSchema = z.object({
    functioncategory: z.string().nullable().optional(),
    reportedfunction: z.string().nullable().optional(),
    doctitle: z.string().nullable().optional(),
});

const RawProductDataRowSchema = z.object({
    productname: z.string().nullable().optional(),
    gencat: z.string().nullable().optional(),
    prodfam: z.string().nullable().optional(),
    prodtype: z.string().nullable().optional(),
    centralweightfraction: z.number().nullable().optional(),
    weightfractiontype: z.string().nullable().optional(),
});

export function createSearchCtxExposureTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_ctx_exposure",
        description:
            "Look up a chemical's human-exposure data in EPA's CTX Exposure APIs — the exposure half of a risk assessment, e.g. pairing a ToxCast AC50 against predicted exposure for a " +
            "bioactivity-exposure ratio, or characterizing where a chemical is actually used. " +
            "Returns, per requested dataType: SEEM predictions (production volume and per-pathway exposure probabilities — dietary, residential, pesticide, industrial; NOT a daily-intake " +
            "dose), HTTK toxicokinetic parameters, reported functional-use categories, and consumer-product composition. " +
            "Requires EPA_CCTE_API_KEY — a missing key fails the call terminally: do NOT retry, report the missing key and continue without EPA data. " +
            "found: false, or a requested section coming back absent/empty, is valid no-data — do not retry.",
        inputSchema: z.object({
            query: z
                .string()
                .describe(
                    "Chemical identifier. A DTXSID (e.g. 'DTXSID7020182') is used directly; a CASRN (e.g. '80-05-7') or chemical name (e.g. 'bisphenol A') is resolved by EXACT match.",
                ),
            dataType: z
                .enum(["seem", "httk", "functional-use", "product-data", "all"])
                .default("all")
                .describe(
                    "'seem' — SEEM exposure-pathway predictions and production volume. " +
                        "'httk' — high-throughput toxicokinetic parameters (clearance, Css, protein binding, …). " +
                        "'functional-use' — reported chemical use categories. " +
                        "'product-data' — consumer-product composition. " +
                        "'all' (default) — fetches every section concurrently.",
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(25)
                .describe(
                    "Max rows per category (default 25, max 100). Applies to functional-use and product-data only — seem and httk are always returned whole.",
                ),
        }),
        execute: async ({ query, dataType = "all", limit = 25 }): Promise<Result<ExposureResult, ToolError>> => {
            const headers = getEpaCcteHeaders(deps.apiKey);
            const resolved = await resolveDtxsid(query, headers);
            // "No chemical found" is an expected outcome — a data variant, not an error.
            if (!resolved) return ok({ found: false as const, query });

            const { dtxsid } = resolved;
            const result: ExposureOutput = { found: true, dtxsid };
            const fetchers: Promise<void>[] = [];

            if (dataType === "seem" || dataType === "all") {
                fetchers.push(
                    fetchSeem(dtxsid, headers).then((v) => {
                        result.seem = v;
                    }),
                );
            }
            if (dataType === "httk" || dataType === "all") {
                fetchers.push(
                    fetchHttk(dtxsid, headers).then((v) => {
                        result.httk = v;
                    }),
                );
            }
            if (dataType === "functional-use" || dataType === "all") {
                fetchers.push(
                    fetchFunctionalUse(dtxsid, headers, limit).then((v) => {
                        result.functionalUse = v;
                    }),
                );
            }
            if (dataType === "product-data" || dataType === "all") {
                fetchers.push(
                    fetchProductData(dtxsid, headers, limit).then((v) => {
                        result.productData = v;
                    }),
                );
            }

            await Promise.all(fetchers);
            return ok(result);
        },
    });
}

async function resolveDtxsid(query: string, headers: Record<string, string>): Promise<{ dtxsid: string } | null> {
    if (query.startsWith("DTXSID")) {
        return { dtxsid: query };
    }

    const url = `${EPA_CCTE_BASE}/chemical/search/equal/${encodeURIComponent(query)}`;
    const res = await apiFetchValidated(url, z.array(CtxChemicalSearchRowSchema), { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    if (!res.value?.length) return null;

    return { dtxsid: res.value[0].dtxsid };
}

async function fetchSeem(dtxsid: string, headers: Record<string, string>): Promise<SeemPrediction | undefined> {
    const url = `${EPA_CCTE_BASE}/exposure/seem/general/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.union([RawSeemPredictionSchema, z.array(RawSeemPredictionSchema)]), { headers });
    if (res.isErr() || !res.value) return undefined;

    const d = Array.isArray(res.value) ? res.value[0] : res.value;
    if (!d) return undefined;

    return {
        dtxsid: d.dtxsid ?? dtxsid,
        productionVolume: d.productionVolume ?? null,
        units: d.units ?? "",
        probabilityDietary: d.probabilityDietary ?? null,
        probabilityResidential: d.probabilityResidential ?? null,
        probabilityPesticide: d.probabilityPesticde ?? d.probabilityPesticide ?? null,
        probabilityIndustrial: d.probabilityIndustrial ?? null,
    };
}

async function fetchHttk(dtxsid: string, headers: Record<string, string>): Promise<HttkParameter[]> {
    const url = `${EPA_CCTE_BASE}/exposure/httk/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(RawHttkRowSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.map((r) => ({
        parameter: r.parameter ?? "",
        measured: r.measured ?? null,
        predicted: r.predicted ?? null,
        units: r.units ?? "",
        model: r.model ?? "",
        species: r.species ?? "",
        reference: r.reference ?? "",
    }));
}

async function fetchFunctionalUse(dtxsid: string, headers: Record<string, string>, limit: number): Promise<FunctionalUse[]> {
    const url = `${EPA_CCTE_BASE}/exposure/functional-use/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(RawFunctionalUseRowSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit).map((r) => ({
        functionCategory: r.functioncategory ?? "",
        reportedFunction: r.reportedfunction ?? "",
        docTitle: r.doctitle ?? "",
    }));
}

async function fetchProductData(dtxsid: string, headers: Record<string, string>, limit: number): Promise<ProductData[]> {
    const url = `${EPA_CCTE_BASE}/exposure/product-data/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(RawProductDataRowSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit).map((r) => ({
        productName: r.productname ?? "",
        generalCategory: r.gencat ?? "",
        productFamily: r.prodfam ?? "",
        productType: r.prodtype ?? "",
        centralWeightFraction: r.centralweightfraction ?? null,
        weightFractionType: r.weightfractiontype ?? "",
    }));
}
