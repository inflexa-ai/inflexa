import type { DerivedV4 } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { classifyOrgan, classifyTrialAe } from "./meddra-organ-map.js";
import { HIGH_EXPRESSION_TPM_THRESHOLD } from "./expression-constants.js";

const FAERS_TOP_SIGNAL_THRESHOLD = 1000;

/**
 * Derive the set of organs that should appear in the organ rollup based on
 * available safety signals (FAERS top signals, serious trial AEs, and
 * off-target panel entries).
 *
 * Exported so the Phase-4 assembler can call the same logic when building
 * organ_rollup rows — ensuring the set of "expected" organs is identical at
 * assembly time and at derived-validation time.
 */
export function expectedOrgansFromBody(body: any): string[] {
    const expected = new Set<string>();

    const top = body?.safety_profile?.faers?.data?.top_signals ?? [];
    for (const sig of top) {
        if (sig.report_count >= FAERS_TOP_SIGNAL_THRESHOLD) {
            const organ = classifyOrgan(sig.meddra_term);
            if (organ) expected.add(organ);
        }
    }

    const serious = body?.safety_profile?.trial_aes?.data?.serious ?? [];
    for (const ae of serious) {
        const organ = classifyTrialAe(ae);
        if (organ) expected.add(organ);
    }

    const offTargets = body?.safety_profile?.off_target_panel?.data?.rows ?? [];
    for (const r of offTargets) {
        if (r.organ_system && typeof r.organ_system === "string") expected.add(r.organ_system);
    }

    return [...expected].sort();
}

function presentOrgans(body: any): string[] {
    const rows = body?.safety_profile?.organ_rollup?.data?.rows ?? [];
    return rows
        .map((r: any) => r.organ)
        .filter((o: any): o is string => typeof o === "string")
        .sort();
}

function countDistinctPapers(body: any): number {
    const set = new Set<string>();
    const keyPapers = body?.reference_biology?.key_papers?.data?.rows ?? [];
    for (const p of keyPapers) if (p.pmid) set.add(String(p.pmid));
    return set.size;
}

function countDistinctTrials(body: any): number {
    const set = new Set<string>();
    // V5 partitions ineligible trials into `excluded_rows`, so the distinct
    // count must union both buckets for trials, failed_trials, and
    // discovery_trials. Outcomes preserves every row in `rows` and has no
    // `excluded_rows` bucket.
    const partitioned = [body?.clinical_development?.trials?.data, body?.clinical_development?.failed_trials?.data, body?.analytics?.discovery_trials?.data];
    for (const data of partitioned) {
        for (const bucket of ["rows", "excluded_rows"] as const) {
            for (const r of data?.[bucket] ?? []) {
                if (r.nct_id) set.add(String(r.nct_id));
            }
        }
    }
    for (const r of body?.clinical_development?.outcomes?.data?.rows ?? []) {
        if (r.nct_id) set.add(String(r.nct_id));
    }
    return set.size;
}

// Walk the entire body tree counting all `evidence` array entries to produce
// a total evidence item count. This is intentionally recursive and treats every
// nested `evidence` array as contributing to the total.
function countTotalEvidenceItems(body: any): number {
    let total = 0;
    const walk = (v: any) => {
        if (Array.isArray(v)) {
            v.forEach(walk);
        } else if (v && typeof v === "object") {
            if (Array.isArray((v as any).evidence)) total += (v as any).evidence.length;
            for (const k of Object.keys(v)) walk((v as any)[k]);
        }
    };
    walk(body);
    return total;
}

function hasHumanEvidence(body: any): boolean {
    let any = false;
    const walk = (v: any) => {
        if (any) return;
        if (Array.isArray(v)) {
            v.forEach(walk);
        } else if (v && typeof v === "object") {
            if ((v as any).has_human_evidence === true || (v as any).is_human === true) {
                any = true;
                return;
            }
            for (const k of Object.keys(v)) walk((v as any)[k]);
        }
    };
    walk(body);
    return any;
}

function hasClinicalEvidence(body: any): boolean {
    let any = false;
    const walk = (v: any) => {
        if (any) return;
        if (Array.isArray(v)) {
            v.forEach(walk);
        } else if (v && typeof v === "object") {
            if ((v as any).has_clinical_evidence === true || (v as any).is_clinical === true) {
                any = true;
                return;
            }
            for (const k of Object.keys(v)) walk((v as any)[k]);
        }
    };
    walk(body);
    return any;
}

function highestRiskOrgan(body: any): string | null {
    const rows: { organ: string; risk_level: string }[] = body?.safety_profile?.organ_rollup?.data?.rows ?? [];
    const high = rows.find((r) => r.risk_level === "high");
    if (high) return high.organ;
    const med = rows.find((r) => r.risk_level === "medium");
    if (med) return med.organ;
    return null;
}

function topIndicationSummary(body: any): {
    highest_score: number | null;
    strongest_strength_label: string | null;
    highest_score_is_conflicted: boolean;
} {
    const rows: any[] = body?.indications?.coverage === "available" ? (body.indications.data?.rows ?? []) : [];
    if (rows.length === 0) {
        return { highest_score: null, strongest_strength_label: null, highest_score_is_conflicted: false };
    }
    let top: any = null;
    for (const r of rows) {
        if (typeof r.composite_score !== "number") continue;
        if (!top || r.composite_score > top.composite_score) top = r;
    }
    if (!top) {
        return { highest_score: null, strongest_strength_label: null, highest_score_is_conflicted: false };
    }
    const conflicted = Array.isArray(top.evidence) ? top.evidence.some((e: any) => e?.predicate === "direction_mismatch") : false;
    return {
        highest_score: top.composite_score ?? null,
        strongest_strength_label: top.disease_name ?? null,
        highest_score_is_conflicted: conflicted,
    };
}

// Count distinct high-expression tissues across the human protein atlas consensus
// (normal_tissue_expression, keyed as "human") and the cross-species expression
// heatmap. Deduplication uses `${tissue}::${species}` pairs so the same tissue
// in different species counts as separate entries.
function countHighExpressionTissues(body: any): number {
    const set = new Set<string>();

    const consensusRows = body?.reference_biology?.normal_tissue_expression?.data?.rows ?? [];
    for (const r of consensusRows) {
        if ((r.value ?? 0) >= HIGH_EXPRESSION_TPM_THRESHOLD && r.tissue) {
            set.add(`${r.tissue}::human`);
        }
    }

    const heatmapCells = body?.reference_biology?.preclinical?.expression_heatmap?.data?.cells ?? [];
    for (const c of heatmapCells) {
        if (c.rank === "high" && c.tissue) {
            const species = c.species ?? "unknown";
            set.add(`${c.tissue}::${species}`);
        }
    }

    return set.size;
}

/**
 * Build the v4 derived sub-tree from a raw dossier body.
 *
 * Pure function: no I/O, no LLM calls, no side effects. Defensive against
 * missing/partial bodies — always returns a best-effort result and never throws.
 * Schema validation happens at the persist boundary (Task 11), not here.
 */
export function computeDerivedFields(body: any): DerivedV4 {
    const classLiabilityRows =
        body?.safety_profile?.class_precedent?.coverage === "available"
            ? (body.safety_profile.class_precedent.data.per_organ ?? []).filter((o: any) => o.is_class_liability)
            : [];
    const classLiabilityCount = classLiabilityRows.length;

    const sameClassDrugCount =
        body?.safety_profile?.class_precedent?.coverage === "available" ? (body.safety_profile.class_precedent.data.drugs_in_class ?? []).length : 0;

    const offTargetRows = body?.safety_profile?.off_target_panel?.data?.rows ?? [];
    const safetyHits = offTargetRows.filter((r: any) => r.is_safety_panel_target === true).length;

    const offTissueRows = body?.off_tissue_risk?.data?.rows ?? [];
    const offTissueOrganCount = new Set(offTissueRows.map((r: any) => r.organ).filter(Boolean)).size;

    const expected = expectedOrgansFromBody(body);
    const present = presentOrgans(body);
    const missing = expected.filter((o) => !present.includes(o));

    const seriousness = body?.safety_profile?.faers?.data?.seriousness;
    const fatalBullet = (body?.liability_summary?.liability_bullets ?? []).some((b: any) => b?.category === "fatal_post_market");
    const anyFatal: boolean | "unknown" =
        seriousness?.coverage === "available" ? (seriousness.by_seriousness?.death ?? 0) > 0 || fatalBullet : fatalBullet ? true : "unknown";

    const tissueRows = body?.reference_biology?.normal_tissue_expression?.data?.rows ?? [];
    const highTissues = countHighExpressionTissues(body);

    const safetySources = ["organ_rollup", "faers", "trial_aes", "off_target_panel", "failed_trials_safety_lens", "class_precedent"].filter(
        (k) => body?.safety_profile?.[k]?.coverage === "available",
    ).length;

    return {
        summary: {
            has_human_evidence: hasHumanEvidence(body),
            has_clinical_evidence: hasClinicalEvidence(body),
            total_evidence_items: countTotalEvidenceItems(body),
            total_distinct_papers: countDistinctPapers(body),
            total_distinct_clinical_trials: countDistinctTrials(body),
            ...topIndicationSummary(body),
        },
        risk_summary: {
            any_fatal_signal: anyFatal,
            highest_risk_organ: highestRiskOrgan(body),
            off_target_safety_target_hits: safetyHits,
            class_liability_count: classLiabilityCount,
        },
        liability_summary: {
            counts: {
                class_liability_count: classLiabilityCount,
                safety_target_off_target_count: safetyHits,
                off_tissue_risk_organ_count: offTissueOrganCount,
            },
            expression_breadth: {
                total_assessed_tissues: tissueRows.length,
                high_expression_tissue_count: highTissues,
            },
            same_class_drug_count: sameClassDrugCount,
            safety_data_sources_checked: safetySources,
        },
        organ_rollup_completeness: {
            expected_organs: expected,
            present_organs: present,
            missing_organs: missing,
        },
    };
}
