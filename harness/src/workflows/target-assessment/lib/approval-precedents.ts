/**
 * Approval-precedent grounding for Phase-5 synthesis.
 *
 * Synthesis runs single-shot forced-`submit` LLM calls and can therefore call
 * no tool. This module does the openFDA / Drugs@FDA lookup deterministically
 * before synthesis so the fetched precedents can be injected into the synthesis
 * prompts as a static markdown block. The fetch, in-memory TTL cache, and
 * mapping mirror what a per-turn tool would have done, minus the tool wrapper.
 */

import type { DossierV4Body } from "../../../contracts/target-dossier.js";

export type PrecedentModality = "small_molecule" | "biologic" | "gene_therapy" | "cell_therapy";

export interface FetchApprovalPrecedentsInput {
    indication: string;
    modality?: PrecedentModality;
    mechanism?: string;
}

export interface Precedent {
    application_number: string;
    brand_name?: string;
    generic_name?: string;
    approval_date?: string;
    label_section_excerpts?: Record<string, string>;
}

interface OpenFdaLabelResult {
    openfda?: {
        application_number?: string[];
        brand_name?: string[];
        generic_name?: string[];
    };
    effective_time?: string;
    boxed_warning?: string[];
    warnings_and_precautions?: string[];
    warnings?: string[];
    contraindications?: string[];
}

const cache = new Map<string, { ts: number; value: { precedents: Precedent[] } }>();
const TTL_MS = 60 * 60 * 1000;

/**
 * Query openFDA for prior approvals in a given indication. Returns
 * NDA/BLA application numbers, generic and brand names, approval dates
 * (label effective time), and label-section excerpts.
 *
 * openFDA answers a zero-match search with 404 — an expected "no precedents"
 * outcome, returned uncached so a later, more specific query is not masked.
 * Any other non-ok status (5xx, 429) is an unexpected failure and throws; the
 * caller wraps the throw.
 */
export async function fetchApprovalPrecedents(input: FetchApprovalPrecedentsInput): Promise<{ precedents: Precedent[] }> {
    const { indication, modality, mechanism } = input;
    const key = JSON.stringify({
        indication: indication.toLowerCase(),
        modality,
        mechanism,
    });
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.value;

    const term = indication.replace(/"/g, "");
    const url = new URL("https://api.fda.gov/drug/label.json");
    url.searchParams.set("search", `indications_and_usage:"${term}"`);
    url.searchParams.set("limit", "10");

    const res = await fetch(url);
    if (res.status === 404) return { precedents: [] };
    if (!res.ok) {
        throw new Error(`openFDA label query failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as { results?: OpenFdaLabelResult[] };
    const precedents: Precedent[] = (json.results ?? []).slice(0, 10).map((r) => {
        const excerpts: Record<string, string> = {};
        if (r.boxed_warning?.[0]) excerpts.boxed_warning = r.boxed_warning[0].slice(0, 1000);
        if (r.warnings_and_precautions?.[0]) excerpts.warnings_and_precautions = r.warnings_and_precautions[0].slice(0, 1000);
        else if (r.warnings?.[0]) excerpts.warnings = r.warnings[0].slice(0, 1000);
        if (r.contraindications?.[0]) excerpts.contraindications = r.contraindications[0].slice(0, 1000);

        return {
            application_number: r.openfda?.application_number?.[0] ?? "(unknown)",
            brand_name: r.openfda?.brand_name?.[0],
            generic_name: r.openfda?.generic_name?.[0],
            approval_date: r.effective_time,
            label_section_excerpts: Object.keys(excerpts).length > 0 ? excerpts : undefined,
        };
    });

    const value = { precedents };
    cache.set(key, { ts: Date.now(), value });
    return value;
}

/** Test-only — clears the in-memory cache to avoid cross-test bleed. */
export function __resetApprovalPrecedentCacheForTest(): void {
    cache.clear();
}

/**
 * Pick the openFDA query term for a Phase-4 dossier: the top `indications`
 * row by `composite_score` (only when indications coverage is available and
 * has rows), falling back to the inferred therapeutic area, else null.
 */
export function pickIndicationForPrecedents(dossier: DossierV4Body): string | null {
    const indications = dossier.indications;
    if (indications.coverage === "available" && indications.data.rows.length > 0) {
        const top = indications.data.rows.reduce((best, row) => (row.composite_score > best.composite_score ? row : best));
        if (top.disease_name) return top.disease_name;
    }
    return dossier.liability_summary.inferred_therapeutic_area ?? null;
}

/**
 * Render the fetched precedents as a markdown block for injection into the
 * synthesis prompts. The block always begins with the `## FDA approval
 * precedents` header, which the synthesis briefs reference verbatim.
 */
export function renderApprovalPrecedents(indication: string | null, result: { precedents: Precedent[] } | null): string {
    const header = "## FDA approval precedents";

    if (indication === null) {
        return [header, "", "No indication could be resolved from the dossier, so no FDA approval precedents were queried."].join("\n");
    }

    const precedents = result?.precedents ?? [];
    if (precedents.length === 0) {
        return [
            header,
            "",
            `No FDA approval precedents were found for "${indication}". Do not assert class precedents that are not present in the dossier.`,
        ].join("\n");
    }

    const lines: string[] = [
        header,
        "",
        `Prior FDA approvals retrieved for "${indication}". Ground class-precedent and disposition claims in these records; do not invent precedents beyond this list and the dossier.`,
        "",
    ];
    for (const p of precedents) {
        const generic = p.generic_name ?? "unknown generic";
        const brand = p.brand_name ?? "unknown brand";
        const date = p.approval_date ?? "unknown date";
        lines.push(`- ${generic} (${brand}), ${p.application_number}, approved ${date}`);
        if (p.label_section_excerpts) {
            for (const [section, excerpt] of Object.entries(p.label_section_excerpts)) {
                lines.push(`  - ${section}: ${excerpt}`);
            }
        }
    }
    return lines.join("\n");
}
