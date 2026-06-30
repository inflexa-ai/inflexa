/**
 * searchCtxChemical — look up chemical details and physicochemical
 * properties from EPA's CompTox Chemicals Dashboard (CTX API).
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetch, describeApiError } from "../lib/api-utils.js";
import { EPA_CCTE_BASE, getEpaCcteHeaders } from "../lib/toxcast-config.js";

interface ChemicalDetail {
    dtxsid: string;
    dtxcid: string;
    casrn: string | null;
    preferredName: string;
    iupacName: string;
    molFormula: string;
    smiles: string;
    inchikey: string;
    monoisotopicMass: number | null;
    averageMass: number | null;
    qcLevel: number | null;
    totalAssays: number | null;
    activeAssays: number | null;
    percentAssays: number | null;
    pubchemCid: number | null;
    pubmedCount: number | null;
    sourcesCount: number | null;
}

interface PropertySummary {
    propName: string;
    unit: string;
    experimentalCount: number | null;
    experimentalMedian: number | null;
    experimentalMin: number | null;
    experimentalMax: number | null;
    predictedCount: number | null;
    predictedMedian: number | null;
    predictedMin: number | null;
    predictedMax: number | null;
}

type CtxChemicalOutput = { found: false; query: string } | { found: true; detail: ChemicalDetail; properties?: PropertySummary[] };

export function createSearchCtxChemicalTool(deps: { apiKey: string }) {
    return defineTool({
        id: "search_ctx_chemical",
        description:
            "Look up chemical details and physicochemical properties from EPA's CompTox Chemicals Dashboard (CTX API). " +
            "Returns chemical identifiers (DTXSID, CASRN, SMILES, InChIKey), molecular formula, mass, " +
            "and a summary of predicted and experimental properties (logP, water solubility, vapor pressure, " +
            "melting/boiling point, bioconcentration factor, Henry's law constant). " +
            "Use for ADMET property assessment, compound characterization, and safety-relevant physicochemical profiling. " +
            "Requires EPA_CCTE_API_KEY environment variable.",
        inputSchema: z.object({
            query: z
                .string()
                .describe("Chemical identifier: DTXSID (e.g. DTXSID7020182), CASRN (e.g. 80-05-7), " + "chemical name (e.g. bisphenol A), or InChIKey"),
            includeProperties: z.boolean().default(true).describe("Include predicted/experimental property summaries (logP, solubility, etc.)"),
        }),
        execute: async ({ query, includeProperties = true }): Promise<Result<CtxChemicalOutput, ToolError>> => {
            const headers = getEpaCcteHeaders(deps.apiKey);
            const resolved = await resolveDtxsid(query, headers);
            // "No chemical found" is an expected outcome — a data variant, not an error.
            if (!resolved) return ok({ found: false as const, query });

            const { dtxsid } = resolved;

            const detailUrl = `${EPA_CCTE_BASE}/chemical/detail/search/by-dtxsid/${dtxsid}?projection=chemicaldetailstandard`;
            const detailRes = await apiFetch<any>(detailUrl, { headers });
            if (detailRes.isErr()) throw new Error(describeApiError(detailRes.error));

            const d = detailRes.value ?? {};
            const detail: ChemicalDetail = {
                dtxsid: d.dtxsid ?? dtxsid,
                dtxcid: d.dtxcid ?? "",
                casrn: d.casrn ?? null,
                preferredName: d.preferredName ?? "",
                iupacName: d.iupacName ?? "",
                molFormula: d.molFormula ?? "",
                smiles: d.smiles ?? "",
                inchikey: d.inchikey ?? "",
                monoisotopicMass: d.monoisotopicMass ?? null,
                averageMass: d.averageMass ?? null,
                qcLevel: d.qcLevel ?? null,
                totalAssays: d.totalAssays ?? null,
                activeAssays: d.activeAssays ?? null,
                percentAssays: d.percentAssays ?? null,
                pubchemCid: d.pubchemCid ?? null,
                pubmedCount: d.pubmedCount ?? null,
                sourcesCount: d.sourcesCount ?? null,
            };

            const result: {
                found: true;
                detail: ChemicalDetail;
                properties?: PropertySummary[];
            } = { found: true, detail };

            if (includeProperties) {
                const propUrl = `${EPA_CCTE_BASE}/chemical/property/summary/search/by-dtxsid/${dtxsid}`;
                const propRes = await apiFetch<any[]>(propUrl, { headers });

                if (propRes.isOk() && Array.isArray(propRes.value)) {
                    result.properties = propRes.value.map((p: any) => ({
                        propName: p.propName ?? "",
                        unit: p.unit ?? "",
                        experimentalCount: p.experimentalCount ?? null,
                        experimentalMedian: p.experimentalMedian ?? null,
                        experimentalMin: p.experimentalMin ?? null,
                        experimentalMax: p.experimentalMax ?? null,
                        predictedCount: p.predictedCount ?? null,
                        predictedMedian: p.predictedMedian ?? null,
                        predictedMin: p.predictedMin ?? null,
                        predictedMax: p.predictedMax ?? null,
                    }));
                }
            }

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
