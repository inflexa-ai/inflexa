/**
 * Approval-precedent grounding for Phase-5 synthesis.
 *
 * Synthesis runs single-shot forced-`submit` LLM calls and can therefore call
 * no tool. This module does the openFDA / Drugs@FDA lookup deterministically
 * before synthesis so the fetched precedents can be injected into the synthesis
 * prompts as a static markdown block. The fetch, in-memory TTL cache, and
 * mapping mirror what a per-turn tool would have done, minus the tool wrapper.
 *
 * One fetch produces one typed form: each precedent keeps its label's safety
 * sections as `LabelSafetyText`. The markdown block is a projection of that
 * form, not a replacement for it — the same sections also project onto
 * per-organ regulatory signals via `segmentLabelSafety`.
 */

import type { DossierBody } from "../../../contracts/target-dossier.js";
import { LABEL_SAFETY_SECTIONS, type FdaLabelSafety, type LabelSafetySection, type LabelSafetyText } from "./fda-label-safety.js";

export type PrecedentModality = "small_molecule" | "biologic" | "gene_therapy" | "cell_therapy";

export interface FetchApprovalPrecedentsInput {
    indication: string;
    modality?: PrecedentModality;
    mechanism?: string;
}

export interface Precedent {
    /** Null when openFDA published the label without one; such a label cannot be cited. */
    application_number: string | null;
    brand_name?: string;
    generic_name?: string;
    approval_date?: string;
    safety_sections: LabelSafetyText[];
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

/** Per-block ingest budget — enough prose to segment, bounded for the step cache. */
const SECTION_INGEST_CHARS = 4000;

/** Per-section budget in the rendered markdown, which rides in every synthesis prompt. */
const SECTION_RENDER_CHARS = 1000;

function ingestSafetySections(r: OpenFdaLabelResult): LabelSafetyText[] {
    const sections: LabelSafetyText[] = [];
    const push = (section: LabelSafetySection, blocks: string[] | undefined): void => {
        for (const block of blocks ?? []) {
            const text = block.trim();
            if (text.length === 0) continue;
            sections.push({ section, text: text.slice(0, SECTION_INGEST_CHARS) });
        }
    };

    push("boxed_warning", r.boxed_warning);
    // Current labels publish Section 5 as `warnings_and_precautions`; older ones
    // publish the same prose as `warnings`. Ingesting both files it twice.
    if (r.warnings_and_precautions?.length) push("warnings_and_precautions", r.warnings_and_precautions);
    else push("warnings", r.warnings);
    push("contraindications", r.contraindications);

    return sections;
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
    const precedents: Precedent[] = (json.results ?? []).slice(0, 10).map((r) => ({
        application_number: r.openfda?.application_number?.[0] ?? null,
        brand_name: r.openfda?.brand_name?.[0],
        generic_name: r.openfda?.generic_name?.[0],
        approval_date: r.effective_time,
        safety_sections: ingestSafetySections(r),
    }));

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
export function pickIndicationForPrecedents(dossier: DossierBody): string | null {
    const indications = dossier.indications;
    if (indications.coverage === "available" && indications.data.rows.length > 0) {
        const top = indications.data.rows.reduce((best, row) => (row.composite_score > best.composite_score ? row : best));
        if (top.disease_name) return top.disease_name;
    }
    return dossier.liability_summary.inferred_therapeutic_area ?? null;
}

/**
 * Project the fetched precedents onto the typed label form the per-organ
 * segmentation reads. A label without an application number is skipped: its
 * signals would carry no locator, and an unciteable signal is not evidence.
 */
export function precedentLabelSafety(precedents: readonly Precedent[]): FdaLabelSafety[] {
    const labels: FdaLabelSafety[] = [];
    for (const p of precedents) {
        if (p.application_number === null || p.safety_sections.length === 0) continue;
        labels.push({
            application_number: p.application_number,
            drug_name: p.generic_name ?? p.brand_name ?? p.application_number,
            effective_time: p.approval_date,
            sections: p.safety_sections,
        });
    }
    return labels;
}

/**
 * The prose a reader meets for one section: the longest block published under
 * it. openFDA returns both the highlights summary and the full section under
 * the same key, and the full section is the one worth grounding on.
 */
function renderableSections(precedent: Precedent): Array<[LabelSafetySection, string]> {
    const longest = new Map<LabelSafetySection, string>();
    for (const { section, text } of precedent.safety_sections) {
        const current = longest.get(section);
        if (current === undefined || text.length > current.length) longest.set(section, text);
    }
    return LABEL_SAFETY_SECTIONS.filter((section) => longest.has(section)).map((section) => [section, longest.get(section)!.slice(0, SECTION_RENDER_CHARS)]);
}

/**
 * Render the fetched precedents as a markdown block for injection into the
 * synthesis prompts. The block always begins with the `## FDA approval
 * precedents` header, which the synthesis briefs reference verbatim.
 *
 * Synthesis is a single-shot forced-`submit` call that can reach no tool, so
 * this block is the whole of what the model gets: a plain string, no citation
 * the model is expected to resolve itself.
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
        const application = p.application_number ?? "unknown application number";
        lines.push(`- ${generic} (${brand}), ${application}, approved ${date}`);
        for (const [section, excerpt] of renderableSections(p)) {
            lines.push(`  - ${section}: ${excerpt}`);
        }
    }
    return lines.join("\n");
}
