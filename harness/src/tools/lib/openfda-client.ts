/**
 * Pure async client functions for the openFDA FAERS adverse-event API.
 *
 * Used by §2.6.2 (FAERS summary) and §2.6.6 (class precedent — drugs-in-class
 * AEs).
 */

import { apiFetch, describeApiError } from "./api-utils.js";
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

    const res = await apiFetch<any>(countUrl);
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return { totalReports: 0, adverseEvents: [] };
        throw new Error(describeApiError(res.error));
    }
    const adverseEvents: AdverseEventCount[] = (res.value?.results ?? []).map((r: any) => ({
        reaction: r.term ?? "Unknown",
        count: r.count ?? 0,
    }));

    const totalUrl = `${OPENFDA_BASE}?search=${encodeURIComponent(search)}&limit=1`;
    const totalRes = await apiFetch<any>(totalUrl);
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
    const totalRes = await apiFetch<any>(totalUrl);
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
        const res = await apiFetch<any>(url);
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
function buildLabelSourceUrl(label: any): string {
    const setId = typeof label?.set_id === "string" ? label.set_id : null;
    if (setId) return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`;
    const appNum = firstString(label?.openfda?.application_number);
    if (appNum) {
        return `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${encodeURIComponent(appNum)}`;
    }
    return "https://www.accessdata.fda.gov/scripts/cder/daf/";
}

function mapLabel(raw: any): DrugLabelAction {
    const openfda = raw?.openfda ?? {};
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
    const res = await apiFetch<{ results?: any[] }>(url);
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return (res.value.results ?? []).map(mapLabel);
}
