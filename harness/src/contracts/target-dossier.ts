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
 * under `evidence: [...]` arrays.
 *
 * `DossierSchema` is a single v3 shape — no backwards-compatibility union.
 * Old v1/v2 persisted rows will not parse; that is intentional.
 *
 * See `TARGET_DOSSIER.md` for the full editorial specification.
 */

import { z } from "zod";

// ── Coverage primitives ─────────────────────────────────────────────

export const CoverageSchema = z.enum(["available", "queried_no_data", "not_loaded"]);
export type Coverage = z.infer<typeof CoverageSchema>;

const CoverageError = z.object({
    message: z.string(),
    source: z.string().optional(),
});

/**
 * Build a discriminated section schema: when `coverage` is `available`,
 * `data` is required and matches the inner schema. Otherwise `data` is
 * absent and an optional `error` payload may be present.
 */
function withCoverage<T extends z.ZodTypeAny>(data: T) {
    return z.discriminatedUnion("coverage", [
        z.object({
            coverage: z.literal("available"),
            data,
            inference_path: z.string().optional(),
            truncated: z.boolean().optional(),
        }),
        z.object({
            coverage: z.literal("queried_no_data"),
            error: CoverageError.optional(),
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

// ── §1.1 Entity ─────────────────────────────────────────────────────

export const EntitySchema = z.object({
    canonicalId: z.string(),
    symbol: z.string(),
    displayName: z.string(),
    /**
     * Cortex's Phase-0 resolver currently only emits `"gene"`. The schema
     * keeps the broader enum so the contract is forward-compatible with
     * protein-/rna-/complex-level entities once the resolver supports them.
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

// ── §1.2 Summary ────────────────────────────────────────────────────

export const SummarySchema = z.object({
    total_evidence_items: z.number().int().nonnegative(),
    total_distinct_papers: z.number().int().nonnegative(),
    has_human_evidence: z.boolean(),
    has_clinical_evidence: z.boolean(),
    strongest_strength_label: z.string().nullable(),
    highest_score: z.number().nullable(),
    highest_score_is_conflicted: z.boolean(),
    total_distinct_clinical_trials: z.number().int().nonnegative(),
});
export type Summary = z.infer<typeof SummarySchema>;

// ── §2.1 Liability summary ──────────────────────────────────────────

export const LiabilityBulletSchema = z.object({
    text: z.string(),
    rationale: z.string(),
    category: z.enum(["fatal_post_market", "class_liability", "off_target_safety", "high_safety_organ_expression", "broad_expression", "other"]),
});

export const LiabilitySummarySchema = z.object({
    liability_bullets: z.array(LiabilityBulletSchema),
    modality_recommendation: z.string().nullable(),
    expression_breadth: z.object({
        high_expression_tissue_count: z.number().int().nonnegative(),
        total_assessed_tissues: z.number().int().nonnegative(),
    }),
    class_liability_count: z.number().int().nonnegative(),
    safety_target_off_target_count: z.number().int().nonnegative(),
    off_tissue_risk_organ_count: z.number().int().nonnegative(),
    same_class_drug_count: z.number().int().nonnegative(),
    safety_data_sources_checked: z.number().int().nonnegative(),
    inferred_therapeutic_area: z.string().nullable(),
    no_liabilities_disclosure: z.string().optional(),
});
export type LiabilitySummary = z.infer<typeof LiabilitySummarySchema>;

// ── §2.2 Tractability ───────────────────────────────────────────────

export const TractabilityModalitySchema = z.object({
    /**
     * Phase-4 currently emits only `small_molecule`, `antibody`, and
     * `other_clinical`. The remaining variants are reserved for future
     * Phase-2 modality-fallback expansions (PROTAC, oligonucleotide, peptide
     * libraries) — keep them in the enum so persisted dossiers don't reject
     * once those land.
     */
    modality: z.enum(["small_molecule", "antibody", "protac", "other_clinical", "oligonucleotide", "peptide"]),
    levels: z.array(z.string()),
    has_approved_drug: z.boolean(),
    has_clinical_stage: z.boolean(),
    is_inferred_from_family: z.boolean(),
    approved_drug_ids: z.array(z.string()).optional(),
    note: z.string().optional(),
});

export const TractabilitySchema = withCoverage(
    z.object({
        modalities: z.array(TractabilityModalitySchema),
        preferred_modality: z.string().nullable(),
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

export const ClinicalTrialRowSchema = z.object({
    nct_id: z.string(),
    title: z.string(),
    phase: z.string().nullable(),
    status: z.string(),
    conditions: z.array(z.string()),
    start_date: z.string().nullable(),
    completion_date: z.string().nullable(),
    match_confidence: z.enum(["high", "medium", "low", "off_target"]),
});

export const TrialOutcomeRowSchema = z.object({
    nct_id: z.string(),
    outcome_type: z.enum(["primary", "secondary", "serious_ae", "non_serious_ae", "other_ae"]),
    measure: z.string(),
    description: z.string().optional(),
    result: z.string().optional(),
});

export const FailedTrialRowSchema = z.object({
    nct_id: z.string(),
    title: z.string(),
    why_stopped: z.string(),
    failure_category: z.enum(["safety", "efficacy", "strategic", "other"]),
    classifier: z.enum(["rules", "llm"]),
});

const FailureCategoryV4Schema = z.discriminatedUnion("category", [
    z.object({ category: z.literal("safety"), safety_evidence_excerpt: z.string() }),
    z.object({ category: z.literal("strategic"), category_evidence_excerpt: z.string() }),
    z.object({ category: z.literal("operational"), category_evidence_excerpt: z.string() }),
    z.object({ category: z.literal("efficacy"), category_evidence_excerpt: z.string() }),
]);

export const FailedTrialRowV4Schema = z
    .object({
        nct_id: z.string(),
        title: z.string(),
        why_stopped: z.string(),
        classifier: z.enum(["rules", "llm"]),
        failure_category: FailureCategoryV4Schema,
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
            related_target_trials: z
                .array(
                    ClinicalTrialRowSchema.extend({
                        match_confidence: z.literal("off_target"),
                    }),
                )
                .optional(),
            related_receptor: z.string().optional(),
            selection_criteria: z
                .object({
                    derived_from: z.literal("analytics.discovery_trials"),
                    min_confidence: z.enum(["high", "medium"]),
                    excluded_off_target_count: z.number().int().nonnegative(),
                })
                .optional(),
        }),
    ),
    outcomes: withCoverage(z.object({ rows: z.array(TrialOutcomeRowSchema) })),
    failed_trials: withCoverage(
        z.object({
            rows: z.array(FailedTrialRowSchema),
            related_target_trials: z.array(FailedTrialRowSchema).optional(),
            related_receptor: z.string().optional(),
        }),
    ),
    benchmarks: withCoverage(ClinicalBenchmarksSchema),
});

// ── §2.6 Safety profile ─────────────────────────────────────────────

export const OrganRiskRowSchema = z.object({
    organ: z.enum(["cardiac", "hepatic", "cns", "renal", "gi", "hematologic", "metabolic", "immune", "respiratory"]),
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

export const FaersSummarySchema = z.object({
    total_reports: z.number().int().nonnegative(),
    fatal_report_count: z.number().int().nonnegative(),
    any_fatal: z.boolean(),
    seriousness_profile: z
        .object({
            death: z.number().int().nonnegative(),
            hospitalization: z.number().int().nonnegative(),
            life_threatening: z.number().int().nonnegative(),
            disabling: z.number().int().nonnegative(),
            congenital_anomaly: z.number().int().nonnegative(),
            other_serious: z.number().int().nonnegative(),
        })
        .optional(),
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
            coverage: CoverageSchema,
        }),
    ),
});

const SeriousnessAvailableV4Schema = z
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

const SeriousnessQueriedNoDataV4Schema = z.object({
    coverage: z.literal("queried_no_data"),
    total_reports: z.number().int().nonnegative(),
});

export const FaersSummaryV4Schema = z.object({
    total_reports: z.number().int().nonnegative(),
    seriousness: z.discriminatedUnion("coverage", [SeriousnessAvailableV4Schema, SeriousnessQueriedNoDataV4Schema]),
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
            coverage: CoverageSchema,
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
    /**
     * Floor pct for non-serious AEs. PR-E lowered the operational value
     * from 5 to 2 so real low-incidence AEs survive the filter; older
     * persisted dossiers with the prior 5% floor still parse.
     */
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

export const OffTargetRowSchema = z.object({
    off_target_id: z.string().nullable(),
    off_target_name: z.string(),
    target_class: z.string().optional(),
    pchembl: z.number(),
    is_safety_panel_target: z.boolean(),
    organ_system: z.string().nullable(),
    clinical_consequence: z.string().nullable(),
    selectivity: z.object({
        log_units: z.number(),
        fold: z.number(),
        legacy_alias: z.number().optional(),
    }),
    selectivity_window_below_threshold: z.boolean(),
    evidence: EvidenceList,
    metadata: z
        .object({
            merged_chembl_ids: z.array(z.string()).optional(),
        })
        .optional(),
});

const SelectivityV4Schema = z.union([
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

const OffTargetRowV4Base = z.object({
    off_target_id: z.string().nullable(),
    off_target_name: z.string(),
    target_class: z.string().optional(),
    pchembl: z.number(),
    is_safety_panel_target: z.boolean(),
    organ_system: z.string().nullable(),
    clinical_consequence: z.string().nullable(),
    selectivity: SelectivityV4Schema,
    selectivity_window_below_threshold: z.boolean(),
    evidence: EvidenceList,
    metadata: z.object({ merged_chembl_ids: z.array(z.string()).optional() }).optional(),
});

export const OffTargetRowV4Schema = OffTargetRowV4Base.extend({
    relationship: z.literal("off_target"),
});

export const ExcludedOffTargetRowV4Schema = OffTargetRowV4Base.extend({
    relationship: z.enum(["intended_co_target", "on_target_self_hit", "obligate_cofactor"]),
    reason: z.string().min(1),
});

export const OffTargetPanelV4Schema = z.object({
    rows: z.array(OffTargetRowV4Schema),
    excluded_rows: z.array(ExcludedOffTargetRowV4Schema),
});

export const ClassLiabilityOrganSchema = z.object({
    organ: z.string(),
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

export const SafetyFlagSchema = z.object({
    organ: z.string(),
    trail: z.string(),
    mechanism_hypothesis: z.string().nullable().optional(),
});

export const RiskSummarySchema = z.object({
    highest_risk_organ: z.string().nullable(),
    off_target_safety_target_hits: z.number().int().nonnegative(),
    class_liability_count: z.number().int().nonnegative(),
    any_fatal_signal: z.boolean(),
});

export const SafetyProfileSchema = z.object({
    organ_rollup: withCoverage(z.object({ rows: z.array(OrganRiskRowSchema) })),
    faers: withCoverage(FaersSummarySchema),
    trial_aes: withCoverage(TrialAesSchema),
    off_target_panel: withCoverage(z.object({ rows: z.array(OffTargetRowSchema) })),
    failed_trials_safety_lens: withCoverage(
        z.object({
            rows: z.array(FailedTrialRowSchema),
            related_target_trials: z.array(FailedTrialRowSchema).optional(),
            related_receptor: z.string().optional(),
        }),
    ),
    class_precedent: withCoverage(ClassPrecedentSchema),
    target_organ_liabilities: z.array(SafetyFlagSchema),
    risk_summary: RiskSummarySchema,
});

// ── §2.7 Off-tissue risk ────────────────────────────────────────────

export const OffTissueRowSchema = z.object({
    tissue: z.string(),
    organ: z.string(),
    tpm: z.number(),
});

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

export const NormalTissueRowSchema = z.object({
    tissue: z.string(),
    organ: z.string().optional(),
    tpm: z.number(),
    is_safety_relevant: z.boolean(),
});

export const NormalTissueExpressionSchema = withCoverage(z.object({ rows: z.array(NormalTissueRowSchema) }));

// ── §3.10 Preclinical ───────────────────────────────────────────────

export const KoPhenotypeSchema = z.object({
    marker_symbol: z.string().nullable(),
    viability: z.string().nullable(),
    sex_dimorphism: z.boolean(),
    organ_systems_with_phenotype: z.array(z.string()),
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

// ── V4 schema refinements ────────────────────────────────────────────

// Trial outcome with required discriminated effect block
export const TrialOutcomeRowV4Schema = z.object({
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
});
export type TrialOutcomeRowV4 = z.infer<typeof TrialOutcomeRowV4Schema>;

// Normal tissue expression with source + unit pair and required normalization_notes
export const NormalTissueExpressionV4Schema = z
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
export type NormalTissueExpressionV4 = z.infer<typeof NormalTissueExpressionV4Schema>;

// Tractability with modality enumeration refinement
const MOLECULE_TYPE_TO_MODALITY: Record<string, string[]> = {
    Protein: ["peptide", "antibody"],
    "Small molecule": ["small_molecule"],
    Oligonucleotide: ["oligonucleotide"],
};

export const TractabilityV4Schema = withCoverage(
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
export type TractabilityV4Section = z.infer<typeof TractabilityV4Schema>;

// Discovery trial row with required relevance_basis discriminator
export const DiscoveryTrialRowV4Schema = z
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
export type DiscoveryTrialRowV4 = z.infer<typeof DiscoveryTrialRowV4Schema>;

// ── V4 derived sub-tree ─────────────────────────────────────────────
// Shape produced by computeDerivedFields(body) and validated at phase-5
// persist. `.strict()` rejects unknown keys to prevent accidental extras.

export const DerivedV4Schema = z
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
            highest_risk_organ: z.string().nullable(),
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
                expected_organs: z.array(z.string()),
                present_organs: z.array(z.string()),
                missing_organs: z.array(z.string()),
            })
            .refine((v) => v.missing_organs.length === 0, {
                message: "missing_organs must be empty for the dossier to ship",
                path: ["missing_organs"],
            }),
    })
    .strict();

export type DerivedV4 = z.infer<typeof DerivedV4Schema>;

// ── §4.5 Discovery trials ───────────────────────────────────────────

export const DiscoveryTrialRowSchema = ClinicalTrialRowSchema.extend({
    match_confidence: z.enum(["high", "medium", "low", "off_target"]),
});

export const DiscoveryTrialsSchema = withCoverage(
    z.object({
        rows: z.array(DiscoveryTrialRowV4Schema),
        related_target_trials: z
            .array(
                ClinicalTrialRowSchema.extend({
                    match_confidence: z.literal("off_target"),
                }),
            )
            .optional(),
        related_receptor: z.string().optional(),
    }),
);

// ── §1.0 Executive recommendation (v2) ──────────────────────────────

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
    // Deprecated; kept for one release for backward compat with previously
    // persisted dossiers. New writes use `key_risks_dropped`. v5 will remove.
    key_risks_downgraded: z
        .array(
            z.object({
                bullet_index: z.number().int().nonnegative(),
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

// ── §4.6 Synthesis diagnostics (v2) ─────────────────────────────────

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
    final_coverage: z.enum(["available", "queried_no_data"]),
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

// ── Top-level Dossier ───────────────────────────────────────────────
//
// `DossierSchema` is a single v3 shape. No backwards-compatibility union.
// Old v1/v2 persisted rows will not parse; that is intentional.

const ReferenceBiologyShape = z.object({
    therapeutic_area_associations: DiseaseAssociationsSchema,
    molecular_interactions: MolecularInteractionsSchema,
    biomarker_potential: BiomarkerPotentialSchema,
    genetic_alterations: GeneticAlterationsSchema,
    resistance_evidence: ResistanceEvidenceSchema,
    combination_evidence: CombinationEvidenceSchema,
    pathway_context: PathwayContextSchema,
    ppi_network: PpiNetworkSchema,
    normal_tissue_expression: NormalTissueExpressionSchema,
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
    recommendation_audit: RecommendationAuditSchema.optional(),
});

const DossierCommonShape = {
    generated_at: z.string(),
    entity: EntitySchema,
    summary: SummarySchema,
    liability_summary: LiabilitySummarySchema,
    tractability: TractabilitySchema,
    indications: IndicationsSchema,
    drug_interactions: DrugInteractionsSchema,
    clinical_development: ClinicalDevelopmentSchema,
    safety_profile: SafetyProfileSchema,
    off_tissue_risk: OffTissueRiskSchema,
    off_target_panel: withCoverage(z.object({ rows: z.array(OffTargetRowSchema) })),
    reference_biology: ReferenceBiologyShape,
};

export const DossierSchema = z.object({
    schema_version: z.literal("3"),
    ...DossierCommonShape,
    analytics: AnalyticsShape,
    executive_recommendation: ExecutiveRecommendationSchema,
});

// ── V4 section wrappers ─────────────────────────────────────────────

// OrganRiskRow V4 — extends v3 with a richer organ enum
export const OrganRiskRowV4Schema = OrganRiskRowSchema.extend({
    organ: z.enum([
        "cardiac",
        "hepatic",
        "cns",
        "renal",
        "gi",
        "pancreas",
        "endocrine_thyroid",
        "metabolic",
        "hematologic",
        "immune",
        "respiratory",
        "reproductive",
        "dermatologic",
        "musculoskeletal",
        "oncology",
    ]),
});

// Liability bullets removed post-synthesis because they cited a PMID the
// direction-of-effect auditor found contradicts the bullet's framing.
// Mirrors `executive_recommendation.key_risks_dropped` — the dropped
// content is preserved with the reason for an audit trail.
export const LiabilityBulletDroppedSchema = LiabilityBulletSchema.extend({
    reason: z.string(),
    cited_pmid: z.string().optional(),
});
export type LiabilityBulletDropped = z.infer<typeof LiabilityBulletDroppedSchema>;

// LiabilitySummaryV4Schema — strict() rejects derived counter keys that moved to derived sub-tree
export const LiabilitySummaryV4Schema = z
    .object({
        liability_bullets: z.array(LiabilityBulletSchema),
        liability_bullets_dropped: z.array(LiabilityBulletDroppedSchema).optional(),
        modality_recommendation: z.string().nullable(),
        same_class_drug_count: z.number().int().nonnegative(),
        inferred_therapeutic_area: z.string().nullable(),
        no_liabilities_disclosure: z.string().optional(),
    })
    .strict();

// ClinicalDevelopmentV4Schema — swaps in V4 outcome and failed-trial rows
export const ClinicalDevelopmentV4Schema = z.object({
    trials: withCoverage(
        z.object({
            rows: z.array(ClinicalTrialRowSchema),
            selection_criteria: z
                .object({
                    derived_from: z.string().optional(),
                    min_confidence: z.string().optional(),
                    excluded_off_target_count: z.number().int().nonnegative().optional(),
                })
                .optional(),
        }),
    ),
    outcomes: withCoverage(z.object({ rows: z.array(TrialOutcomeRowV4Schema) })),
    failed_trials: withCoverage(z.object({ rows: z.array(FailedTrialRowV4Schema) })),
    benchmarks: ClinicalBenchmarksSchema,
});

const RegulatoryActionRowSchema = z.object({
    drug_chembl_id: z.string(),
    drug_name: z.string(),
    agency: z.enum(["FDA", "EMA", "MHRA", "PMDA", "Health Canada", "TGA"]),
    action_kind: z.enum(["referral", "withdrawal", "indication_restriction", "REMS", "black_box", "DHCP", "safety_communication", "label_warning"]),
    action_date: z.string(),
    finding: z.string(),
    source_url: z.string().url().optional(),
    source_kind: z.enum(["label_warning", "referral", "rems", "withdrawal", "boxed_warning", "safety_communication"]).optional(),
    application_number: z.string().optional(),
    label_section: z.string().optional(),
    source_date: z.string().optional(),
    evidence: EvidenceList,
});
export type RegulatoryActionRow = z.infer<typeof RegulatoryActionRowSchema>;

// SafetyProfileV4Schema — swaps in V4 FAERS / off-target / failed-trial / OrganRiskRow
export const SafetyProfileV4Schema = z.object({
    organ_rollup: withCoverage(z.object({ rows: z.array(OrganRiskRowV4Schema) })),
    faers: withCoverage(FaersSummaryV4Schema),
    trial_aes: withCoverage(TrialAesSchema),
    off_target_panel: withCoverage(OffTargetPanelV4Schema),
    failed_trials_safety_lens: withCoverage(z.object({ rows: z.array(FailedTrialRowV4Schema) })),
    class_precedent: withCoverage(ClassPrecedentSchema),
    target_organ_liabilities: z.array(SafetyFlagSchema),
    regulatory_actions: withCoverage(z.object({ rows: z.array(RegulatoryActionRowSchema) })).optional(),
});

// ReferenceBiologyV4Shape — swaps normal_tissue_expression for V4 version
export const ReferenceBiologyV4Shape = z.object({
    ...ReferenceBiologyShape.shape,
    normal_tissue_expression: withCoverage(NormalTissueExpressionV4Schema),
});

// ── V4 top-level DossierV4Schema ────────────────────────────────────

export const DossierV4Schema = z.object({
    schema_version: z.literal("4"),
    entity: EntitySchema,
    generated_at: z.string(),
    liability_summary: LiabilitySummaryV4Schema,
    tractability: TractabilityV4Schema,
    indications: IndicationsSchema,
    drug_interactions: DrugInteractionsSchema,
    clinical_development: ClinicalDevelopmentV4Schema,
    safety_profile: SafetyProfileV4Schema,
    off_tissue_risk: OffTissueRiskSchema,
    off_target_panel: withCoverage(OffTargetPanelV4Schema),
    reference_biology: ReferenceBiologyV4Shape,
    analytics: AnalyticsShape,
    executive_recommendation: ExecutiveRecommendationSchema,
    derived: DerivedV4Schema,
});

export type DossierV4 = z.infer<typeof DossierV4Schema>;

// Body-only v4 shape: everything the Phase-4 assembler is responsible for
// building, WITHOUT the derived sub-tree. Phase-5 persist computes derived
// from the stamped body and validates the complete dossier against
// DossierV4Schema. Keeping Phase4OutputSchema loose prevents an assembler
// organ-rollup miss from surfacing as a generic workflow-error instead
// of the explicit derived-invariant-violation path in phase5-persist.
export const DossierV4BodySchema = DossierV4Schema.omit({ derived: true });
export type DossierV4Body = z.infer<typeof DossierV4BodySchema>;

// ── V5 evidence attribution and quality gates ────────────────────────

export const ClinicalTrialAttributionBasisV5Schema = z.object({
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
export type ClinicalTrialAttributionBasisV5 = z.infer<typeof ClinicalTrialAttributionBasisV5Schema>;

export const ResolvedTrialInterventionV5Schema = z.object({
    name: z.string(),
    intervention_type: z.string().nullable().optional(),
    chembl_id: z.string().nullable().optional(),
    therapeutic_program_id: z.string().nullable().optional(),
    target_uniprots: z.array(z.string()).default([]),
    resolver_source: z.string(),
});
export type ResolvedTrialInterventionV5 = z.infer<typeof ResolvedTrialInterventionV5Schema>;

export const ClinicalTrialAttributionV5Schema = z
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
        basis: z.array(ClinicalTrialAttributionBasisV5Schema).min(1),
        resolved_interventions: z.array(ResolvedTrialInterventionV5Schema).default([]),
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
export type ClinicalTrialAttributionV5 = z.infer<typeof ClinicalTrialAttributionV5Schema>;

export const ClinicalTrialRowV5Schema = ClinicalTrialRowSchema.extend({
    attribution: ClinicalTrialAttributionV5Schema,
    eligible_for_toxicology_aggregation: z.boolean(),
});
export type ClinicalTrialRowV5 = z.infer<typeof ClinicalTrialRowV5Schema>;

export const FailedTrialRowV5Schema = FailedTrialRowV4Schema.extend({
    attribution: ClinicalTrialAttributionV5Schema,
    eligible_for_toxicology_aggregation: z.boolean(),
});
export type FailedTrialRowV5 = z.infer<typeof FailedTrialRowV5Schema>;

export const TrialOutcomeRowV5Schema = TrialOutcomeRowV4Schema.extend({
    attribution: ClinicalTrialAttributionV5Schema.optional(),
    eligible_for_toxicology_aggregation: z.boolean().default(false),
});
export type TrialOutcomeRowV5 = z.infer<typeof TrialOutcomeRowV5Schema>;

export const ClinicalDevelopmentV5Schema = z.object({
    trials: withCoverage(
        z.object({
            rows: z.array(ClinicalTrialRowV5Schema),
            excluded_rows: z.array(ClinicalTrialRowV5Schema).default([]),
            selection_criteria: z
                .object({
                    derived_from: z.string().optional(),
                    min_confidence: z.string().optional(),
                    excluded_off_target_count: z.number().int().nonnegative().optional(),
                })
                .optional(),
        }),
    ),
    outcomes: withCoverage(z.object({ rows: z.array(TrialOutcomeRowV5Schema) })),
    failed_trials: withCoverage(
        z.object({
            rows: z.array(FailedTrialRowV5Schema),
            excluded_rows: z.array(FailedTrialRowV5Schema).default([]),
        }),
    ),
    benchmarks: ClinicalBenchmarksSchema,
});
export type ClinicalDevelopmentV5 = z.infer<typeof ClinicalDevelopmentV5Schema>;

export const RegulatoryActionRowV5Schema = RegulatoryActionRowSchema.extend({
    action_kind: z.enum(["referral", "withdrawal", "indication_restriction", "REMS", "black_box", "DHCP", "safety_communication", "label_warning"]),
    source_kind: z.enum(["label_warning", "referral", "rems", "withdrawal", "boxed_warning", "safety_communication"]),
    application_number: z.string().optional(),
    label_section: z.string().optional(),
    source_date: z.string().optional(),
}).superRefine((v, ctx) => {
    if (v.source_kind === "label_warning" && v.action_kind === "safety_communication") {
        ctx.addIssue({
            code: "custom",
            message: "FDA label warnings must not be represented as action_kind:safety_communication",
            path: ["action_kind"],
        });
    }
});
export type RegulatoryActionRowV5 = z.infer<typeof RegulatoryActionRowV5Schema>;

export const SafetyProfileV5Schema = SafetyProfileV4Schema.extend({
    regulatory_actions: withCoverage(z.object({ rows: z.array(RegulatoryActionRowV5Schema) })).optional(),
});
export type SafetyProfileV5 = z.infer<typeof SafetyProfileV5Schema>;

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

export const DiscoveryTrialRowV5Schema = DiscoveryTrialRowV4Schema.extend({
    attribution: ClinicalTrialAttributionV5Schema,
    eligible_for_toxicology_aggregation: z.boolean(),
});
export type DiscoveryTrialRowV5 = z.infer<typeof DiscoveryTrialRowV5Schema>;

export const DiscoveryTrialsV5Schema = withCoverage(
    z.object({
        rows: z.array(DiscoveryTrialRowV5Schema),
        excluded_rows: z.array(DiscoveryTrialRowV5Schema).default([]),
    }),
);
export type DiscoveryTrialsV5 = z.infer<typeof DiscoveryTrialsV5Schema>;

const AnalyticsV5Shape = AnalyticsShape.extend({
    discovery_trials: DiscoveryTrialsV5Schema,
    quality_gates: QualityGatesSchema,
    recommendation_audit: RecommendationAuditSchema.optional(),
});

export const DossierV5Schema = z.object({
    schema_version: z.literal("5"),
    entity: EntitySchema,
    generated_at: z.string(),
    liability_summary: LiabilitySummaryV4Schema,
    tractability: TractabilityV4Schema,
    indications: IndicationsSchema,
    drug_interactions: DrugInteractionsSchema,
    clinical_development: ClinicalDevelopmentV5Schema,
    safety_profile: SafetyProfileV5Schema,
    off_tissue_risk: OffTissueRiskSchema,
    off_target_panel: withCoverage(OffTargetPanelV4Schema),
    reference_biology: ReferenceBiologyV4Shape,
    analytics: AnalyticsV5Shape,
    executive_recommendation: ExecutiveRecommendationSchema,
    derived: DerivedV4Schema,
});
export type DossierV5 = z.infer<typeof DossierV5Schema>;

export const DossierV5BodySchema = DossierV5Schema.omit({ derived: true });
export type DossierV5Body = z.infer<typeof DossierV5BodySchema>;

// Retain the v3 export under a legacy alias for any code that still reads
// persisted v3 dossiers (phase4-assemble, tests, integration).
export const DossierSchemaV3Legacy = z.object({
    schema_version: z.literal("3"),
    ...DossierCommonShape,
    analytics: AnalyticsShape,
    executive_recommendation: ExecutiveRecommendationSchema,
});

// Re-bind the Dossier type alias to v5 so downstream consumers picking up
// `Dossier` get the current persisted shape transparently.
export type Dossier = DossierV5;

// ── Type guards ─────────────────────────────────────────────────────

export function isDossier(value: unknown): value is Dossier {
    return DossierV5Schema.safeParse(value).success;
}

/** JSON Schema export for runtime validation in non-TS environments. */
export function dossierJsonSchema(): unknown {
    return z.toJSONSchema(DossierV5Schema);
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
