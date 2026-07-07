/**
 * Pure async client functions for the openFDA FAERS adverse-event API.
 *
 * Used by §2.6.2 (FAERS summary) and §2.6.6 (class precedent — drugs-in-class
 * AEs).
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { OPENFDA_BASE, OPENFDA_LABEL_BASE } from "./openfda-config.js";

export interface AdverseEventCount {
    reaction: string;
    count: number;
}

export interface DrugLabelAction {
    applicationNumber: string | null;
    brandName: string | null;
    genericName: string | null;
    /** YYYYMMDD on the openFDA payload; we surface the raw token unchanged. */
    effectiveTime: string | null;
    boxedWarning: string | null;
    warningsAndCautions: string | null;
    hasRems: boolean;
    sourceUrl: string;
}

export interface SeriousnessProfile {
    totalReports: number;
    fatalCount: number;
    hospitalizationCount: number;
    lifeThreateningCount: number;
    disablingCount: number;
    congenitalAnomalyCount: number;
    otherSeriousCount: number;
}

// FAERS count/meta wire shapes, validated at the fetch boundary. Every field is
// optional — the API omits absent values, and graceful degradation relies on a
// partial-but-valid payload still parsing.
const FaersCountResponseSchema = z.object({
    results: z.array(z.object({ term: z.string().optional(), count: z.number().optional() })).optional(),
});

const FaersMetaResponseSchema = z.object({
    meta: z.object({ results: z.object({ total: z.number().optional() }).optional() }).optional(),
});

/** openFDA drug-label metadata block (`openfda`) — all fields free-form JSON. */
const OpenFdaLabelMetaSchema = z.object({
    application_number: z.unknown().optional(),
    brand_name: z.unknown().optional(),
    generic_name: z.unknown().optional(),
});
type OpenFdaLabelMeta = z.infer<typeof OpenFdaLabelMetaSchema>;

/** A single openFDA structured-product-label record (raw wire shape). */
const OpenFdaLabelSchema = z.object({
    set_id: z.unknown().optional(),
    openfda: OpenFdaLabelMetaSchema.optional(),
    effective_time: z.unknown().optional(),
    boxed_warning: z.unknown().optional(),
    warnings_and_cautions: z.unknown().optional(),
    warnings: z.unknown().optional(),
    rems_summary: z.unknown().optional(),
    rems_indication: z.unknown().optional(),
    medication_guide: z.unknown().optional(),
});
type OpenFdaLabel = z.infer<typeof OpenFdaLabelSchema>;

function buildSearch(drugName: string, serious: boolean): string {
    const escaped = drugName.replace(/"/g, '\\"');
    let search = `patient.drug.openfda.generic_name:"${escaped}"`;
    if (serious) search += "+AND+serious:1";
    return search;
}

/** Top adverse-reaction terms by count for a generic drug name. */
export async function getFaersByDrug(
    drugName: string,
    options: { limit?: number; serious?: boolean } = {},
): Promise<{ totalReports: number | undefined; adverseEvents: AdverseEventCount[] }> {
    const limit = options.limit ?? 25;
    const serious = options.serious ?? false;
    const search = buildSearch(drugName, serious);
    const countUrl = `${OPENFDA_BASE}?search=${encodeURIComponent(search)}` + `&count=patient.reaction.reactionmeddrapt.exact&limit=${limit}`;

    const res = await apiFetchValidated(countUrl, FaersCountResponseSchema);
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return { totalReports: 0, adverseEvents: [] };
        throw new Error(describeApiError(res.error));
    }
    const adverseEvents: AdverseEventCount[] = (res.value?.results ?? []).map((r) => ({
        reaction: r.term ?? "Unknown",
        count: r.count ?? 0,
    }));

    const totalUrl = `${OPENFDA_BASE}?search=${encodeURIComponent(search)}&limit=1`;
    const totalRes = await apiFetchValidated(totalUrl, FaersMetaResponseSchema);
    const totalReports = totalRes.isOk() ? totalRes.value?.meta?.results?.total : undefined;

    return { totalReports, adverseEvents };
}

/**
 * Seriousness breakdown for a drug. Aggregates the seriousness flags
 * (death, hospitalization, life-threatening, disabling) used by §2.6.2 fatal
 * and §2.6.8 risk summary.
 */
export async function getFaersSeriousness(drugName: string): Promise<SeriousnessProfile | null> {
    const escaped = drugName.replace(/"/g, '\\"');
    const search = `patient.drug.openfda.generic_name:"${escaped}"`;

    const totalUrl = `${OPENFDA_BASE}?search=${encodeURIComponent(search)}&limit=1`;
    const totalRes = await apiFetchValidated(totalUrl, FaersMetaResponseSchema);
    if (totalRes.isErr()) {
        if (totalRes.error.type === "http_status" && totalRes.error.status === 404) return null;
        throw new Error(describeApiError(totalRes.error));
    }
    const totalReports: number = totalRes.value?.meta?.results?.total ?? 0;
    if (totalReports === 0) {
        return {
            totalReports: 0,
            fatalCount: 0,
            hospitalizationCount: 0,
            lifeThreateningCount: 0,
            disablingCount: 0,
            congenitalAnomalyCount: 0,
            otherSeriousCount: 0,
        };
    }

    async function countWith(field: string): Promise<number> {
        const q = `${search}+AND+${field}:1`;
        const url = `${OPENFDA_BASE}?search=${encodeURIComponent(q)}&limit=1`;
        const res = await apiFetchValidated(url, FaersMetaResponseSchema);
        if (res.isErr()) return 0;
        return res.value?.meta?.results?.total ?? 0;
    }

    const [fatal, hosp, lifeT, dis, cong, other] = await Promise.all([
        countWith("seriousnessdeath"),
        countWith("seriousnesshospitalization"),
        countWith("seriousnesslifethreatening"),
        countWith("seriousnessdisabling"),
        countWith("seriousnesscongenitalanomali"),
        countWith("seriousnessother"),
    ]);

    return {
        totalReports,
        fatalCount: fatal,
        hospitalizationCount: hosp,
        lifeThreateningCount: lifeT,
        disablingCount: dis,
        congenitalAnomalyCount: cong,
        otherSeriousCount: other,
    };
}

function firstString(value: unknown): string | null {
    if (Array.isArray(value)) {
        const first = value.find((v) => typeof v === "string" && v.trim());
        return typeof first === "string" ? first : null;
    }
    if (typeof value === "string") return value || null;
    return null;
}

function joinSection(value: unknown): string | null {
    if (Array.isArray(value)) {
        const parts = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
        if (parts.length === 0) return null;
        return parts.join("\n\n");
    }
    if (typeof value === "string" && value.trim()) return value;
    return null;
}

/**
 * Build a stable, citable URL for an FDA structured product label. Prefers
 * the DailyMed `setid` URL (canonical reference), falls back to a search URL
 * keyed by application number when only that is available.
 */
function buildLabelSourceUrl(label: OpenFdaLabel): string {
    const setId = typeof label?.set_id === "string" ? label.set_id : null;
    if (setId) return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`;
    const appNum = firstString(label?.openfda?.application_number);
    if (appNum) {
        return `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${encodeURIComponent(appNum)}`;
    }
    return "https://www.accessdata.fda.gov/scripts/cder/daf/";
}

function mapLabel(raw: OpenFdaLabel): DrugLabelAction {
    const openfda: OpenFdaLabelMeta = raw?.openfda ?? {};
    const remsTextCandidates = [raw?.rems_summary, raw?.rems_indication, raw?.medication_guide];
    const hasRems = remsTextCandidates.some((v) => joinSection(v) !== null) || (joinSection(raw?.boxed_warning)?.toLowerCase().includes("rems") ?? false);

    return {
        applicationNumber: firstString(openfda.application_number),
        brandName: firstString(openfda.brand_name),
        genericName: firstString(openfda.generic_name),
        effectiveTime: typeof raw?.effective_time === "string" ? raw.effective_time : null,
        boxedWarning: joinSection(raw?.boxed_warning),
        warningsAndCautions: joinSection(raw?.warnings_and_cautions) ?? joinSection(raw?.warnings),
        hasRems,
        sourceUrl: buildLabelSourceUrl(raw),
    };
}

// The label endpoint's records are mapped to `DrugLabelAction` rows by
// `mapLabel` — a context-free normalize folded into the schema so ONE schema
// validates the raw wire AND emits the output rows.
const OpenFdaLabelResponseSchema = z.object({
    results: z.array(OpenFdaLabelSchema.transform(mapLabel)).optional(),
});

/**
 * Fetch FDA Structured Product Label entries by generic drug name. Returns
 * the most recent N labels (sorted by effective_time desc); each row carries
 * the boxed-warning text, the Section 5 warnings_and_cautions excerpt, and a
 * REMS indicator. Returns [] on 404 / no match.
 */
export async function getDrugLabelActions(genericName: string, options: { limit?: number } = {}): Promise<DrugLabelAction[]> {
    const limit = options.limit ?? 5;
    const escaped = genericName.replace(/"/g, '\\"');
    const search = `openfda.generic_name:"${escaped}"`;
    const url = `${OPENFDA_LABEL_BASE}?search=${encodeURIComponent(search)}` + `&sort=effective_time:desc&limit=${limit}`;
    const res = await apiFetchValidated(url, OpenFdaLabelResponseSchema);
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return res.value.results ?? [];
}
