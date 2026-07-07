/**
 * searchCtxChemical — look up chemical details and physicochemical
 * properties from EPA's CompTox Chemicals Dashboard (CTX API).
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
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

// The chemical-search endpoint returns rows the code reads `[0].dtxsid` from
// after a length guard, so `dtxsid` stays required — a row missing it is a
// contract break surfaced as `invalid_response`, not a silent `undefined`.
const CtxChemicalSearchRowSchema = z.object({
    dtxsid: z.string(),
});

// Raw CTX chemical-detail wire shape, validated at the fetch boundary. Every
// field is optional (the API omits absent values); the mapper below normalizes
// it into `ChemicalDetail`, folding in the resolved `dtxsid` fallback.
const RawChemicalDetailSchema = z.object({
    dtxsid: z.string().optional(),
    dtxcid: z.string().nullable().optional(),
    casrn: z.string().nullable().optional(),
    preferredName: z.string().nullable().optional(),
    iupacName: z.string().nullable().optional(),
    molFormula: z.string().nullable().optional(),
    smiles: z.string().nullable().optional(),
    inchikey: z.string().nullable().optional(),
    monoisotopicMass: z.number().nullable().optional(),
    averageMass: z.number().nullable().optional(),
    qcLevel: z.number().nullable().optional(),
    totalAssays: z.number().nullable().optional(),
    activeAssays: z.number().nullable().optional(),
    percentAssays: z.number().nullable().optional(),
    pubchemCid: z.number().nullable().optional(),
    pubmedCount: z.number().nullable().optional(),
    sourcesCount: z.number().nullable().optional(),
});
type RawChemicalDetail = z.infer<typeof RawChemicalDetailSchema>;

const RawPropertySummarySchema = z.object({
    propName: z.string().nullable().optional(),
    unit: z.string().nullable().optional(),
    experimentalCount: z.number().nullable().optional(),
    experimentalMedian: z.number().nullable().optional(),
    experimentalMin: z.number().nullable().optional(),
    experimentalMax: z.number().nullable().optional(),
    predictedCount: z.number().nullable().optional(),
    predictedMedian: z.number().nullable().optional(),
    predictedMin: z.number().nullable().optional(),
    predictedMax: z.number().nullable().optional(),
});

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
            const detailRes = await apiFetchValidated(detailUrl, RawChemicalDetailSchema, { headers });
            if (detailRes.isErr()) throw new Error(describeApiError(detailRes.error));

            const d: RawChemicalDetail = detailRes.value ?? {};
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
                const propRes = await apiFetchValidated(propUrl, z.array(RawPropertySummarySchema), { headers });

                if (propRes.isOk() && Array.isArray(propRes.value)) {
                    result.properties = propRes.value.map((p) => ({
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
    const res = await apiFetchValidated(url, z.array(CtxChemicalSearchRowSchema), { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    if (!res.value?.length) return null;

    return { dtxsid: res.value[0].dtxsid };
}
