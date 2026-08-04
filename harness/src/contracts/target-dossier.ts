/**
 * Target Dossier — schema-driven document produced by the
 * `executeTargetAssessment` workflow and rendered by the frontend.
 *
 * Single source of truth for the persisted JSONB shape and the rendered
 * UI shape. Both Cortex and the frontend import from this module.
 *
 * Coverage discipline: every section that depends on enrichment data
 * carries a `coverage` discriminator (`available | queried_no_data |
 * not_loaded`). Sections that fall back to inference also carry an
 * `inference_path`. Aggregate rows preserve their contributing evidence
 * under `evidence: [...]` arrays; rows that assert a liability carry it
 * under `support`.
 *
 * See `TARGET_DOSSIER.md` for the full editorial specification.
 */

import { z } from "zod";

import { OrganSystemSchema } from "./organ-system.js";
import { SeveritySchema } from "./severity.js";

// ── Coverage primitives ─────────────────────────────────────────────

export const CoverageSchema = z.enum(["available", "queried_no_data", "not_loaded", "filtered"]);
export type Coverage = z.infer<typeof CoverageSchema>;

/**
 * Coverage states a per-row marker can take.
 *
 * `filtered` is a section-level outcome only: a filter that removes a row
 * removes the row, so a row that survived to be read can never report it.
 * Derived from the section vocabulary rather than restated, so the two
 * cannot drift into separate lists.
 */
export const RowCoverageSchema = CoverageSchema.exclude(["filtered"]);
export type RowCoverage = z.infer<typeof RowCoverageSchema>;

const CoverageError = z.object({
    message: z.string(),
    source: z.string().optional(),
});

/**
 * Build a discriminated section schema: when `coverage` is `available`,
 * `data` is required and matches the inner schema. Otherwise `data` is
 * absent and an optional `error` payload may be present.
 *
 * `dropped_count` rides on the `available` branch as well as the `filtered`
 * one because a filter that removes some rows still leaves a section whose
 * list is partial — without it, a section that discarded most of its rows
 * reports a clean `available` and overstates its own completeness.
 */
function withCoverage<T extends z.ZodTypeAny>(data: T) {
    return z.discriminatedUnion("coverage", [
        z.object({
            coverage: z.literal("available"),
            data,
            dropped_count: z.number().int().nonnegative().optional(),
            inference_path: z.string().optional(),
            truncated: z.boolean().optional(),
        }),
        z.object({
            coverage: z.literal("queried_no_data"),
            error: CoverageError.optional(),
            inference_path: z.string().optional(),
        }),
        z.object({
            coverage: z.literal("filtered"),
            filter: z.string(),
            dropped_count: z.number().int().nonnegative(),
            inference_path: z.string().optional(),
        }),
        z.object({
            coverage: z.literal("not_loaded"),
            reason: z.string().optional(),
        }),
    ]);
}

// ── Section blurbs (renderer source of truth) ───────────────────────

export const SECTION_BLURBS = {
    entity: "Canonical identity for the assessed target, including ontology, identifiers, and synonyms.",
    safety_profile:
        "Per-organ liabilities derived from genetic, expression, FAERS, and class-precedent evidence. Each row carries an audit trail and a mechanism hypothesis where supportable.",
    therapeutic_area_associations:
        "Disease and therapeutic-area associations from genetics, literature, and Open Targets evidence rows; intended as orientation for indication selection.",
    indications: "Candidate indications ranked by combined evidence weight; each row carries the contributing evidence sources.",
    clinical_development: "Active and completed trials of modulators of this target, indexed from ClinicalTrials.gov.",
    reference_biology: "Preclinical biology, expression, KO phenotype, and PPI context supporting the target's mechanistic basis.",
    executive_recommendation: "Disposition (pursue / conditional / de-prioritize / insufficient evidence) with cited rationale, key strengths, and key risks.",
} as const;

export type SectionBlurbKey = keyof typeof SECTION_BLURBS;

// ── Shared evidence primitives ──────────────────────────────────────

export const EvidenceItemSchema = z.object({
    pmid: z.string().optional(),
    doi: z.string().optional(),
    accession: z.string().optional(),
    source: z.string(),
    predicate: z.string().optional(),
    score: z.number().optional(),
    strength: z.string().optional(),
    is_human: z.boolean().optional(),
    is_clinical: z.boolean().optional(),
    excerpt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    regulatory_reference: z
        .object({
            document: z.string(),
            section: z.string().optional(),
            doc_id: z.string().optional(),
            doc_url: z.string().url().optional(),
        })
        .optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

const EvidenceList = z.array(EvidenceItemSchema);

/**
 * Evidence attached to a claim, which must resolve to something a reader can
 * actually go and check. `source` alone names a provenance bucket, not a
 * record, so it does not qualify on its own.
 *
 * The constraint lives here rather than on `EvidenceItemSchema` because that
 * shape is shared with sections whose producers legitimately carry looser
 * evidence; tightening it globally would break them, and loosening the claim
 * to match them would defeat the point.
 */
export const ClaimEvidenceSchema = EvidenceItemSchema.refine((e) => Boolean(e.pmid ?? e.doi ?? e.accession ?? e.regulatory_reference), {
    message: "claim evidence needs a locator: pmid, doi, accession, or regulatory_reference",
});
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

/**
 * What backs a claim: either evidence, or a stated reason there is none.
 *
 * Discriminating on `state` — rather than making `evidence` nullable and
 * checking it at runtime — is what makes a scored claim with no evidence
 * unconstructable rather than merely invalid. `unknown` is a complete,
 * first-class outcome: an invariant that is harder to satisfy honestly than
 * dishonestly makes the data worse, not better.
 */
export const ClaimSupportSchema = z.discriminatedUnion("state", [
    z.object({
        state: z.literal("scored"),
        evidence: z.array(ClaimEvidenceSchema).min(1),
    }),
    z.object({
        state: z.literal("unknown"),
        reason: z.string().min(1),
    }),
]);
export type ClaimSupport = z.infer<typeof ClaimSupportSchema>;

/**
 * Attach support to a claim body.
 *
 * The support rides as a field rather than wrapping the body, because these
 * rows *are* the assertion: a reader of an unevidenced liability still needs
 * the liability. Swapping the body out on the unknown branch would leave
 * nothing to read.
 */
function withEvidence<T extends z.ZodRawShape>(body: z.ZodObject<T>) {
    return body.extend({ support: ClaimSupportSchema });
}

// ── §1.1 Entity ─────────────────────────────────────────────────────

export const EntitySchema = z.object({
    canonicalId: z.string(),
    symbol: z.string(),
    displayName: z.string(),
    /**
     * Cortex's Phase-0 resolver only emits `"gene"`. The schema keeps the
     * broader enum so protein-, rna- and complex-level entities are
     * expressible once the resolver supports them.
     */
    entityType: z.enum(["gene", "protein", "rna", "complex"]),
    ontology: z.string(),
    identifiers: z.object({
        hgnc: z.string().optional(),
        ensembl: z.string().optional(),
        uniprot: z.string().optional(),
        chembl: z.string().optional(),
        ncbiGene: z.string().optional(),
    }),
    synonyms: z.array(z.string()).default([]),
    proteinFamily: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

// ── §2.1 Liability summary ──────────────────────────────────────────

/**
 * The assertion a liability bullet makes, without its support.
 *
 * Named separately because a dropped bullet records the same assertion
 * plus the reason it was dropped, and carries no support of its own.
 */
export const LiabilityBulletBodySchema = z.object({
    text: z.string(),
    rationale: z.string(),
    category: z.enum(["fatal_post_market", "class_liability", "off_target_safety", "high_safety_organ_expression", "broad_expression", "other"]),
});

export const LiabilityBulletSchema = withEvidence(LiabilityBulletBodySchema);
export type LiabilityBullet = z.infer<typeof LiabilityBulletSchema>;

/**
 * Liability bullets removed post-synthesis because they cited a PMID the
 * direction-of-effect auditor found contradicts the bullet's framing.
 * Mirrors `executive_recommendation.key_risks_dropped` — the dropped
 * content is preserved with the reason for an audit trail.
 */
export const LiabilityBulletDroppedSchema = LiabilityBulletBodySchema.extend({
    reason: z.string(),
    cited_pmid: z.string().optional(),
});
export type LiabilityBulletDropped = z.infer<typeof LiabilityBulletDroppedSchema>;

/** `.strict()` rejects the derived counters, which live in the derived sub-tree. */
export const LiabilitySummarySchema = z
    .object({
        liability_bullets: z.array(LiabilityBulletSchema),
        liability_bullets_dropped: z.array(LiabilityBulletDroppedSchema).optional(),
        modality_recommendation: z.string().nullable(),
        same_class_drug_count: z.number().int().nonnegative(),
        inferred_therapeutic_area: z.string().nullable(),
        no_liabilities_disclosure: z.string().optional(),
    })
    .strict();
export type LiabilitySummary = z.infer<typeof LiabilitySummarySchema>;

// ── §2.2 Tractability ───────────────────────────────────────────────

export const TractabilityModalitySchema = z.object({
    /**
     * Phase-4 emits `small_molecule`, `antibody`, and `other_clinical`. The
     * remaining variants belong to the Phase-2 modality fallback (PROTAC,
     * oligonucleotide, peptide libraries).
     */
    modality: z.enum(["small_molecule", "antibody", "protac", "other_clinical", "oligonucleotide", "peptide"]),
    levels: z.array(z.string()),
    has_approved_drug: z.boolean(),
    has_clinical_stage: z.boolean(),
    is_inferred_from_family: z.boolean(),
    approved_drug_ids: z.array(z.string()).optional(),
    note: z.string().optional(),
});

const MOLECULE_TYPE_TO_MODALITY: Record<string, string[]> = {
    Protein: ["peptide", "antibody"],
    "Small molecule": ["small_molecule"],
    Oligonucleotide: ["oligonucleotide"],
};

export const TractabilitySchema = withCoverage(
    z
        .object({
            modalities: z.array(TractabilityModalitySchema),
            preferred_modality: z.string().nullable(),
            drug_molecule_types_present: z.array(z.string()).default([]),
        })
        .superRefine((v, ctx) => {
            for (const moleculeType of v.drug_molecule_types_present) {
                const allowed = MOLECULE_TYPE_TO_MODALITY[moleculeType];
                if (!allowed) continue; // unknown molecule_type — skip rather than block
                const hasMatching = v.modalities.some((m) => allowed.includes(m.modality) && !m.is_inferred_from_family);
                if (!hasMatching) {
                    ctx.addIssue({
                        code: "custom",
                        message: `drug molecule_type "${moleculeType}" has no matching enumerated modality row`,
                        path: ["modalities"],
                    });
                }
            }
        }),
);
export type TractabilitySection = z.infer<typeof TractabilitySchema>;

// ── §2.3 Indications ────────────────────────────────────────────────

export const IndicationRowSchema = z.object({
    disease_id: z.string(),
    disease_name: z.string(),
    composite_score: z.number(),
    composite_score_breakdown: z
        .object({
            base: z.number(),
            source_bonuses: z.record(z.string(), z.number()),
            paper_depth: z.number(),
        })
        .optional(),
    evidence_score: z.number(),
    source_count: z.number().int().nonnegative(),
    unique_paper_count: z.number().int().nonnegative(),
    sources: z.array(z.string()),
    evidence: EvidenceList,
});

export const IndicationsSchema = withCoverage(
    z.object({
        rows: z.array(IndicationRowSchema),
        excluded_unsupported_count: z.number().int().nonnegative().optional(),
        unsupported_associations: z
            .array(
                z.object({
                    disease_id: z.string(),
                    disease_name: z.string(),
                }),
            )
            .optional(),
    }),
);

// ── §2.4 Drug interactions ──────────────────────────────────────────

export const DrugInteractionRowSchema = z.object({
    drug_id: z.string().nullable(),
    drug_name: z.string(),
    best_score: z.number(),
    predicates: z.array(z.string()),
    sources: z.array(z.string()),
    paper_count: z.number().int().nonnegative(),
    dominant_direction: z.enum(["positive", "negative", "mixed", "unknown"]),
    has_human_evidence: z.boolean(),
    has_clinical_evidence: z.boolean(),
    evidence: EvidenceList,
});

export const DrugInteractionsSchema = withCoverage(z.object({ rows: z.array(DrugInteractionRowSchema) }));

// ── §2.5 Clinical development ───────────────────────────────────────

export const ClinicalTrialAttributionBasisSchema = z.object({
    kind: z.enum([
        "mechanism_target_match",
        "known_class_drug",
        "therapeutic_program_match",
        "related_family_target",
        "biomarker_endpoint",
        "condition_only",
        "text_match",
        "manual",
    ]),
    source: z.string(),
    excerpt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ClinicalTrialAttributionBasis = z.infer<typeof ClinicalTrialAttributionBasisSchema>;

export const ResolvedTrialInterventionSchema = z.object({
    name: z.string(),
    intervention_type: z.string().nullable().optional(),
    chembl_id: z.string().nullable().optional(),
    therapeutic_program_id: z.string().nullable().optional(),
    target_uniprots: z.array(z.string()).default([]),
    resolver_source: z.string(),
});
export type ResolvedTrialIntervention = z.infer<typeof ResolvedTrialInterventionSchema>;

export const ClinicalTrialAttributionSchema = z
    .object({
        relationship: z.enum([
            "direct_modulator",
            "class_modulator",
            "related_family_target",
            "target_biomarker",
            "pathway_biomarker",
            "condition_only",
            "unrelated",
            "unknown",
        ]),
        evidence_role: z.enum(["supports_target", "contextual", "excluded"]),
        basis: z.array(ClinicalTrialAttributionBasisSchema).min(1),
        resolved_interventions: z.array(ResolvedTrialInterventionSchema).default([]),
        exclusion_reason: z.string().optional(),
    })
    .superRefine((v, ctx) => {
        if (v.evidence_role !== "supports_target" && !v.exclusion_reason) {
            ctx.addIssue({
                code: "custom",
                message: "contextual/excluded trial evidence requires exclusion_reason",
                path: ["exclusion_reason"],
            });
        }
        if (v.evidence_role === "supports_target" && v.relationship !== "direct_modulator" && v.relationship !== "class_modulator") {
            ctx.addIssue({
                code: "custom",
                message: "supports_target evidence must be direct_modulator or class_modulator",
                path: ["relationship"],
            });
        }
    });
export type ClinicalTrialAttribution = z.infer<typeof ClinicalTrialAttributionSchema>;

export const ClinicalTrialRowSchema = z.object({
    nct_id: z.string(),
    title: z.string(),
    phase: z.string().nullable(),
    status: z.string(),
    conditions: z.array(z.string()),
    start_date: z.string().nullable(),
    completion_date: z.string().nullable(),
    match_confidence: z.enum(["high", "medium", "low", "off_target"]),
    attribution: ClinicalTrialAttributionSchema,
    eligible_for_toxicology_aggregation: z.boolean(),
});
export type ClinicalTrialRow = z.infer<typeof ClinicalTrialRowSchema>;

export const TrialOutcomeRowSchema = z.object({
    nct_id: z.string(),
    measure: z.string(),
    outcome_type: z.enum(["primary", "secondary", "other"]),
    description: z.string().optional(),
    time_frame: z.string().optional(),
    effect: z.discriminatedUnion("kind", [
        z.object({
            kind: z.literal("quantitative"),
            value: z.number(),
            ci_low: z.number().optional(),
            ci_high: z.number().optional(),
            units: z.string(),
        }),
        z.object({
            kind: z.literal("qualitative"),
            direction: z.enum(["increase", "decrease", "no_change"]),
            magnitude_label: z.string(),
        }),
        z.object({
            kind: z.literal("not_extracted"),
            reason: z.enum(["ctgov_no_numeric_result", "ctgov_no_result_groups", "parse_failure"]),
        }),
    ]),
    attribution: ClinicalTrialAttributionSchema.optional(),
    eligible_for_toxicology_aggregation: z.boolean().default(false),
});
export type TrialOutcomeRow = z.infer<typeof TrialOutcomeRowSchema>;

const FailureCategorySchema = z.discriminatedUnion("category", [
    z.object({ category: z.literal("safety"), safety_evidence_excerpt: z.string() }),
    z.object({ category: z.literal("strategic"), category_evidence_excerpt: z.string() }),
    z.object({ category: z.literal("operational"), category_evidence_excerpt: z.string() }),
    z.object({ category: z.literal("efficacy"), category_evidence_excerpt: z.string() }),
]);

export const FailedTrialRowSchema = z
    .object({
        nct_id: z.string(),
        title: z.string(),
        why_stopped: z.string(),
        classifier: z.enum(["rules", "llm"]),
        failure_category: FailureCategorySchema,
        attribution: ClinicalTrialAttributionSchema,
        eligible_for_toxicology_aggregation: z.boolean(),
    })
    .superRefine((v, ctx) => {
        const excerpt =
            "safety_evidence_excerpt" in v.failure_category ? v.failure_category.safety_evidence_excerpt : v.failure_category.category_evidence_excerpt;
        // CT.gov sometimes terminates trials without recording a `whyStopped`
        // reason. In that case the assembler emits `why_stopped: ""` with
        // `category: "operational"` and `excerpt: ""` — there's nothing to
        // classify and nothing to excerpt. Both being empty is the valid
        // "no recorded reason" shape; mismatched emptiness is an error.
        const whyEmpty = v.why_stopped.length === 0;
        const excerptEmpty = excerpt.length === 0;
        if (whyEmpty !== excerptEmpty) {
            ctx.addIssue({
                code: "custom",
                message: whyEmpty
                    ? `failure_category evidence_excerpt is non-empty but why_stopped is empty`
                    : `failure_category evidence_excerpt is empty but why_stopped is non-empty`,
                path: ["failure_category"],
            });
            return;
        }
        if (whyEmpty) return;
        if (!v.why_stopped.toLowerCase().includes(excerpt.toLowerCase())) {
            ctx.addIssue({
                code: "custom",
                message: `failure_category evidence_excerpt is not a substring of why_stopped`,
                path: ["failure_category"],
            });
        }
    });
export type FailedTrialRow = z.infer<typeof FailedTrialRowSchema>;

export const ClinicalBenchmarksSchema = z.object({
    therapeutic_area: z.string().nullable(),
    fallback_to_all_areas: z.boolean(),
    phase_transitions: z.record(z.string(), z.number()),
    likelihood_of_approval: z.number().nullable(),
    source_attribution: z.string(),
});

export const ClinicalDevelopmentSchema = z.object({
    trials: withCoverage(
        z.object({
            rows: z.array(ClinicalTrialRowSchema),
            excluded_rows: z.array(ClinicalTrialRowSchema).default([]),
            selection_criteria: z
                .object({
                    derived_from: z.string().optional(),
                    min_confidence: z.string().optional(),
                    excluded_off_target_count: z.number().int().nonnegative().optional(),
                })
                .optional(),
        }),
    ),
    outcomes: withCoverage(z.object({ rows: z.array(TrialOutcomeRowSchema) })),
    failed_trials: withCoverage(
        z.object({
            rows: z.array(FailedTrialRowSchema),
            excluded_rows: z.array(FailedTrialRowSchema).default([]),
        }),
    ),
    benchmarks: ClinicalBenchmarksSchema,
});
export type ClinicalDevelopment = z.infer<typeof ClinicalDevelopmentSchema>;

// ── §2.6 Safety profile ─────────────────────────────────────────────

export const OrganRiskRowSchema = z.object({
    organ: OrganSystemSchema,
    risk_level: z.enum(["high", "medium", "low"]),
    signal_type_count: z.number().int().nonnegative(),
    signals: z.object({
        chembl_polypharm_count: z.number().int().nonnegative(),
        faers_count: z.number().int().nonnegative(),
        trial_ae_count: z.number().int().nonnegative(),
        class_liability_present: z.boolean(),
    }),
    evidence: EvidenceList,
});
export type OrganRiskRow = z.infer<typeof OrganRiskRowSchema>;

const SeriousnessAvailableSchema = z
    .object({
        coverage: z.literal("available"),
        total_reports: z.number().int().nonnegative(),
        by_seriousness: z.object({
            death: z.number().int().nonnegative(),
            life_threatening: z.number().int().nonnegative(),
            hospitalization: z.number().int().nonnegative(),
            disabling: z.number().int().nonnegative(),
            other_serious: z.number().int().nonnegative(),
            congenital_anomaly: z.number().int().nonnegative(),
        }),
        fatal_report_count: z.number().int().nonnegative(),
    })
    .superRefine((v, ctx) => {
        // NOTE: by_seriousness categories are independent binary flags on
        // each FAERS report — a single fatal hospitalisation increments
        // both `death` and `hospitalization` — so sum(by_seriousness) can
        // legitimately exceed total_reports. Do not invariant on the sum.
        if (v.fatal_report_count > v.by_seriousness.death) {
            ctx.addIssue({
                code: "custom",
                message: `fatal_report_count=${v.fatal_report_count} exceeds by_seriousness.death=${v.by_seriousness.death}`,
                path: ["fatal_report_count"],
            });
        }
        const sum =
            v.by_seriousness.death +
            v.by_seriousness.life_threatening +
            v.by_seriousness.hospitalization +
            v.by_seriousness.disabling +
            v.by_seriousness.other_serious +
            v.by_seriousness.congenital_anomaly;
        if (v.total_reports > 1000 && sum === 0) {
            ctx.addIssue({
                code: "custom",
                message: `seriousness is all-zero across ${v.total_reports} reports; emit coverage:"queried_no_data" instead of fabricated zeros`,
                path: ["by_seriousness"],
            });
        }
    });

const SeriousnessQueriedNoDataSchema = z.object({
    coverage: z.literal("queried_no_data"),
    total_reports: z.number().int().nonnegative(),
});

export const FaersSummarySchema = z.object({
    total_reports: z.number().int().nonnegative(),
    seriousness: z.discriminatedUnion("coverage", [SeriousnessAvailableSchema, SeriousnessQueriedNoDataSchema]),
    top_signals: z.array(
        z.object({
            meddra_term: z.string(),
            organ: z.string().optional(),
            report_count: z.number().int().nonnegative(),
            proportional_reporting_ratio: z.number().optional(),
        }),
    ),
    per_modulator: z.array(
        z.object({
            modulator: z.string(),
            modulator_id: z.string().nullable(),
            report_count: z.number().int().nonnegative(),
            coverage: RowCoverageSchema,
        }),
    ),
});

export const TrialAesSchema = z.object({
    serious: z.array(
        z.object({
            term: z.string(),
            incidence_pct: z.number(),
            organ: z.string().optional(),
            nct_ids: z.array(z.string()),
        }),
    ),
    non_serious: z.array(
        z.object({
            term: z.string(),
            incidence_pct: z.number(),
            organ: z.string().optional(),
            nct_ids: z.array(z.string()),
        }),
    ),
    /** Floor pct for non-serious AEs, low enough to keep real low-incidence AEs. */
    non_serious_floor_pct: z.number().nonnegative().default(2),
    /**
     * Count of rows dropped by the catch-all-bucket filter (e.g., "Other"
     * term or term equal to organ system). Surfaced for auditability.
     */
    dropped_uninformative_count: z.number().int().nonnegative().optional(),
    coverage_qualifier: z
        .object({
            trials_queried: z.number().int().nonnegative(),
            trials_with_ae_data: z.number().int().nonnegative(),
            serious_floor_applied: z.number().optional(),
            non_serious_floor_pct_applied: z.number().optional(),
        })
        .optional(),
});

const SelectivitySchema = z.union([
    z.object({
        vs_primary_potency: z.object({
            primary_pchembl_used: z.number(),
            primary_source: z.enum(["chembl_target_drug_indication", "literature_curated"]),
            fold: z.number().positive().finite(),
            log_units: z.number(),
        }),
    }),
    z.object({
        selectivity_unknown: z.literal(true),
        reason: z.string().min(1),
    }),
]);

/**
 * The measured facts about an off-target hit, shared by the rows that
 * assert a liability and the rows that record why one was set aside.
 */
export const OffTargetRowBodySchema = z.object({
    off_target_id: z.string().nullable(),
    off_target_name: z.string(),
    target_class: z.string().optional(),
    pchembl: z.number(),
    is_safety_panel_target: z.boolean(),
    organ_system: OrganSystemSchema.nullable(),
    clinical_consequence: z.string().nullable(),
    selectivity: SelectivitySchema,
    selectivity_window_below_threshold: z.boolean(),
    metadata: z.object({ merged_chembl_ids: z.array(z.string()).optional() }).optional(),
});

/** The claim's own evidence rides in `support`, so the row carries no second evidence list. */
export const OffTargetRowSchema = withEvidence(OffTargetRowBodySchema.extend({ relationship: z.literal("off_target") }));
export type OffTargetRow = z.infer<typeof OffTargetRowSchema>;

/**
 * Excluded rows record why something was set aside rather than asserting a
 * liability, so they carry evidence without the claim contract.
 */
export const ExcludedOffTargetRowSchema = OffTargetRowBodySchema.extend({
    relationship: z.enum(["intended_co_target", "on_target_self_hit", "obligate_cofactor"]),
    reason: z.string().min(1),
    evidence: EvidenceList,
});
export type ExcludedOffTargetRow = z.infer<typeof ExcludedOffTargetRowSchema>;

export const OffTargetPanelSchema = z.object({
    rows: z.array(OffTargetRowSchema),
    excluded_rows: z.array(ExcludedOffTargetRowSchema),
});

export const ClassLiabilityOrganSchema = z.object({
    organ: OrganSystemSchema,
    drug_count_in_class: z.number().int().nonnegative(),
    drugs_with_signal: z.number().int().nonnegative(),
    signal_fraction: z.number(),
    is_class_liability: z.boolean(),
    suppressed_reason: z.string().nullable(),
    top_aes: z.array(
        z.object({
            term: z.string(),
            report_count: z.number().int().nonnegative(),
        }),
    ),
});

export const ClassPrecedentSchema = z.object({
    drugs_in_class: z.array(
        z.object({
            drug_id: z.string().nullable(),
            drug_name: z.string(),
            max_phase: z.number().int(),
            mechanism: z.string().optional(),
        }),
    ),
    per_organ: z.array(ClassLiabilityOrganSchema),
});

export const SafetyFlagSchema = withEvidence(
    z.object({
        organ: OrganSystemSchema,
        trail: z.string(),
        mechanism_hypothesis: z.string().nullable().optional(),
        severity: SeveritySchema,
    }),
);
export type SafetyFlag = z.infer<typeof SafetyFlagSchema>;

export const RegulatoryActionRowSchema = z
    .object({
        drug_chembl_id: z.string(),
        drug_name: z.string(),
        agency: z.enum(["FDA", "EMA", "MHRA", "PMDA", "Health Canada", "TGA"]),
        action_kind: z.enum(["referral", "withdrawal", "indication_restriction", "REMS", "black_box", "DHCP", "safety_communication", "label_warning"]),
        action_date: z.string(),
        finding: z.string(),
        source_url: z.string().url().optional(),
        source_kind: z.enum(["label_warning", "referral", "rems", "withdrawal", "boxed_warning", "safety_communication"]),
        application_number: z.string().optional(),
        label_section: z.string().optional(),
        source_date: z.string().optional(),
        evidence: EvidenceList,
    })
    .superRefine((v, ctx) => {
        if (v.source_kind === "label_warning" && v.action_kind === "safety_communication") {
            ctx.addIssue({
                code: "custom",
                message: "FDA label warnings must not be represented as action_kind:safety_communication",
                path: ["action_kind"],
            });
        }
    });
export type RegulatoryActionRow = z.infer<typeof RegulatoryActionRowSchema>;

export const SafetyProfileSchema = z.object({
    organ_rollup: withCoverage(z.object({ rows: z.array(OrganRiskRowSchema) })),
    faers: withCoverage(FaersSummarySchema),
    trial_aes: withCoverage(TrialAesSchema),
    off_target_panel: withCoverage(OffTargetPanelSchema),
    failed_trials_safety_lens: withCoverage(z.object({ rows: z.array(FailedTrialRowSchema) })),
    class_precedent: withCoverage(ClassPrecedentSchema),
    target_organ_liabilities: withCoverage(z.object({ rows: z.array(SafetyFlagSchema) })),
    regulatory_actions: withCoverage(z.object({ rows: z.array(RegulatoryActionRowSchema) })).optional(),
});
export type SafetyProfile = z.infer<typeof SafetyProfileSchema>;

// ── §2.7 Off-tissue risk ────────────────────────────────────────────

export const OffTissueRowSchema = withEvidence(
    z.object({
        tissue: z.string(),
        organ: OrganSystemSchema,
        tpm: z.number(),
    }),
);
export type OffTissueRow = z.infer<typeof OffTissueRowSchema>;

export const OffTissueRiskSchema = withCoverage(z.object({ rows: z.array(OffTissueRowSchema) }));

// ── §3.1–3.6 Reference biology — keyed evidence sections ────────────

export const KeyedEvidenceRowSchema = z.object({
    partner_id: z.string().nullable(),
    partner_name: z.string(),
    predicate: z.string(),
    best_score: z.number(),
    source_count: z.number().int().nonnegative(),
    paper_count: z.number().int().nonnegative(),
    evidence: EvidenceList,
});

export const DiseaseAssociationsSchema = withCoverage(z.object({ rows: z.array(KeyedEvidenceRowSchema) }));

export const MolecularInteractionsSchema = withCoverage(z.object({ rows: z.array(KeyedEvidenceRowSchema) }));

export const BiomarkerEvidenceRowSchema = KeyedEvidenceRowSchema.extend({
    metrics: z.object({
        sensitivity: z.number().optional(),
        specificity: z.number().optional(),
        auc: z.number().optional(),
        hazard_ratio: z.number().optional(),
    }),
});

export const BiomarkerPotentialSchema = withCoverage(z.object({ rows: z.array(BiomarkerEvidenceRowSchema) }));

export const ResistanceEvidenceSchema = withCoverage(z.object({ rows: z.array(KeyedEvidenceRowSchema) }));

export const CombinationEvidenceSchema = withCoverage(z.object({ rows: z.array(KeyedEvidenceRowSchema) }));

// ── §3.4 Genetic alterations ────────────────────────────────────────

export const SomaticMutationRowSchema = z.object({
    cancer_type: z.string(),
    cohort: z.string(),
    mutation_count: z.number().int().nonnegative(),
    total_samples: z.number().int().nonnegative(),
    frequency: z.number(),
    source: z.string(),
});

export const ClinvarVariantRowSchema = z.object({
    variant_id: z.string(),
    hgvs: z.string(),
    classification: z.string(),
    condition: z.string(),
    review_status: z.string(),
});

export const GeneticAlterationsSchema = z.object({
    somatic: withCoverage(z.object({ rows: z.array(SomaticMutationRowSchema) })),
    clinvar: withCoverage(z.object({ rows: z.array(ClinvarVariantRowSchema) })),
});

// ── §3.7 Pathway context ────────────────────────────────────────────

export const PathwayRowSchema = z.object({
    pathway_id: z.string(),
    pathway_name: z.string(),
    database: z.enum(["reactome", "kegg", "wikipathways", "msigdb"]),
    evidence_score: z.number(),
    entity_uniprots: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PathwayContextSchema = withCoverage(
    z.object({
        rows: z.array(PathwayRowSchema),
        databases_queried: z.array(z.string()),
        databases_skipped: z.array(z.string()),
    }),
);

// ── §3.8 PPI network ────────────────────────────────────────────────

export const PpiPartnerRowSchema = z.object({
    partner_id: z.string().nullable(),
    partner_name: z.string(),
    string_score: z.number().nullable(),
    literature_score: z.number().nullable(),
    combined_score: z.number(),
    sources: z.array(z.string()),
    has_human_evidence: z.boolean(),
    has_clinical_evidence: z.boolean(),
});

export const PpiNetworkSchema = withCoverage(z.object({ partners: z.array(PpiPartnerRowSchema) }));

// ── §3.9 Normal tissue expression ───────────────────────────────────

/** Source and unit travel together, and the normalization note is mandatory. */
export const NormalTissueExpressionSchema = z
    .object({
        source: z.enum(["gtex", "hpa_consensus", "hpa_rna_tissue"]),
        unit: z.enum(["tpm", "ntpm", "consensus_normalized"]),
        normalization_notes: z.string().min(1),
        rows: z.array(
            z.object({
                tissue: z.string(),
                value: z.number(),
                percentile_rank: z.number().optional(),
            }),
        ),
    })
    .superRefine((v, ctx) => {
        if (v.unit === "tpm" && v.source !== "gtex") {
            ctx.addIssue({
                code: "custom",
                message: `unit:"tpm" is only valid with source:"gtex" (got source:"${v.source}")`,
                path: ["unit"],
            });
        }
        if (v.unit === "ntpm" && !(v.source === "hpa_rna_tissue" || v.source === "hpa_consensus")) {
            ctx.addIssue({
                code: "custom",
                message: `unit:"ntpm" is only valid with HPA sources`,
                path: ["unit"],
            });
        }
    });
export type NormalTissueExpression = z.infer<typeof NormalTissueExpressionSchema>;

// ── §3.10 Preclinical ───────────────────────────────────────────────

export const KoPhenotypeSchema = z.object({
    marker_symbol: z.string().nullable(),
    viability: z.string().nullable(),
    sex_dimorphism: z.boolean(),
    organ_systems_with_phenotype: z.array(OrganSystemSchema),
    top_mp_terms: z.array(z.string()),
    total_phenotype_count: z.number().int().nonnegative(),
    pre_weaning_lethal: z.boolean(),
    supporting_literature: EvidenceList,
});

const ExpressionRank = z.enum(["absent", "low", "medium", "high", "no_data", "not_loaded"]);

export const ExpressionHeatmapCellSchema = z.object({
    tissue: z.string(),
    species: z.enum(["human", "mouse", "rat", "macaque", "dog"]),
    rank: ExpressionRank,
});

export const ExpressionHeatmapSchema = z.object({
    cells: z.array(ExpressionHeatmapCellSchema),
    per_species_coverage: z.record(z.string(), CoverageSchema),
});

export const TranslationalCommentaryRowSchema = z.object({
    severity: z.enum(["ok", "caution", "gap"]),
    organ: z.string().optional(),
    species: z.string().optional(),
    text: z.string(),
});

export const PreclinicalLiteratureRowSchema = z.object({
    pmid: z.string().nullable(),
    claim: z.string(),
    excerpt: z.string().optional(),
    model_system: z.string(),
    species: z.string(),
});

export const PreclinicalDataCoverageSchema = z.object({
    ko: z.enum(["available", "no_phenotypes", "none", "queried_no_data", "not_loaded"]),
    expression: CoverageSchema,
    literature: CoverageSchema,
    per_species: z.record(z.string(), z.boolean()),
});

export const PreclinicalProfileSchema = z.object({
    ko_phenotype: withCoverage(KoPhenotypeSchema),
    expression_heatmap: withCoverage(ExpressionHeatmapSchema),
    translational_commentary: withCoverage(z.object({ rows: z.array(TranslationalCommentaryRowSchema) })),
    preclinical_literature: withCoverage(
        z.object({
            rows: z.array(PreclinicalLiteratureRowSchema),
            total_claim_count: z.number().int().nonnegative(),
            truncated: z.boolean(),
        }),
    ),
    data_coverage: PreclinicalDataCoverageSchema,
});

// ── §3.11 Key papers ────────────────────────────────────────────────

export const KeyPaperRowSchema = z.object({
    pmid: z.string(),
    title: z.string(),
    internal_reference_count: z.number().int().nonnegative(),
    year: z.number().int().optional(),
});

export const KeyPapersSchema = withCoverage(z.object({ rows: z.array(KeyPaperRowSchema) }));

// ── §4.1 Evidence conflicts ─────────────────────────────────────────

export const EvidenceConflictRowSchema = z.object({
    evidence_item_id: z.string(),
    predicate: z.string(),
    contradicting_predicates: z.array(z.string()),
    surfaced_in_section: z.string(),
    evidence: EvidenceList,
});

export const EvidenceConflictsSchema = withCoverage(z.object({ rows: z.array(EvidenceConflictRowSchema) }));

// ── §4.2 Evidence timeline ──────────────────────────────────────────

export const EvidenceTimelineSchema = withCoverage(
    z.object({
        histogram: z.record(z.string(), z.number().int().nonnegative()),
        first_reported_year: z.number().int().nullable(),
        last_reported_year: z.number().int().nullable(),
        trend_labels: z.array(z.string()),
    }),
);

// ── §4.3 Translational chain ────────────────────────────────────────

const TranslationalTier = z.enum(["computational", "basic_in_vitro", "complex_in_vitro", "in_vivo_animal", "ex_vivo_human", "clinical"]);

export const TranslationalChainSchema = withCoverage(
    z.object({
        tiers: z.array(
            z.object({
                tier: TranslationalTier,
                claim_count: z.number().int().nonnegative(),
                paper_count: z.number().int().nonnegative(),
            }),
        ),
        peak_evidence_tier: TranslationalTier.nullable(),
        progression_complete: z.boolean(),
        weakest_progression_gap: TranslationalTier.nullable().optional(),
    }),
);

// ── §4.4 Additional evidence ────────────────────────────────────────

export const AdditionalEvidenceSchema = withCoverage(
    z.object({
        rows: z.array(
            z.object({
                predicate: z.string(),
                evidence: EvidenceList,
            }),
        ),
        score_floor: z.number(),
    }),
);

// ── §4.5 Discovery trials ───────────────────────────────────────────

export const DiscoveryTrialRowSchema = z
    .object({
        nct_id: z.string(),
        title: z.string(),
        phase: z.string().nullable().optional(),
        status: z.string().optional(),
        conditions: z.array(z.string()),
        start_date: z.string().optional(),
        completion_date: z.string().optional(),
        match_confidence: z.enum(["high", "medium", "low"]),
        relevance_basis: z.discriminatedUnion("kind", [
            z.object({
                kind: z.literal("drug_in_class_match"),
                drug_id: z.string(),
                matched_term: z.string().optional(),
            }),
            z.object({ kind: z.literal("title_keyword"), matched_term: z.string() }),
            z.object({ kind: z.literal("condition_match"), matched_term: z.string().optional() }),
            z.object({ kind: z.literal("manual") }),
        ]),
        attribution: ClinicalTrialAttributionSchema,
        eligible_for_toxicology_aggregation: z.boolean(),
    })
    .superRefine((v, ctx) => {
        // Low-confidence rows that only match by condition (no drug link) are unreliable;
        // collector must drop them rather than emitting them.
        if (v.match_confidence === "low" && v.relevance_basis.kind === "condition_match") {
            ctx.addIssue({
                code: "custom",
                message: `low-confidence rows must not have relevance_basis.kind="condition_match" without an intervention drug match (drop at collector)`,
                path: ["relevance_basis"],
            });
        }
    });
export type DiscoveryTrialRow = z.infer<typeof DiscoveryTrialRowSchema>;

export const DiscoveryTrialsSchema = withCoverage(
    z.object({
        rows: z.array(DiscoveryTrialRowSchema),
        excluded_rows: z.array(DiscoveryTrialRowSchema).default([]),
    }),
);
export type DiscoveryTrials = z.infer<typeof DiscoveryTrialsSchema>;

// ── §1.0 Executive recommendation ───────────────────────────────────

export const ExecutiveRecommendationDataSchema = z.object({
    disposition: z.enum(["pursue", "conditional", "de_prioritize", "insufficient_evidence"]),
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.string(),
    key_strengths: z.array(z.string()).max(8).default([]),
    key_risks: z.array(z.string()).max(8).default([]),
    key_risks_dropped: z
        .array(
            z.object({
                text: z.string(),
                reason: z.string(),
                cited_pmid: z.string().optional(),
            }),
        )
        .optional(),
    modality_choice: z.object({
        modality: z.string(),
        rationale: z.string(),
    }),
    coverage_qualifier: z.object({
        sections_consulted: z.array(z.string()).default([]),
        sections_unavailable: z.array(z.string()).default([]),
        note: z.string(),
        unverified_bullets: z
            .array(
                z.object({
                    text: z.string(),
                    bullet_category: z.string(),
                    surface: z.literal("organ_claim_without_probe_pass"),
                }),
            )
            .optional(),
    }),
});
export type ExecutiveRecommendationData = z.infer<typeof ExecutiveRecommendationDataSchema>;

export const ExecutiveRecommendationSchema = withCoverage(ExecutiveRecommendationDataSchema);
export type ExecutiveRecommendation = z.infer<typeof ExecutiveRecommendationSchema>;

// ── §4.6 Synthesis diagnostics ──────────────────────────────────────

export const SynthesisDiagnosticRowSchema = z.object({
    step_id: z.enum(["liability-bullets", "safety-flags-trail", "translational-commentary", "dossier-recommendation"]),
    model_id: z.string(),
    attempt_count: z.number().int().min(1).max(2),
    retry_critique: z.string().nullable(),
    output_chars: z.number().int().nonnegative(),
    probe_verdict: z.enum([
        "pass",
        "fail-length",
        "fail-section-references",
        "fail-key-strengths-risks",
        "fail-source-references",
        "fail-numeric-claim",
        "fail-voice",
        "relaxed",
        "skipped",
    ]),
    final_coverage: CoverageSchema.extract(["available", "queried_no_data"]),
    error_kind: z.enum(["synthesis-too-shallow", "synthesis-unavailable", "voice-violation"]).nullable().optional(),
    error_message: z.string().nullable().optional(),
});
export type SynthesisDiagnosticRow = z.infer<typeof SynthesisDiagnosticRowSchema>;

export const SynthesisDiagnosticsSchema = withCoverage(z.object({ rows: z.array(SynthesisDiagnosticRowSchema) }));
export type SynthesisDiagnostics = z.infer<typeof SynthesisDiagnosticsSchema>;

// ── §4.7 Recommendation citation audit ──────────────────────────────

export const RecommendationAuditEntrySchema = z.union([
    z.object({
        surface: z.enum(["rationale", "key_strengths", "key_risks", "modality_choice"]),
        path: z.string(),
        excerpt: z.string(),
    }),
    z.object({
        surface: z.literal("external_missing"),
        id: z.string(),
        excerpt: z.string(),
    }),
    z.object({
        surface: z.literal("organ_claim_without_probe_pass"),
        excerpt: z.string(),
        bullet_category: z.string(),
    }),
    z.object({
        surface: z.literal("nct_wrong_class"),
        id: z.string(),
        excerpt: z.string(),
    }),
    z.object({
        surface: z.literal("pmid_not_in_key_papers"),
        id: z.string(),
        excerpt: z.string(),
    }),
    z.object({
        surface: z.literal("direction_mismatch"),
        pmid: z.string(),
        excerpt: z.string(),
        paper_conclusion_direction: z.enum(["supports", "contradicts", "ambiguous"]).optional(),
    }),
    z.object({
        surface: z.literal("abstract_unavailable"),
        pmid: z.string(),
        excerpt: z.string(),
    }),
    z.object({
        surface: z.literal("off_topic_citation"),
        pmid: z.string(),
        excerpt: z.string(),
    }),
]);
export type RecommendationAuditEntry = z.infer<typeof RecommendationAuditEntrySchema>;

export const RecommendationAuditSchema = withCoverage(
    z.object({
        citations_total: z.number().int().nonnegative(),
        citations_unresolved: z.array(RecommendationAuditEntrySchema),
        non_dossier_citations: z.array(z.object({ token: z.string(), source: z.string() })),
    }),
);
export type RecommendationAudit = z.infer<typeof RecommendationAuditSchema>;

// ── §4.8 Quality gates ──────────────────────────────────────────────

export const QualityGateStatusSchema = z.object({
    gate_id: z.string(),
    status: z.enum(["pass", "warning", "blocked"]),
    message: z.string(),
    affected_sections: z.array(z.string()).default([]),
    unresolved_count: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
export type QualityGateStatus = z.infer<typeof QualityGateStatusSchema>;

export const QualityGatesSchema = withCoverage(z.object({ rows: z.array(QualityGateStatusSchema) }));
export type QualityGates = z.infer<typeof QualityGatesSchema>;

// ── Composite shapes ────────────────────────────────────────────────

export const ReferenceBiologyShape = z.object({
    therapeutic_area_associations: DiseaseAssociationsSchema,
    molecular_interactions: MolecularInteractionsSchema,
    biomarker_potential: BiomarkerPotentialSchema,
    genetic_alterations: GeneticAlterationsSchema,
    resistance_evidence: ResistanceEvidenceSchema,
    combination_evidence: CombinationEvidenceSchema,
    pathway_context: PathwayContextSchema,
    ppi_network: PpiNetworkSchema,
    normal_tissue_expression: withCoverage(NormalTissueExpressionSchema),
    preclinical: PreclinicalProfileSchema,
    key_papers: KeyPapersSchema,
});

const AnalyticsShape = z.object({
    evidence_conflicts: EvidenceConflictsSchema,
    evidence_timeline: EvidenceTimelineSchema,
    translational_chain: TranslationalChainSchema,
    additional_evidence: AdditionalEvidenceSchema,
    discovery_trials: DiscoveryTrialsSchema,
    synthesis_diagnostics: SynthesisDiagnosticsSchema,
    quality_gates: QualityGatesSchema,
    recommendation_audit: RecommendationAuditSchema.optional(),
});

// ── Derived sub-tree ────────────────────────────────────────────────
//
// Shape produced by computeDerivedFields(body) and validated at phase-5
// persist. `.strict()` rejects unknown keys to prevent accidental extras.

export const DerivedSchema = z
    .object({
        summary: z.object({
            has_human_evidence: z.boolean(),
            has_clinical_evidence: z.boolean(),
            total_evidence_items: z.number().int().nonnegative(),
            total_distinct_papers: z.number().int().nonnegative(),
            total_distinct_clinical_trials: z.number().int().nonnegative(),
            strongest_strength_label: z.string().nullable(),
            highest_score: z.number().nullable(),
            highest_score_is_conflicted: z.boolean(),
        }),
        risk_summary: z.object({
            any_fatal_signal: z.union([z.boolean(), z.literal("unknown")]),
            highest_risk_organ: OrganSystemSchema.nullable(),
            off_target_safety_target_hits: z.number().int().nonnegative(),
            class_liability_count: z.number().int().nonnegative(),
        }),
        liability_summary: z.object({
            counts: z.object({
                class_liability_count: z.number().int().nonnegative(),
                safety_target_off_target_count: z.number().int().nonnegative(),
                off_tissue_risk_organ_count: z.number().int().nonnegative(),
            }),
            expression_breadth: z.object({
                total_assessed_tissues: z.number().int().nonnegative(),
                high_expression_tissue_count: z.number().int().nonnegative(),
            }),
            same_class_drug_count: z.number().int().nonnegative(),
            safety_data_sources_checked: z.number().int().nonnegative(),
        }),
        organ_rollup_completeness: z
            .object({
                expected_organs: z.array(OrganSystemSchema),
                present_organs: z.array(OrganSystemSchema),
                missing_organs: z.array(OrganSystemSchema),
            })
            .refine((v) => v.missing_organs.length === 0, {
                message: "missing_organs must be empty for the dossier to ship",
                path: ["missing_organs"],
            }),
    })
    .strict();
export type Derived = z.infer<typeof DerivedSchema>;

// ── Top-level Dossier ───────────────────────────────────────────────

export const DossierSchema = z.object({
    entity: EntitySchema,
    generated_at: z.string(),
    liability_summary: LiabilitySummarySchema,
    tractability: TractabilitySchema,
    indications: IndicationsSchema,
    drug_interactions: DrugInteractionsSchema,
    clinical_development: ClinicalDevelopmentSchema,
    safety_profile: SafetyProfileSchema,
    off_tissue_risk: OffTissueRiskSchema,
    off_target_panel: withCoverage(OffTargetPanelSchema),
    reference_biology: ReferenceBiologyShape,
    analytics: AnalyticsShape,
    executive_recommendation: ExecutiveRecommendationSchema,
    derived: DerivedSchema,
});
export type Dossier = z.infer<typeof DossierSchema>;

/**
 * Everything the Phase-4 assembler is responsible for building, without the
 * derived sub-tree. Phase-5 persist computes derived from the stamped body
 * and validates the complete dossier against `DossierSchema`.
 */
export const DossierBodySchema = DossierSchema.omit({ derived: true });
export type DossierBody = z.infer<typeof DossierBodySchema>;

// ── Type guards ─────────────────────────────────────────────────────

export function isDossier(value: unknown): value is Dossier {
    return DossierSchema.safeParse(value).success;
}

/** JSON Schema export for runtime validation in non-TS environments. */
export function dossierJsonSchema(): unknown {
    return z.toJSONSchema(DossierSchema);
}

// ── Progress events ─────────────────────────────────────────────────

export const TargetAssessmentPhaseSchema = z.enum([
    "resolving",
    "collecting",
    "deciding",
    "fanning_out",
    "assembling",
    "synthesizing",
    "completed",
    "failed",
    "suspended",
]);
export type TargetAssessmentPhase = z.infer<typeof TargetAssessmentPhaseSchema>;

export const TargetAssessmentProgressEventSchema = z.object({
    phase: TargetAssessmentPhaseSchema,
    message: z.string(),
    percent: z.number().min(0).max(100),
    at: z.string(),
});
export type TargetAssessmentProgressEvent = z.infer<typeof TargetAssessmentProgressEventSchema>;
