/**
 * Deterministic structural conflict detector.
 *
 * Each rule is a pure function over the dossier body. A row is emitted
 * when the body internally contradicts itself in a way that should be
 * impossible post-pipeline-fix. The post-fix pipeline should produce an
 * empty array for any well-formed body; the rules exist to catch
 * regressions and to surface upstream pipeline bugs.
 */

import { HIGH_EXPRESSION_TPM_THRESHOLD } from "./expression-constants.js";

export type StructuralEvidenceConflict = {
    evidence_item_id: string;
    predicate: string;
    contradicting_predicates: string[];
    surfaced_in_section: string;
    evidence: never[];
};

// Loose structural view over a raw dossier body. Every field is optional and
// every section wraps its payload as `{ coverage?, data? }` — these rules are
// deliberately defensive against a partial/malformed body (schema validation
// runs at the persist boundary). Names only the fields these checks read; the
// exported entrypoint accepts `unknown` and casts to this view.
type Section<T> = { coverage?: string; data?: T };

interface EvidenceBodyView {
    safety_profile?: {
        faers?: { coverage?: string };
        class_precedent?: Section<{ per_organ?: Array<{ top_aes?: Array<{ report_count?: number }> }> }>;
    };
    derived?: {
        risk_summary?: { any_fatal_signal?: unknown };
        liability_summary?: { expression_breadth?: { high_expression_tissue_count?: unknown } };
    };
    liability_summary?: { liability_bullets?: Array<{ category?: string }> };
    clinical_development?: {
        trials?: { coverage?: string };
        outcomes?: Section<{ rows?: unknown[] }>;
    };
    reference_biology?: {
        normal_tissue_expression?: Section<{ rows?: Array<{ value?: number; tissue?: string }> }>;
        preclinical?: { expression_heatmap?: Section<{ cells?: Array<{ rank?: string; tissue?: string; species?: string }> }> };
    };
}

function checkFaersCoverage(body: EvidenceBodyView): StructuralEvidenceConflict | null {
    const faers = body?.safety_profile?.faers;
    const cp = body?.safety_profile?.class_precedent;
    if (faers?.coverage !== "queried_no_data") return null;
    if (cp?.coverage !== "available") return null;
    let total = 0;
    for (const o of cp.data?.per_organ ?? []) {
        for (const ae of o.top_aes ?? []) total += ae.report_count ?? 0;
    }
    if (total === 0) return null;
    return {
        evidence_item_id: "structural:faers_coverage",
        predicate: "safety_profile.faers.coverage=queried_no_data",
        contradicting_predicates: [`safety_profile.class_precedent has ${total} FAERS-derived reports across per_organ.top_aes`],
        surfaced_in_section: "safety_profile.faers",
        evidence: [],
    };
}

function checkFatalSignal(body: EvidenceBodyView): StructuralEvidenceConflict | null {
    const signal = body?.derived?.risk_summary?.any_fatal_signal;
    if (signal !== "unknown") return null;
    const bullets = body?.liability_summary?.liability_bullets ?? [];
    const fatal = bullets.find((b) => b?.category === "fatal_post_market");
    if (!fatal) return null;
    return {
        evidence_item_id: "structural:fatal_signal",
        predicate: "derived.risk_summary.any_fatal_signal=unknown",
        contradicting_predicates: ["liability_summary.liability_bullets contains a fatal_post_market entry"],
        surfaced_in_section: "derived.risk_summary",
        evidence: [],
    };
}

function checkTrialCount(body: EvidenceBodyView): StructuralEvidenceConflict | null {
    const trials = body?.clinical_development?.trials;
    const outcomes = body?.clinical_development?.outcomes;
    if (trials?.coverage !== "queried_no_data") return null;
    const outcomeRows = outcomes?.coverage === "available" ? (outcomes.data?.rows ?? []) : [];
    if (outcomeRows.length === 0) return null;
    return {
        evidence_item_id: "structural:trial_count",
        predicate: "clinical_development.trials.coverage=queried_no_data",
        contradicting_predicates: [`clinical_development.outcomes.data.rows has ${outcomeRows.length} row(s)`],
        surfaced_in_section: "clinical_development.outcomes",
        evidence: [],
    };
}

function checkHighExpressionCount(body: EvidenceBodyView): StructuralEvidenceConflict | null {
    const reported = body?.derived?.liability_summary?.expression_breadth?.high_expression_tissue_count;
    if (typeof reported !== "number") return null;
    const set = new Set<string>();
    const consensusRows = body?.reference_biology?.normal_tissue_expression?.data?.rows ?? [];
    for (const r of consensusRows) {
        if ((r.value ?? 0) >= HIGH_EXPRESSION_TPM_THRESHOLD && r.tissue) {
            set.add(`${r.tissue}::human`);
        }
    }
    const cells = body?.reference_biology?.preclinical?.expression_heatmap?.data?.cells ?? [];
    for (const c of cells) {
        if (c.rank === "high" && c.tissue) set.add(`${c.tissue}::${c.species ?? "unknown"}`);
    }
    if (set.size === reported) return null;
    return {
        evidence_item_id: "structural:high_expression_count",
        predicate: `derived.liability_summary.expression_breadth.high_expression_tissue_count=${reported}`,
        contradicting_predicates: [`body-recomputed count is ${set.size}`],
        surfaced_in_section: "derived.liability_summary.expression_breadth",
        evidence: [],
    };
}

export function detectStructuralEvidenceConflicts(bodyInput: unknown): StructuralEvidenceConflict[] {
    const body = bodyInput as EvidenceBodyView;
    const out: StructuralEvidenceConflict[] = [];
    for (const fn of [checkFaersCoverage, checkFatalSignal, checkTrialCount, checkHighExpressionCount]) {
        const row = fn(body);
        if (row) out.push(row);
    }
    return out;
}
