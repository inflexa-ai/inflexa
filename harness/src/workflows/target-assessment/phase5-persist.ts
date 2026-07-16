/**
 * Phase 5 — stamps the four Phase-5 synthesis outputs into the Phase-4 dossier,
 * runs the deterministic refinement passes (coverage-qualifier reconcile,
 * no-liabilities disclosure rewrite, recommendation citation validation +
 * demotion, recommendation quality gates), upgrades the v4 body to v5,
 * computes derived fields, and validates against `DossierV5Schema`.
 *
 * The DB write (`setDossier` / `markFailed`) lives in the workflow's terminal
 * handler in §6. This module returns the validated dossier instead of writing it.
 * Typed throws (`DossierSchemaViolationError`, `DossierDerivedInvariantError`)
 * let the terminal handler dispatch to `markFailed` with the matching `error.kind`.
 *
 * The direction-of-effect audit (`auditCitationDirections`) is NOT called here —
 * it requires an LLM and is not on the PR #4 critical path. Follow-up tracked
 * in §17 if a harness-native audit pipeline is wired.
 */

import { z } from "zod";

import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";

import {
    DossierV5Schema,
    type DossierV4Body,
    type DossierV5Body,
    type ExecutiveRecommendation,
    type ExecutiveRecommendationData,
    type SynthesisDiagnosticRow,
} from "@inflexa-ai/harness/contracts/target-dossier.js";

import { getDrugPrimaryTargetUniprots } from "../../tools/lib/chembl-client.js";
import { deterministicTranslationalCommentary } from "./assemblers/index.js";
import { validateRecommendationCitations, type RecommendationAudit } from "./lib/citation-validator.js";
import { classifyClinicalEvidenceTrial, type KnownClassDrug, type TherapeuticProgram } from "./lib/clinical-evidence-attribution.js";
import { computeDerivedFields } from "./lib/compute-derived.js";
import { detectStructuralEvidenceConflicts } from "./lib/evidence-conflict-detector.js";
import { applyRecommendationQualityGates } from "./lib/recommendation-quality-gates.js";
import { sanitizeRecommendation } from "./lib/recommendation-sanitizer.js";
import { resolveFamilySiblingUniprots } from "./lib/target-identity-filter.js";

import type { Phase2Bundle } from "./steps/phase2-aggregate.js";

import type {
    DossierRecommendationStepOutput,
    LiabilityBulletsStepOutput,
    SafetyFlagsTrailStepOutput,
    TranslationalCommentaryStepOutput,
} from "./synthesis/index.js";

const SOFT_CAP_BYTES = 16 * 1024 * 1024;

// ── Typed throws — handled in §6 terminal handler ────────────────────

export class DossierSchemaViolationError extends Error {
    constructor(
        message: string,
        readonly issues: readonly unknown[],
    ) {
        super(message);
        this.name = "DossierSchemaViolationError";
    }
}

export class DossierDerivedInvariantError extends Error {
    constructor(
        message: string,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = "DossierDerivedInvariantError";
    }
}

// ── Input/output shapes ──────────────────────────────────────────────

export interface Phase5PersistInput {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly assessmentId: string;
    readonly phase4Dossier: DossierV4Body;
    readonly phase2: Phase2Bundle;
    readonly synthesis: {
        readonly bullets: LiabilityBulletsStepOutput;
        readonly flags: SafetyFlagsTrailStepOutput;
        readonly commentary: TranslationalCommentaryStepOutput;
        readonly recommendation: DossierRecommendationStepOutput;
    };
}

export const Phase5PersistResultSchema = z.object({
    assessmentId: z.string(),
    dossier: z.record(z.string(), z.unknown()),
    bytes: z.number(),
});

export interface Phase5PersistResult {
    readonly assessmentId: string;
    readonly dossier: Record<string, unknown>;
    readonly bytes: number;
}

// ── Internal helpers ─────────────────────────────────────────────────

function approximateSize(d: DossierV4Body): number {
    return Buffer.byteLength(JSON.stringify(d), "utf-8");
}

function truncateOversize(d: DossierV4Body): DossierV4Body {
    const next = structuredClone(d);
    const ta = next.reference_biology.therapeutic_area_associations;
    if (ta.coverage === "available" && ta.data.rows.length > 50) {
        ta.data.rows = ta.data.rows.slice(0, 50);
        ta.truncated = true;
    }
    const ind = next.indications;
    if (ind.coverage === "available" && ind.data.rows.length > 25) {
        ind.data.rows = ind.data.rows.slice(0, 25);
        ind.truncated = true;
    }
    const ppi = next.reference_biology.ppi_network;
    if (ppi.coverage === "available" && ppi.data.partners.length > 50) {
        ppi.data.partners = ppi.data.partners.slice(0, 50);
        ppi.truncated = true;
    }
    return next;
}

function pickCommentarySeverity(row: {
    topic: "ko_phenotype" | "expression_translation" | "organ_system_match" | "family_context";
    predicate: string;
    commentary: string;
}): "ok" | "caution" | "gap" {
    const blob = `${row.predicate} ${row.commentary}`.toLowerCase();
    if (row.topic === "ko_phenotype" && /pre[- ]?weaning|embryonic|lethal/i.test(blob)) {
        return "caution";
    }
    if (row.topic === "expression_translation" && /(≥|>=|two[- ]?step|2[- ]?step|diverge|divergence|rank.*differ)/i.test(blob)) {
        return "caution";
    }
    if (/queried.+(no data|no calls|empty|no tissue)/i.test(blob)) {
        return "gap";
    }
    return "ok";
}

interface CollectedSynthesis {
    readonly bullets: LiabilityBulletsStepOutput;
    readonly flags: SafetyFlagsTrailStepOutput;
    readonly commentary: TranslationalCommentaryStepOutput;
    readonly recommendation: DossierRecommendationStepOutput;
}

function stampSynthesis(logger: Logger, phase4Dossier: DossierV4Body, syn: CollectedSynthesis, phase2: Phase2Bundle): DossierV4Body {
    const next = structuredClone(phase4Dossier);

    if (syn.bullets.coverage === "available") {
        next.liability_summary.liability_bullets = syn.bullets.data.bullets.map((b) => ({ text: b.text, rationale: b.rationale, category: b.category }));
    }

    if (syn.flags.coverage === "available" && syn.flags.data.flags.length > 0) {
        next.safety_profile.target_organ_liabilities = syn.flags.data.flags;
    }

    const deterministicAll = deterministicTranslationalCommentary(phase2);
    const deterministicSorted = [...deterministicAll].sort((a, b) => {
        const order = { caution: 0, gap: 1, ok: 2 } as const;
        return order[a.severity] - order[b.severity];
    });
    const deterministic = deterministicSorted.slice(0, 4);
    const agentRows =
        syn.commentary.coverage === "available"
            ? syn.commentary.data.rows.slice(0, 4).map((r) => ({
                  severity: pickCommentarySeverity(r),
                  text: `${r.predicate}. ${r.commentary}`,
              }))
            : [];
    const allRows = [...deterministic, ...agentRows].slice(0, 8);
    if (allRows.length > 0) {
        next.reference_biology.preclinical.translational_commentary = {
            coverage: "available",
            data: { rows: allRows },
        };
    } else if (syn.commentary.coverage === "queried_no_data") {
        next.reference_biology.preclinical.translational_commentary = {
            coverage: "queried_no_data",
            error: syn.commentary.error,
        };
    }

    const recommendation: ExecutiveRecommendation =
        syn.recommendation.coverage === "available"
            ? {
                  coverage: "available",
                  data: sanitizeRecommendation(syn.recommendation.data),
              }
            : {
                  coverage: "queried_no_data",
                  error: syn.recommendation.error,
              };
    next.executive_recommendation = recommendation;

    if (syn.flags.coverage !== "available" && next.executive_recommendation.coverage === "available") {
        const qual = next.executive_recommendation.data.coverage_qualifier;
        if (qual) {
            if (!qual.sections_unavailable.includes("safety_profile.target_organ_liabilities")) {
                qual.sections_unavailable.push("safety_profile.target_organ_liabilities");
            }
            const errorKind = (syn.flags as { error?: { kind?: string } }).error?.kind ?? "unavailable";
            const annotation = `The deterministic safety-flag audit trail was not generated for this dossier (synthesis step \`safety-flags-trail\` failed with \`${errorKind}\`); the safety-bullet citations below are not anchored to a per-flag audit row.`;
            qual.note = qual.note ? `${annotation} ${qual.note}` : annotation;
        }
    }

    const diagnostics: SynthesisDiagnosticRow[] = [syn.bullets.diagnostic, syn.flags.diagnostic, syn.commentary.diagnostic, syn.recommendation.diagnostic];
    next.analytics.synthesis_diagnostics = {
        coverage: "available",
        data: { rows: diagnostics },
    };

    if (syn.recommendation.coverage === "available") {
        try {
            const audit = validateRecommendationCitations(syn.recommendation.data, next);
            if (audit.citations_unresolved.length > 0) {
                logger.warn("recommendation_audit: unresolved citation(s)", {
                    unresolvedCount: audit.citations_unresolved.length,
                    unresolved: audit.citations_unresolved,
                });
            }
            next.analytics.recommendation_audit = {
                coverage: "available",
                data: audit,
            };
        } catch (err) {
            next.analytics.recommendation_audit = {
                coverage: "queried_no_data",
                error: { message: err instanceof Error ? err.message : String(err) },
            };
        }
    }

    return next;
}

function applyCitationAuditDemotion(rec: ExecutiveRecommendationData, audit: RecommendationAudit): ExecutiveRecommendationData {
    const flagged = audit.citations_unresolved.filter((u) => u.surface === "organ_claim_without_probe_pass");
    if (flagged.length === 0) return rec;

    const flaggedExcerpts = flagged.map((f) => ("excerpt" in f ? (f as { excerpt: string }).excerpt : ""));

    const keptRisks: string[] = [];
    const demotedTexts = new Set<string>();
    for (const risk of rec.key_risks) {
        const isFlagged = flaggedExcerpts.some((excerpt) => excerpt.length > 0 && risk.includes(excerpt.slice(0, Math.min(80, excerpt.length))));
        if (isFlagged) {
            demotedTexts.add(risk);
        } else {
            keptRisks.push(risk);
        }
    }

    const unverified = flagged.map((f) => ({
        text:
            [...demotedTexts].find(
                (t) => "excerpt" in f && t.includes((f as { excerpt: string }).excerpt.slice(0, Math.min(80, (f as { excerpt: string }).excerpt.length))),
            ) ?? ("excerpt" in f ? (f as { excerpt: string }).excerpt : ""),
        bullet_category: (f as { bullet_category: string }).bullet_category,
        surface: "organ_claim_without_probe_pass" as const,
    }));

    return {
        ...rec,
        key_risks: keptRisks,
        coverage_qualifier: {
            ...rec.coverage_qualifier,
            unverified_bullets: unverified,
        },
    };
}

function rewriteNoLiabilitiesDisclosure(dossier: Record<string, unknown>): void {
    const ls = (dossier as { liability_summary?: Record<string, unknown> }).liability_summary;
    if (!ls) return;
    const bullets = Array.isArray((ls as { liability_bullets?: unknown[] }).liability_bullets)
        ? (ls as { liability_bullets: unknown[] }).liability_bullets
        : [];
    const current = String((ls as { no_liabilities_disclosure?: unknown }).no_liabilities_disclosure ?? "");
    if (current.startsWith("insufficient safety data")) return;
    const m = current.match(/(\d+) of 4 safety data sources returned data/);
    if (!m) return;
    const N = m[1];
    if (bullets.length === 0) {
        (ls as { no_liabilities_disclosure: string }).no_liabilities_disclosure =
            `${N} of 4 safety data sources returned data; no class-level liabilities synthesised`;
    } else {
        (ls as { no_liabilities_disclosure: string }).no_liabilities_disclosure =
            `${bullets.length} liabilities identified across ${N} of 4 safety data sources`;
    }
}

function resolveSection(dossier: Record<string, unknown>, path: string): { resolved: boolean; coverage?: string } {
    let cur: unknown = dossier;
    for (const part of path.split(".")) {
        if (cur == null || typeof cur !== "object") return { resolved: false };
        cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === undefined) return { resolved: false };
    const coverage =
        cur && typeof cur === "object" && typeof (cur as { coverage?: unknown }).coverage === "string" ? (cur as { coverage: string }).coverage : undefined;
    return { resolved: true, coverage };
}

function reconcileCoverageQualifier(dossier: Record<string, unknown>): void {
    const cq = (dossier as { executive_recommendation?: { data?: { coverage_qualifier?: { sections_unavailable?: unknown[] } } } }).executive_recommendation
        ?.data?.coverage_qualifier;
    if (!cq || !Array.isArray(cq.sections_unavailable)) return;
    cq.sections_unavailable = cq.sections_unavailable.filter((entry: unknown) => {
        const path = String(entry).split(" (")[0]!.trim();
        const { resolved, coverage } = resolveSection(dossier, path);
        if (!resolved) return false;
        return coverage !== "available";
    });
}

function makeUnknownAttribution(reason: string) {
    return {
        relationship: "unknown" as const,
        evidence_role: "excluded" as const,
        basis: [{ kind: "text_match" as const, source: "legacy-v4-upgrade" }],
        resolved_interventions: [],
        exclusion_reason: reason,
    };
}

type AttributionContext = {
    byNct: Map<string, unknown>;
    classifyOpts: {
        assessmentSymbol: string;
        assessmentUniprot: string;
        familyUniprots: string[];
        knownClassDrugs: KnownClassDrug[];
        therapeuticPrograms: TherapeuticProgram[];
    };
};

async function buildAttributionContext(
    phase2: Phase2Bundle,
    knownClassDrugsBase: Array<Omit<KnownClassDrug, "targetUniprots">>,
    therapeuticPrograms: TherapeuticProgram[],
): Promise<AttributionContext> {
    const ctgov =
        phase2.phase1.collectors.ctgov.coverage === "available"
            ? [...phase2.phase1.collectors.ctgov.data.active, ...phase2.phase1.collectors.ctgov.data.failed]
            : [];
    const assessmentUniprot = phase2.phase1.resolved.ids?.uniprot ?? "";
    const geneSymbol = phase2.phase1.resolved.geneSymbol ?? "";

    const [familyUniprots, resolvedDrugs] = await Promise.all([
        assessmentUniprot || geneSymbol ? resolveFamilySiblingUniprots(assessmentUniprot || geneSymbol) : Promise.resolve<string[]>([]),
        Promise.all(
            knownClassDrugsBase.map(async (drug) => {
                const resolved = drug.moleculeChemblId ? await getDrugPrimaryTargetUniprots(drug.moleculeChemblId).catch(() => []) : [];
                const targetUniprots = resolved.length > 0 ? resolved : assessmentUniprot ? [assessmentUniprot] : [];
                return { ...drug, targetUniprots };
            }),
        ),
    ]);

    return {
        byNct: new Map(ctgov.map((trial) => [trial.nctId, trial] as const)) as Map<string, unknown>,
        classifyOpts: {
            assessmentSymbol: geneSymbol,
            assessmentUniprot,
            familyUniprots,
            knownClassDrugs: resolvedDrugs,
            therapeuticPrograms,
        },
    };
}

function attachAttribution<T extends { nct_id: string }>(
    row: T,
    ctx: AttributionContext,
): T & { attribution: unknown; eligible_for_toxicology_aggregation: boolean } {
    const source = ctx.byNct.get(row.nct_id);
    const classified = source
        ? classifyClinicalEvidenceTrial(source as Parameters<typeof classifyClinicalEvidenceTrial>[0], ctx.classifyOpts)
        : {
              attribution: makeUnknownAttribution("No normalized CT.gov source row was available for this legacy row."),
              eligible_for_toxicology_aggregation: false,
          };
    return {
        ...row,
        attribution: classified.attribution,
        eligible_for_toxicology_aggregation: classified.eligible_for_toxicology_aggregation,
    };
}

function upgradeTrialRows<T extends { nct_id: string; title: string }>(rows: T[], ctx: AttributionContext): { rows: unknown[]; excluded_rows: unknown[] } {
    const kept: unknown[] = [];
    const excluded: unknown[] = [];
    for (const row of rows) {
        const upgraded = attachAttribution(row, ctx);
        if (upgraded.eligible_for_toxicology_aggregation) kept.push(upgraded);
        else excluded.push(upgraded);
    }
    return { rows: kept, excluded_rows: excluded };
}

function normalizeRegulatoryActionRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.map((row) => {
        if (row.source_kind) return row;
        const action_kind = row.action_kind as string | undefined;
        const agency = row.agency as string | undefined;
        const source_kind =
            action_kind === "black_box"
                ? "boxed_warning"
                : action_kind === "REMS"
                  ? "rems"
                  : action_kind === "withdrawal"
                    ? "withdrawal"
                    : agency === "EMA"
                      ? "referral"
                      : "label_warning";
        return {
            ...row,
            source_kind,
            action_kind: source_kind === "label_warning" && action_kind === "safety_communication" ? "label_warning" : action_kind,
            source_date: row.action_date,
        };
    });
}

async function upgradeDossierToV5(body: Record<string, unknown>, phase2: Phase2Bundle): Promise<DossierV5Body> {
    const next = structuredClone(body) as Record<string, unknown>;
    (next as { schema_version: string }).schema_version = "5";

    const drugInteractions = next.drug_interactions as { coverage: string; data?: { rows?: Array<Record<string, unknown>> } } | undefined;
    const knownClassDrugsBase: Array<Omit<KnownClassDrug, "targetUniprots">> =
        drugInteractions?.coverage === "available"
            ? (drugInteractions.data?.rows ?? []).map((row) => ({
                  name: String(row.drug_name ?? ""),
                  moleculeChemblId: (row.drug_id as string | null) ?? null,
              }))
            : [];
    const tpCollector = phase2.phase1.collectors.therapeuticPrograms;
    const therapeuticPrograms: TherapeuticProgram[] =
        tpCollector?.coverage === "available"
            ? tpCollector.data.programs.map((program) => ({
                  programId: program.programId,
                  name: program.name,
                  targetSymbol: program.targetSymbol,
                  targetUniprot: program.targetUniprot,
                  modality: program.modality,
                  nctIds: program.nctIds,
              }))
            : [];

    const attributionCtx = await buildAttributionContext(phase2, knownClassDrugsBase, therapeuticPrograms);

    const cd = next.clinical_development as
        | {
              trials?: { coverage: string; data: { rows: unknown[]; excluded_rows?: unknown[] } };
              failed_trials?: { coverage: string; data: { rows: unknown[]; excluded_rows?: unknown[] } };
              outcomes?: { coverage: string; data: { rows: unknown[] } };
          }
        | undefined;
    if (cd?.trials?.coverage === "available") {
        const upgraded = upgradeTrialRows(cd.trials.data.rows as Array<{ nct_id: string; title: string }>, attributionCtx);
        cd.trials.data.rows = upgraded.rows;
        cd.trials.data.excluded_rows = [...(cd.trials.data.excluded_rows ?? []), ...upgraded.excluded_rows];
    }
    if (cd?.failed_trials?.coverage === "available") {
        const upgraded = upgradeTrialRows(cd.failed_trials.data.rows as Array<{ nct_id: string; title: string }>, attributionCtx);
        cd.failed_trials.data.rows = upgraded.rows;
        cd.failed_trials.data.excluded_rows = [...(cd.failed_trials.data.excluded_rows ?? []), ...upgraded.excluded_rows];
    }
    if (cd?.outcomes?.coverage === "available") {
        cd.outcomes.data.rows = (cd.outcomes.data.rows as Array<{ nct_id: string }>).map((row) => attachAttribution(row, attributionCtx));
    }

    const analytics = next.analytics as
        | {
              discovery_trials?: {
                  coverage: string;
                  data: { rows: unknown[]; excluded_rows?: unknown[]; related_target_trials?: unknown; related_receptor?: unknown };
              };
              quality_gates?: { coverage: string; data: { rows: unknown[] } };
          }
        | undefined;
    if (analytics?.discovery_trials?.coverage === "available") {
        const upgraded = upgradeTrialRows(analytics.discovery_trials.data.rows as Array<{ nct_id: string; title: string }>, attributionCtx);
        analytics.discovery_trials.data.rows = upgraded.rows;
        analytics.discovery_trials.data.excluded_rows = [...(analytics.discovery_trials.data.excluded_rows ?? []), ...upgraded.excluded_rows];
        delete analytics.discovery_trials.data.related_target_trials;
        delete analytics.discovery_trials.data.related_receptor;
    }

    const sp = next.safety_profile as { regulatory_actions?: { coverage: string; data: { rows: Array<Record<string, unknown>> } } } | undefined;
    const regulatory = sp?.regulatory_actions;
    if (regulatory?.coverage === "available") {
        regulatory.data.rows = normalizeRegulatoryActionRows(regulatory.data.rows ?? []);
    }

    (next.analytics as Record<string, unknown>).quality_gates ??= {
        coverage: "available",
        data: { rows: [] },
    };

    return next as unknown as DossierV5Body;
}

// ── Pure-function entry point ────────────────────────────────────────

/**
 * Run Phase-5 persist as a pure function. Returns the validated v5
 * dossier (and computed bytes) on success. Throws
 * `DossierDerivedInvariantError` when `computeDerivedFields` rejects the
 * dossier; throws `DossierSchemaViolationError` when the v5 schema
 * rejects the final dossier.
 */
export async function phase5Persist(input: Phase5PersistInput): Promise<Phase5PersistResult> {
    const logger = (input.logger ?? createNoopLogger()).named("phase5-persist").with({ assessmentId: input.assessmentId });
    // The dossier rides through this function as an untyped working blob; the
    // `as unknown as DossierV{4,5}Body` casts below are version-shim views that
    // let the typed helpers operate on it. None of these casts is load-bearing
    // for soundness: `DossierV5Schema.safeParse(fullDossier)` at the end is the
    // single validation gate, and it throws before anything is returned.
    let dossier: Record<string, unknown> = stampSynthesis(logger, input.phase4Dossier, input.synthesis, input.phase2) as unknown as Record<string, unknown>;

    // Demote organ-claim flagged bullets into coverage_qualifier.unverified_bullets.
    const exec = dossier.executive_recommendation as { coverage: string; data?: ExecutiveRecommendationData } | undefined;
    if (exec?.coverage === "available") {
        const audit = (dossier.analytics as { recommendation_audit?: { data?: RecommendationAudit } }).recommendation_audit?.data;
        if (audit && exec.data) {
            (dossier.executive_recommendation as { data: ExecutiveRecommendationData }).data = applyCitationAuditDemotion(exec.data, audit);
        }
    }

    reconcileCoverageQualifier(dossier);
    rewriteNoLiabilitiesDisclosure(dossier);
    dossier = (await upgradeDossierToV5(dossier, input.phase2)) as unknown as Record<string, unknown>;

    const recommendationAudit = (dossier.analytics as { recommendation_audit?: { data?: RecommendationAudit } }).recommendation_audit?.data;
    const synthesisDiagnostics =
        (dossier.analytics as { synthesis_diagnostics?: { coverage: string; data?: { rows: SynthesisDiagnosticRow[] } } }).synthesis_diagnostics?.coverage ===
        "available"
            ? (dossier.analytics as { synthesis_diagnostics: { data: { rows: SynthesisDiagnosticRow[] } } }).synthesis_diagnostics.data.rows
            : [];
    const trials = (dossier.clinical_development as { trials?: { coverage: string; data: { rows: Array<{ eligible_for_toxicology_aggregation?: boolean }> } } })
        .trials;
    const hasDirectClinicalEvidence =
        trials?.coverage === "available" && (trials.data.rows ?? []).some((row) => row.eligible_for_toxicology_aggregation === true);

    const gated = applyRecommendationQualityGates({
        executive_recommendation: dossier.executive_recommendation as ExecutiveRecommendation,
        synthesis_diagnostics: synthesisDiagnostics,
        recommendation_audit: recommendationAudit,
        has_direct_clinical_evidence: hasDirectClinicalEvidence,
    });
    dossier.executive_recommendation = gated.executive_recommendation;
    const qg = (dossier.analytics as { quality_gates?: { data?: { rows?: unknown[] } } }).quality_gates;
    (dossier.analytics as { quality_gates: { coverage: string; data: { rows: unknown[] } } }).quality_gates = {
        coverage: "available",
        data: {
            rows: [...((qg?.data?.rows ?? []) as unknown[]), ...gated.quality_gates],
        },
    };

    let bytes = approximateSize(dossier as unknown as DossierV4Body);
    if (bytes > SOFT_CAP_BYTES) {
        dossier = truncateOversize(dossier as unknown as DossierV4Body) as unknown as Record<string, unknown>;
        bytes = approximateSize(dossier as unknown as DossierV4Body);
    }

    let derived: ReturnType<typeof computeDerivedFields>;
    try {
        derived = computeDerivedFields(dossier as unknown as DossierV5Body);
    } catch (err) {
        throw new DossierDerivedInvariantError(err instanceof Error ? err.message : String(err), err);
    }

    const fullDossier = { ...dossier, derived } as Record<string, unknown>;

    const structuralConflicts = detectStructuralEvidenceConflicts(fullDossier as unknown as DossierV5Body);
    if (structuralConflicts.length > 0) {
        const existing = (fullDossier.analytics as { evidence_conflicts?: { coverage: string; data?: { rows?: unknown[] } } }).evidence_conflicts;
        const existingRows = existing?.coverage === "available" ? (existing.data?.rows ?? []) : [];
        (fullDossier.analytics as { evidence_conflicts: { coverage: string; data: { rows: unknown[] } } }).evidence_conflicts = {
            coverage: "available",
            data: { rows: [...existingRows, ...structuralConflicts] },
        };
    }

    const parsed = DossierV5Schema.safeParse(fullDossier);
    if (!parsed.success) {
        throw new DossierSchemaViolationError("Dossier failed v5 schema validation", parsed.error.issues);
    }

    return {
        assessmentId: input.assessmentId,
        dossier: parsed.data as unknown as Record<string, unknown>,
        bytes,
    };
}
