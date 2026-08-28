/**
 * EPA CompTox (CTX) operations — the four datasets the CompTox tools expose:
 * ToxCast/Tox21 bioactivity, hazard (ToxValDB/ToxRefDB), chemical identity +
 * physicochemical properties, and exposure.
 *
 * Every dataset keys off a DTXSID, so `resolveDtxsid` is the single entry
 * point they share: a DTXSID is used directly, anything else is resolved by
 * exact match against the chemical-search endpoint. `null` means the query
 * resolved to no chemical — an expected outcome, not an error.
 *
 * UNVERIFIED CONTRACT, 2026-08-28. Every data path of the CTX API demands
 * `EPA_CCTE_API_KEY`, and no key exists, thus no schema here parsed a live
 * answer. The contract comes from three secondary sources: the server source of
 * the EPA (`github.com/USEPA/ccte-api-{chemical,hazard,exposure,bioactivity}`,
 * branch `dev`), the contract tests of the EPA (`USEPA/ccte-api-karate`), and
 * the response bodies that the R client of the EPA (`ctxR` 1.1.3) recorded
 * against this same base. A Java `List<T>` return type serializes to a JSON
 * array, thus the server source settles each container shape.
 *
 * Absence policy: the CTX API sends an explicit `null` for an absent value, and
 * it omits a key that its projection excludes. Thus a field carries both
 * `.nullable()` and `.optional()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, zWireNumber, type ApiError } from "./api-utils.js";
import { EPA_CCTE_BASE } from "./toxcast-config.js";

export interface CtxResolved {
    dtxsid: string;
    preferredName: string;
    casrn: string | null;
}

// A row of the chemical-search endpoint. `dtxsid` is nullable, because a search
// that matches a DTXCID or a Markush record answers with a row that carries no
// substance identifier. The caller drops such a row.
export const CtxChemicalSearchRowSchema = z.object({
    dtxsid: z.string().nullable().optional(),
    preferredName: z.string().nullable().optional(),
    casrn: z.string().nullable().optional(),
});

/**
 * Is the error the RFC 7807 answer of a search that matched nothing?
 *
 * The chemical-search endpoint never answers with an empty array. It answers
 * HTTP 400 with a `ProblemDetail` body that carries `title`, `detail`, and a
 * `suggestions` list. Thus that one 400 is the no-match outcome, and every other
 * 4xx stays a failure.
 */
function isNoMatchProblemDetail(error: ApiError): boolean {
    if (error.type !== "http_status" || error.status !== 400) return false;
    try {
        const body: unknown = JSON.parse(error.body);
        // `suggestions` separates the no-match answer from a generic 400
        // `ProblemDetail`, which carries `title` and `detail` alone. Without it,
        // a malformed request reads as a clean no-match.
        return typeof body === "object" && body !== null && "detail" in body && "title" in body && "suggestions" in body;
    } catch {
        return false;
    }
}

/** Resolve a DTXSID / CASRN / name to a chemical. `null` = no match (valid no-data). */
export async function resolveDtxsid(query: string, headers: Record<string, string>): Promise<CtxResolved | null> {
    if (query.startsWith("DTXSID")) {
        return { dtxsid: query, preferredName: query, casrn: null };
    }

    const url = `${EPA_CCTE_BASE}/chemical/search/equal/${encodeURIComponent(query)}`;
    const res = await apiFetchValidated(url, z.array(CtxChemicalSearchRowSchema), { headers });
    if (res.isErr()) {
        if (isNoMatchProblemDetail(res.error)) return null;
        throw new Error(describeApiError(res.error));
    }

    const chem = (res.value ?? []).find((row) => row.dtxsid);
    if (!chem?.dtxsid) return null;
    return {
        dtxsid: chem.dtxsid,
        preferredName: chem.preferredName ?? query,
        casrn: chem.casrn ?? null,
    };
}

/* ---------------------------------- toxcast --------------------------------- */

export interface ToxcastAssayResult {
    aeid: number;
    assayEndpoint: string;
    ac50: number | null;
    hitCall: number;
    maxMean: number | null;
    model: string;
    flags: string[];
}

export interface ToxcastBioactivity {
    totalAssays: number;
    activeAssays: number;
    activeHitRate: number;
    results: ToxcastAssayResult[];
}

// Raw CTX Bioactivity API wire shapes, validated at the fetch boundary. Fields
// are optional because the API omits absent values.
const ToxcastMc5ParamSchema = z.object({
    ac50: z.number().optional(),
    acc: z.number().optional(),
});

const ToxcastMc6ParamSchema = z.object({
    flag: z.unknown().optional(),
});
type ToxcastMc6Param = z.infer<typeof ToxcastMc6ParamSchema>;

export const ToxcastBioactivityRowSchema = z.object({
    aeid: z.number().optional(),
    hitc: z.number().optional(),
    maxMean: z.number().nullable().optional(),
    modl: z.string().optional(),
    mc5Param: ToxcastMc5ParamSchema.nullable().optional(),
    mc6Param: ToxcastMc6ParamSchema.nullable().optional(),
});
type ToxcastBioactivityRow = z.infer<typeof ToxcastBioactivityRowSchema>;

/** One assay annotation of `bioactivity/assay/search/by-aeid/`. */
const ToxcastAssayAnnotationSchema = z.object({
    aeid: z.number().optional(),
    assayComponentEndpointName: z.string().nullable().optional(),
});

/**
 * The `hitc` of invitrodb v4 is a continuous value from 0 to 1, not a flag. The
 * EPA calls a value of 0.9 or more active, thus the threshold is the predicate
 * and an equality against 1 counts almost nothing.
 */
const ACTIVE_HIT_CALL = 0.9;

function isActive(row: ToxcastBioactivityRow): boolean {
    return (row.hitc ?? 0) >= ACTIVE_HIT_CALL;
}

/**
 * ToxCast/Tox21 assay results for a chemical, sorted by AC50 ascending.
 * `totalAssays` / `activeAssays` / `activeHitRate` always describe the full
 * tested panel, never the returned slice.
 */
export async function fetchToxcastBioactivity(
    dtxsid: string,
    headers: Record<string, string>,
    opts: { activeOnly: boolean; limit: number },
): Promise<ToxcastBioactivity> {
    const bioUrl = `${EPA_CCTE_BASE}/bioactivity/data/search/by-dtxsid/${dtxsid}`;
    const bioRes = await apiFetchValidated(bioUrl, z.array(ToxcastBioactivityRowSchema), { headers });
    if (bioRes.isErr()) throw new Error(describeApiError(bioRes.error));

    const allResults = bioRes.value ?? [];
    const totalAssays = allResults.length;
    const activeAssays = allResults.filter(isActive).length;

    const filtered = opts.activeOnly ? allResults.filter(isActive) : allResults;

    filtered.sort((a, b) => extractAc50(a) - extractAc50(b));

    const page = filtered.slice(0, opts.limit);
    // The names come after the slice, thus one batch call covers the rows that
    // the caller sees and never the whole tested panel.
    const aeidMap = await fetchAssayNames(page, headers);

    const results = page.map((r) => {
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

    return {
        totalAssays,
        activeAssays,
        activeHitRate: totalAssays > 0 ? Math.round((activeAssays / totalAssays) * 1000) / 1000 : 0,
        results,
    };
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

/**
 * The endpoint name of each assay of a result page, keyed by its aeid.
 *
 * The per-chemical summary endpoint serves a `ChemicalAgg` roll-up, which
 * carries no assay identifier and no assay name. The names live on the assay
 * resource, and its batch route takes the whole aeid list in one POST body.
 * Thus a page of results costs one request, not one for each row.
 *
 * A failure gives an empty map, and the caller then labels a row `aeid:N`.
 */
async function fetchAssayNames(rows: readonly ToxcastBioactivityRow[], headers: Record<string, string>): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const aeids = [...new Set(rows.map((r) => r.aeid).filter((aeid): aeid is number => aeid != null))];
    if (aeids.length === 0) return map;

    const url = `${EPA_CCTE_BASE}/bioactivity/assay/search/by-aeid/`;
    const res = await apiFetchValidated(url, z.array(ToxcastAssayAnnotationSchema), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(aeids.map((aeid) => String(aeid))),
    });
    if (res.isOk() && Array.isArray(res.value)) {
        for (const assay of res.value) {
            if (assay.aeid != null && assay.assayComponentEndpointName) {
                map.set(assay.aeid, assay.assayComponentEndpointName);
            }
        }
    }
    return map;
}

/* ---------------------------------- hazard ---------------------------------- */

// Each schema below both validates one raw CTX hazard row and normalizes it
// into the curated output shape via `.transform`; `z.infer` is that output
// type. Every wire field is optional (the API omits absent values); the two
// numeric fields the API sends as string-or-number ride `zWireNumber`.
export const ToxValSchema = z
    .object({
        source: z.string().nullable().optional(),
        toxvalType: z.string().nullable().optional(),
        toxvalNumeric: zWireNumber.nullable().optional(),
        toxvalUnits: z.string().nullable().optional(),
        studyType: z.string().nullable().optional(),
        studyDurationClass: z.string().nullable().optional(),
        speciesCommon: z.string().nullable().optional(),
        exposureRoute: z.string().nullable().optional(),
        toxicologicalEffect: z.string().nullable().optional(),
        riskAssessmentClass: z.string().nullable().optional(),
        humanEco: z.string().nullable().optional(),
        year: zWireNumber.nullable().optional(),
        quality: z.string().nullable().optional(),
    })
    .transform((r) => ({
        source: r.source ?? "",
        toxvalType: r.toxvalType ?? "",
        toxvalNumeric: r.toxvalNumeric ?? null,
        toxvalUnits: r.toxvalUnits ?? "",
        studyType: r.studyType ?? "",
        studyDurationClass: r.studyDurationClass ?? "",
        species: r.speciesCommon ?? "",
        exposureRoute: r.exposureRoute ?? "",
        toxicologicalEffect: r.toxicologicalEffect ?? "",
        riskAssessmentClass: r.riskAssessmentClass ?? "",
        humanEco: r.humanEco ?? "",
        year: r.year ?? null,
        quality: r.quality ?? "",
    }));
export type ToxValEntry = z.infer<typeof ToxValSchema>;

// The genotoxicity SUMMARY record. It is a roll-up over the genotoxicity
// reports of a chemical: the two headline assay calls, the overall call, and
// the report counts behind them. The per-report fields (the assay category, the
// metabolic activation, the species) belong to the `genetox/details` endpoint,
// which this client does not call.
export const GenetoxSchema = z
    .object({
        ames: z.string().nullable().optional(),
        genetoxCall: z.string().nullable().optional(),
        micronucleus: z.string().nullable().optional(),
        reportsPositive: z.number().nullable().optional(),
        reportsNegative: z.number().nullable().optional(),
        reportsOther: z.number().nullable().optional(),
        clowderDocId: z.string().nullable().optional(),
    })
    .transform((r) => ({
        ames: r.ames ?? "",
        genetoxCall: r.genetoxCall ?? "",
        micronucleus: r.micronucleus ?? "",
        reportsPositive: r.reportsPositive ?? null,
        reportsNegative: r.reportsNegative ?? null,
        reportsOther: r.reportsOther ?? null,
        clowderDocId: r.clowderDocId ?? "",
    }));
export type GenetoxSummary = z.infer<typeof GenetoxSchema>;

// The cancer SUMMARY record. `cancerCall` is the weight-of-evidence annotation,
// and `exposureRoute` is the route that the annotation applies to.
export const CancerSchema = z
    .object({
        source: z.string().nullable().optional(),
        exposureRoute: z.string().nullable().optional(),
        cancerCall: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
    })
    .transform((r) => ({
        source: r.source ?? "",
        exposureRoute: r.exposureRoute ?? "",
        cancerCall: r.cancerCall ?? "",
        url: r.url ?? "",
    }));
export type CancerSummary = z.infer<typeof CancerSchema>;

export type CtxHazardDataType = "toxval" | "genetox" | "cancer" | "all";

export interface CtxHazardData {
    toxval?: ToxValEntry[];
    genetox?: GenetoxSummary[];
    cancer?: CancerSummary[];
}

/**
 * In-vivo hazard data for a chemical. `limit` caps toxval and genetox only —
 * cancer classifications always come back whole.
 */
export async function fetchCtxHazardData(
    dtxsid: string,
    headers: Record<string, string>,
    opts: { dataType: CtxHazardDataType; limit: number },
): Promise<CtxHazardData> {
    const { dataType, limit } = opts;
    const data: CtxHazardData = {};
    const fetchers: Promise<void>[] = [];

    if (dataType === "toxval" || dataType === "all") {
        fetchers.push(
            fetchToxval(dtxsid, headers, limit).then((v) => {
                data.toxval = v;
            }),
        );
    }
    if (dataType === "genetox" || dataType === "all") {
        fetchers.push(
            fetchGenetox(dtxsid, headers, limit).then((v) => {
                data.genetox = v;
            }),
        );
    }
    if (dataType === "cancer" || dataType === "all") {
        fetchers.push(
            fetchCancer(dtxsid, headers).then((v) => {
                data.cancer = v;
            }),
        );
    }

    await Promise.all(fetchers);
    return data;
}

async function fetchToxval(dtxsid: string, headers: Record<string, string>, limit: number): Promise<ToxValEntry[]> {
    const url = `${EPA_CCTE_BASE}/hazard/toxval/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(ToxValSchema), { headers });
    if (res.isErr() || !Array.isArray(res.value)) return [];

    return res.value.slice(0, limit);
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

/* --------------------------------- chemical --------------------------------- */

export interface ChemicalDetail {
    dtxsid: string;
    dtxcid: string;
    casrn: string | null;
    preferredName: string;
    iupacName: string;
    molFormula: string;
    smiles: string;
    inchikey: string;
    monoisotopicMass: number | null;
    qcLevel: number | null;
    totalAssays: number | null;
    activeAssays: number | null;
    percentAssays: number | null;
    pubchemCid: number | null;
    pubmedCount: number | null;
    sourcesCount: number | null;
}

export interface PropertySummary {
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

// Raw CTX chemical-detail wire shape, validated at the fetch boundary. Every
// field is optional (the API omits absent values); the mapper below normalizes
// it into `ChemicalDetail`, folding in the resolved `dtxsid` fallback.
export const RawChemicalDetailSchema = z.object({
    dtxsid: z.string().optional(),
    dtxcid: z.string().nullable().optional(),
    casrn: z.string().nullable().optional(),
    preferredName: z.string().nullable().optional(),
    iupacName: z.string().nullable().optional(),
    molFormula: z.string().nullable().optional(),
    smiles: z.string().nullable().optional(),
    inchikey: z.string().nullable().optional(),
    monoisotopicMass: z.number().nullable().optional(),
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

/** Chemical identity, mass, and dashboard counts for a DTXSID. */
export async function fetchCtxChemicalDetail(dtxsid: string, headers: Record<string, string>): Promise<ChemicalDetail> {
    const detailUrl = `${EPA_CCTE_BASE}/chemical/detail/search/by-dtxsid/${dtxsid}?projection=chemicaldetailstandard`;
    const detailRes = await apiFetchValidated(detailUrl, RawChemicalDetailSchema, { headers });
    if (detailRes.isErr()) throw new Error(describeApiError(detailRes.error));

    const d: RawChemicalDetail = detailRes.value ?? {};
    return {
        dtxsid: d.dtxsid ?? dtxsid,
        dtxcid: d.dtxcid ?? "",
        casrn: d.casrn ?? null,
        preferredName: d.preferredName ?? "",
        iupacName: d.iupacName ?? "",
        molFormula: d.molFormula ?? "",
        smiles: d.smiles ?? "",
        inchikey: d.inchikey ?? "",
        monoisotopicMass: d.monoisotopicMass ?? null,
        qcLevel: d.qcLevel ?? null,
        totalAssays: d.totalAssays ?? null,
        activeAssays: d.activeAssays ?? null,
        percentAssays: d.percentAssays ?? null,
        pubchemCid: d.pubchemCid ?? null,
        pubmedCount: d.pubmedCount ?? null,
        sourcesCount: d.sourcesCount ?? null,
    };
}

/** Experimental + predicted physicochemical property summaries. `undefined` = none served. */
export async function fetchCtxChemicalProperties(dtxsid: string, headers: Record<string, string>): Promise<PropertySummary[] | undefined> {
    const propUrl = `${EPA_CCTE_BASE}/chemical/property/summary/search/by-dtxsid/${dtxsid}`;
    const propRes = await apiFetchValidated(propUrl, z.array(RawPropertySummarySchema), { headers });

    if (propRes.isOk() && Array.isArray(propRes.value)) {
        return propRes.value.map((p) => ({
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

    return undefined;
}

/* --------------------------------- exposure --------------------------------- */

export interface SeemPrediction {
    dtxsid: string;
    productionVolume: number | null;
    units: string;
    probabilityDietary: number | null;
    probabilityResidential: number | null;
    probabilityPesticide: number | null;
    probabilityIndustrial: number | null;
}

export interface HttkParameter {
    parameter: string;
    measured: number | null;
    predicted: number | null;
    units: string;
    model: string;
    species: string;
    reference: string;
}

export interface FunctionalUse {
    functionCategory: string;
    reportedFunction: string;
    docTitle: string;
}

export interface ProductData {
    productName: string;
    generalCategory: string;
    productFamily: string;
    productType: string;
    centralWeightFraction: number | null;
    weightFractionType: string;
}

// SEEM exposure-prediction wire shape. The endpoint answers with an array.
// `probabilityPesticde` is the wire name, and it is the own misspelling of the
// API. The corrected spelling is served nowhere, thus only the wire name is
// modeled and the mapped output carries the corrected one.
export const RawSeemPredictionSchema = z.object({
    dtxsid: z.string().optional(),
    productionVolume: z.number().nullable().optional(),
    units: z.string().nullable().optional(),
    probabilityDietary: z.number().nullable().optional(),
    probabilityResidential: z.number().nullable().optional(),
    probabilityPesticde: z.number().nullable().optional(),
    probabilityIndustrial: z.number().nullable().optional(),
});

export const RawHttkRowSchema = z.object({
    parameter: z.string().nullable().optional(),
    measured: z.number().nullable().optional(),
    predicted: z.number().nullable().optional(),
    units: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    species: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
});

export const RawFunctionalUseRowSchema = z.object({
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

export type CtxExposureDataType = "seem" | "httk" | "functional-use" | "product-data" | "all";

export interface CtxExposureData {
    seem?: SeemPrediction;
    httk?: HttkParameter[];
    functionalUse?: FunctionalUse[];
    productData?: ProductData[];
}

/**
 * Human-exposure data for a chemical. `limit` caps functional-use and
 * product-data only — seem and httk always come back whole.
 */
export async function fetchCtxExposureData(
    dtxsid: string,
    headers: Record<string, string>,
    opts: { dataType: CtxExposureDataType; limit: number },
): Promise<CtxExposureData> {
    const { dataType, limit } = opts;
    const data: CtxExposureData = {};
    const fetchers: Promise<void>[] = [];

    if (dataType === "seem" || dataType === "all") {
        fetchers.push(
            fetchSeem(dtxsid, headers).then((v) => {
                data.seem = v;
            }),
        );
    }
    if (dataType === "httk" || dataType === "all") {
        fetchers.push(
            fetchHttk(dtxsid, headers).then((v) => {
                data.httk = v;
            }),
        );
    }
    if (dataType === "functional-use" || dataType === "all") {
        fetchers.push(
            fetchFunctionalUse(dtxsid, headers, limit).then((v) => {
                data.functionalUse = v;
            }),
        );
    }
    if (dataType === "product-data" || dataType === "all") {
        fetchers.push(
            fetchProductData(dtxsid, headers, limit).then((v) => {
                data.productData = v;
            }),
        );
    }

    await Promise.all(fetchers);
    return data;
}

async function fetchSeem(dtxsid: string, headers: Record<string, string>): Promise<SeemPrediction | undefined> {
    const url = `${EPA_CCTE_BASE}/exposure/seem/general/search/by-dtxsid/${dtxsid}`;
    const res = await apiFetchValidated(url, z.array(RawSeemPredictionSchema), { headers });
    if (res.isErr()) return undefined;

    const d = res.value[0];
    if (!d) return undefined;

    return {
        dtxsid: d.dtxsid ?? dtxsid,
        productionVolume: d.productionVolume ?? null,
        units: d.units ?? "",
        probabilityDietary: d.probabilityDietary ?? null,
        probabilityResidential: d.probabilityResidential ?? null,
        probabilityPesticide: d.probabilityPesticde ?? null,
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
