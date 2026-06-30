/**
 * Pure async client functions for the EMA (European Medicines Agency)
 * referrals catalogue.
 *
 * The catalogue is exposed as a single bulk JSON download (~700KB) that
 * lists every ongoing and completed EMA referral procedure (Article 31,
 * Article 20, etc.). We fetch and cache it in-process; per-drug queries
 * filter the cached records by INN, referral name, and associated
 * medicine names.
 */

import { apiFetch, describeApiError } from "./api-utils.js";
import { EMA_REFERRALS_URL } from "./ema-config.js";

export interface EmaReferral {
    category: string;
    referralName: string;
    inn: string;
    currentStatus: string;
    safetyReferral: boolean;
    referralType: string;
    associatedMedicinesCentrally: string[];
    associatedMedicinesNationally: string[];
    class: string;
    referenceNumber: string;
    authorisationModel: string;
    procedureStartDate: string;
    pracRecommendationDate: string;
    cmdhPositionDate: string;
    chmpOpinionDate: string;
    europeanCommissionDecisionDate: string;
    firstPublishedDate: string;
    lastUpdatedDate: string;
    referralUrl: string;
}

interface RawReferral {
    category?: string;
    referral_name?: string;
    international_non_proprietary_name_inn_common_name?: string;
    current_status?: string;
    safety_referral?: string;
    referral_type?: string;
    associated_names_centrally_authorised_medicines?: string;
    associated_names_non_centrally_authorised_medicines?: string;
    class?: string;
    reference_number?: string;
    authorisation_model?: string;
    procedure_start_date?: string;
    prac_recommendation_date?: string;
    cmdh_position_date?: string;
    chmp_cvmp_opinion_date?: string;
    european_commission_decision_date?: string;
    first_published_date?: string;
    last_updated_date?: string;
    referral_url?: string;
}

interface ReferralFile {
    meta?: { total_records?: number; timestamp?: string };
    data?: RawReferral[];
}

function parseMedicineList(field: string | undefined): string[] {
    if (!field || !field.trim()) return [];
    return field
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function mapRaw(raw: RawReferral): EmaReferral {
    return {
        category: raw.category ?? "",
        referralName: raw.referral_name ?? "",
        inn: raw.international_non_proprietary_name_inn_common_name ?? "",
        currentStatus: raw.current_status ?? "",
        safetyReferral: (raw.safety_referral ?? "").toLowerCase() === "yes",
        referralType: raw.referral_type ?? "",
        associatedMedicinesCentrally: parseMedicineList(raw.associated_names_centrally_authorised_medicines),
        associatedMedicinesNationally: parseMedicineList(raw.associated_names_non_centrally_authorised_medicines),
        class: raw.class ?? "",
        referenceNumber: raw.reference_number ?? "",
        authorisationModel: raw.authorisation_model ?? "",
        procedureStartDate: raw.procedure_start_date ?? "",
        pracRecommendationDate: raw.prac_recommendation_date ?? "",
        cmdhPositionDate: raw.cmdh_position_date ?? "",
        chmpOpinionDate: raw.chmp_cvmp_opinion_date ?? "",
        europeanCommissionDecisionDate: raw.european_commission_decision_date ?? "",
        firstPublishedDate: raw.first_published_date ?? "",
        lastUpdatedDate: raw.last_updated_date ?? "",
        referralUrl: raw.referral_url ?? "",
    };
}

let _cache: { fetchedAt: number; referrals: EmaReferral[] } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Download (or return cached) full EMA referrals catalogue. The catalogue
 * updates twice daily — a 6h in-process TTL is well within freshness
 * tolerance while keeping the per-collector overhead near zero.
 */
export async function fetchAllReferrals(): Promise<EmaReferral[]> {
    if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
        return _cache.referrals;
    }
    const res = await apiFetch<ReferralFile>(EMA_REFERRALS_URL, {
        headers: { Accept: "application/json" },
    });
    if (res.isErr()) throw new Error(`EMA referrals fetch failed: ${describeApiError(res.error)}`);
    const referrals = (res.value.data ?? []).map(mapRaw);
    _cache = { fetchedAt: Date.now(), referrals };
    return referrals;
}

function nameMatches(referral: EmaReferral, needle: string): boolean {
    if (!needle) return false;
    if (referral.inn.toLowerCase().includes(needle)) return true;
    if (referral.referralName.toLowerCase().includes(needle)) return true;
    for (const m of referral.associatedMedicinesCentrally) {
        if (m.toLowerCase().includes(needle)) return true;
    }
    for (const m of referral.associatedMedicinesNationally) {
        if (m.toLowerCase().includes(needle)) return true;
    }
    return false;
}

/**
 * Find EMA referrals associated with a drug name (matches INN, referral
 * name, and centrally/nationally-authorised medicine names). Returns all
 * matches; the caller filters by referralType / currentStatus as needed.
 */
export async function getReferralsByDrug(drugName: string): Promise<EmaReferral[]> {
    const all = await fetchAllReferrals();
    const needle = drugName.toLowerCase().trim();
    return all.filter((r) => nameMatches(r, needle));
}

/** Reset the in-process catalogue cache. Test-only. */
export function __resetReferralsCacheForTest(): void {
    _cache = null;
}
