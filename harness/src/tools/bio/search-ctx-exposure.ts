/**
 * searchCtxExposure — look up chemical exposure data from EPA's CTX
 * Exposure APIs.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
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

export function createSearchCtxExposureTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_ctx_exposure",
        description:
            "Look up chemical exposure data from EPA's CTX Exposure APIs. Returns: " +
            "SEEM general exposure predictions (estimated daily intake, exposure pathway probabilities), " +
            "HTTK toxicokinetic parameters (Css, clearance, volume of distribution, protein binding), " +
            "functional use categories, and product composition data. " +
            "Use for exposure-based safety margin calculations (comparing ToxCast bioactivity AC50 " +
            "against predicted human exposure), IVIVE context, and exposure pathway characterization. " +
            "Requires EPA_CCTE_API_KEY environment variable.",
        inputSchema: z.object({
            query: z.string().describe("Chemical identifier: DTXSID (e.g. DTXSID7020182), CASRN (e.g. 80-05-7), " + "or chemical name (e.g. bisphenol A)"),
            dataType: z
                .enum(["seem", "httk", "functional-use", "product-data", "all"])
                .default("all")
                .describe(
                    "'seem' for SEEM exposure predictions, " +
                        "'httk' for toxicokinetic parameters, " +
                        "'functional-use' for chemical use categories, " +
                        "'product-data' for consumer product composition, " +
                        "'all' for combined results",
                ),
            limit: z.number().int().min(1).max(100).default(25).describe("Max results per category (for functional-use and product-data)"),
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
    const res = await apiFetch<any[]>(url, { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    if (!res.value?.length) return null;

    return { dtxsid: res.value[0].dtxsid };
}

async function fetchSeem(dtxsid: string, headers: Record<string, string>): Promise<SeemPrediction | undefined> {
    const url = `${EPA_CCTE_BASE}/exposure/seem/general/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetch<any>(url, { headers });
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
    const res = await apiFetch<any[]>(url, { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.map((r: any) => ({
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
    const res = await apiFetch<any[]>(url, { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit).map((r: any) => ({
        functionCategory: r.functioncategory ?? "",
        reportedFunction: r.reportedfunction ?? "",
        docTitle: r.doctitle ?? "",
    }));
}

async function fetchProductData(dtxsid: string, headers: Record<string, string>, limit: number): Promise<ProductData[]> {
    const url = `${EPA_CCTE_BASE}/exposure/product-data/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetch<any[]>(url, { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit).map((r: any) => ({
        productName: r.productname ?? "",
        generalCategory: r.gencat ?? "",
        productFamily: r.prodfam ?? "",
        productType: r.prodtype ?? "",
        centralWeightFraction: r.centralweightfraction ?? null,
        weightFractionType: r.weightfractiontype ?? "",
    }));
}
