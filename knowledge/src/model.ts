/**
 * The Zod mirror of `schema/inflexa-knowledge.yaml`.
 *
 * LinkML is the source of truth for the classes, and the Python gate
 * (`scripts/linkml-gate.sh`) validates each curated file against the JSON
 * Schema that LinkML generates. This mirror is the runtime type of the build
 * and the service, thus the TypeScript side never trusts a YAML file that the
 * schema did not accept. The two must agree, and `model.test.ts` checks the
 * enumerations against the LinkML file.
 */

import { z } from "zod";

export const QuestionEnum = z.enum(["differential_expression", "enrichment", "qc", "full_plan"]);
export const ModalityEnum = z.enum(["bulk_rna_seq"]);
export const DataStateEnum = z.enum(["fastq", "counts", "tpm_or_fpkm", "log_normalized"]);
export const CountSourceEnum = z.enum(["salmon", "kallisto", "star_featurecounts", "rsem", "unknown"]);
export const OrganismEnum = z.enum(["human", "mouse", "other"]);
export const BatchEnum = z.enum(["none", "known_balanced", "known_confounded", "suspected"]);
export const LibraryTypeEnum = z.enum(["polyA", "total", "three_prime", "unknown"]);
export const StrandednessEnum = z.enum(["verified", "declared_unverified", "unknown"]);
export const QualityFlagEnum = z.enum(["low_depth_sample", "outlier_sample", "sample_identity_doubt", "high_duplication"]);
/** What the enrichment step takes: the full ranked list, a discrete gene list, or per-sample scores. */
export const EnrichmentInputEnum = z.enum(["ranked_list", "gene_list", "sample_scores"]);
export const StepTypeEnum = z.enum([
    "qc_sample_structure",
    "filter_low_counts",
    "normalize",
    "model_design",
    "differential_expression",
    "shrink_lfc",
    "multiple_testing",
    "enrichment",
    "report",
]);
export const StrengthEnum = z.enum(["consensus", "common_practice", "disputed"]);
export const EvidenceQualityEnum = z.enum(["high", "moderate", "low"]);
export const RecommendationStrengthEnum = z.enum(["strong", "conditional"]);
export const SeverityEnum = z.enum(["info", "warn", "flag"]);
export const RuleStatusEnum = z.enum(["active", "scheduled_for_deprecation", "deprecated"]);
export const DirectionEnum = z.enum(["supports", "disputes", "neutral"]);
export const ConditionOpEnum = z.enum(["eq", "ne", "in", "not_in", "contains", "lt", "lte", "gt", "gte", "is_null", "not_null"]);
export const PackageTrackEnum = z.enum(["bioconductor", "cran", "python"]);
export const SlotTypeEnum = z.enum(["string", "number", "integer", "boolean", "string_list", "formula"]);

export type StepType = z.infer<typeof StepTypeEnum>;

/** The situation, as the service validates it. `response_format` is a request option and rides beside it. */
export const SituationSchema = z.object({
    question: QuestionEnum,
    modality: ModalityEnum,
    data_state: DataStateEnum,
    count_source: CountSourceEnum.optional(),
    organism: OrganismEnum,
    n_groups: z.number().int().min(1),
    n_per_group_min: z.number().int().min(1),
    n_per_group_max: z.number().int().min(1),
    paired: z.boolean(),
    blocking_factor: z.string().min(1).nullable().optional(),
    batch: BatchEnum,
    covariates: z.array(z.string().min(1)).optional(),
    n_timepoints: z.number().int().min(1).nullable().optional(),
    library_type: LibraryTypeEnum.optional(),
    strandedness: StrandednessEnum.optional(),
    interaction: z.boolean().optional(),
    quality_flags: z.array(QualityFlagEnum).optional(),
    enrichment_input: EnrichmentInputEnum.optional(),
});
export type Situation = z.infer<typeof SituationSchema>;

/** The preferences of the caller for the answer. They select among equal templates and never change a rule. */
export const PreferencesSchema = z.object({
    language: z.enum(["R", "python"]).optional(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ConditionSchema = z.object({
    field: z.string().min(1),
    op: ConditionOpEnum,
    value: z.union([Scalar, z.array(Scalar)]).optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const ParameterValueSchema = z.object({
    name: z.string().min(1),
    value: z.union([Scalar, z.array(Scalar)]),
    default_source: z.string().optional(),
});
export type ParameterValue = z.infer<typeof ParameterValueSchema>;

export const ActionSchema = z.object({
    step_type: StepTypeEnum,
    method: z.string().regex(/^M-\d{4}$/).optional(),
    parameters: z.array(ParameterValueSchema).optional(),
    forbids: z.array(z.string().regex(/^M-\d{4}$/)).optional(),
    outcome: z.string().optional(),
});

export const AlternativeSchema = z.object({
    method: z.string().regex(/^M-\d{4}$/),
    when: z.string().min(1),
});

export const DisputedSideSchema = z.object({
    label: z.string().min(1),
    method: z.string().regex(/^M-\d{4}$/).optional(),
});

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

export const EvidenceLineSchema = z.object({
    direction: DirectionEnum,
    eco: z.string().regex(/^ECO:\d{7}$/),
    cito: z.string().regex(/^cito:[a-zA-Z]+$/).optional(),
    source: z.string().regex(/^S-\d{4}$/),
    paraphrase: z.string().optional(),
    span: z
        .string()
        .optional()
        .refine((span) => span === undefined || span.trim().split(/\s+/).length <= 25, "a verbatim span holds at most 25 words"),
    anchor: z.string().optional(),
    retrieved: DateString,
});

export const SourceSchema = z.object({
    id: z.string().regex(/^S-\d{4}$/),
    doi: z.string().regex(/^10\.\d{4,9}\/\S+$/).optional(),
    pmid: z.string().regex(/^\d+$/).optional(),
    url: z.string().url().optional(),
    title: z.string().min(1),
    year: z.number().int(),
    venue: z.string().optional(),
    license: z.string().optional(),
    version: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const PackageSchema = z.object({
    name: z.string().min(1),
    track: PackageTrackEnum,
    biotools: z.string().optional(),
    version_range: z.string().optional(),
    bioconductor: z.string().optional(),
});

export const MethodSchema = z.object({
    id: z.string().regex(/^M-\d{4}$/),
    label: z.string().min(1),
    stato: z.string().regex(/^STATO:\d{7}$/).optional(),
    edam_operation: z.string().regex(/^EDAM:operation_\d+$/).optional(),
    packages: z.array(PackageSchema).optional(),
    templates: z.array(z.string().regex(/^tpl-[a-z0-9-]+$/)).optional(),
    description: z.string().optional(),
});
export type Method = z.infer<typeof MethodSchema>;

export const RuleSchema = z.object({
    id: z.string().regex(/^R-\d{4}$/),
    title: z.string().min(1),
    assertion: z.string().min(1),
    modality: ModalityEnum,
    conditions: z.array(ConditionSchema).optional(),
    action: ActionSchema,
    severity: SeverityEnum,
    strength: StrengthEnum,
    evidence_quality: EvidenceQualityEnum,
    recommendation_strength: RecommendationStrengthEnum,
    alternatives: z.array(AlternativeSchema).optional(),
    disputed_sides: z.array(DisputedSideSchema).optional(),
    evidence: z.array(EvidenceLineSchema).min(1),
    status: RuleStatusEnum,
    supersedes: z.string().regex(/^R-\d{4}$/).optional(),
    replaced_by: z.string().regex(/^R-\d{4}$/).optional(),
    license: z.string().min(1),
    curator: z.string().min(1),
    llm_drafted: z.boolean(),
    drafting_model: z.string().optional(),
    curated: DateString,
    tags: z.array(z.string()).optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const TemplateParameterSchema = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: SlotTypeEnum,
    description: z.string().min(1),
    adaptable: z.boolean(),
    required: z.boolean().optional(),
    default: z.union([Scalar, z.array(Scalar)]).optional(),
    default_source: z.string().optional(),
    enum: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
});
export type TemplateParameter = z.infer<typeof TemplateParameterSchema>;

export const TemplateFileSchema = z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    format: z.string().regex(/^EDAM:format_\d+$/).optional(),
    description: z.string().optional(),
});

export const EnvironmentPinSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    track: PackageTrackEnum,
});

export const TemplateTestSchema = z.object({
    name: z.string().min(1),
    dataset: z.string().min(1),
    slots: z.record(z.string(), z.unknown()),
    expect: z.array(z.string()).optional(),
});

export const TemplateSchema = z.object({
    id: z.string().regex(/^tpl-[a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    label: z.string().min(1),
    language: z.enum(["R", "python"]),
    method: z.string().regex(/^M-\d{4}$/),
    step_types: z.array(StepTypeEnum).min(1),
    edam_operations: z.array(z.string()).optional(),
    citations: z.array(z.string().regex(/^S-\d{4}$/)).optional(),
    license: z.string().min(1),
    applicability: z.object({
        modality: ModalityEnum,
        count_sources: z.array(CountSourceEnum).optional(),
        design_patterns: z.array(z.string()).optional(),
        min_replicates: z.number().int().optional(),
        /** Predicates over the Situation, in the syntax of a rule condition. Every one must hold for the template to apply. */
        conditions: z.array(ConditionSchema).optional(),
        notes: z.string().optional(),
    }),
    parameters: z.array(TemplateParameterSchema),
    inputs: z.array(TemplateFileSchema).optional(),
    outputs: z.array(TemplateFileSchema).min(1),
    environment: z.array(EnvironmentPinSchema).min(1),
    bioconductor: z.string().min(1),
    body_file: z.string().min(1),
    tests: z.array(TemplateTestSchema).optional(),
});
export type Template = z.infer<typeof TemplateSchema>;

export const ModalitySchema = z.object({
    id: ModalityEnum,
    label: z.string().min(1),
    step_order: z.array(StepTypeEnum).min(1),
    question_steps: z.record(QuestionEnum, z.array(StepTypeEnum)),
});
export type Modality = z.infer<typeof ModalitySchema>;

export const VocabularyTermSchema = z.object({
    id: z.string().regex(/^INFLEXA:[A-Za-z0-9_]+$/),
    label: z.string().min(1),
    definition: z.string().min(1),
    mapped_to: z.string().optional(),
    mapping_predicate: z.string().optional(),
});
export type VocabularyTerm = z.infer<typeof VocabularyTermSchema>;

export const SnapshotMetaSchema = z.object({
    date: DateString,
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    schema_version: z.string().min(1),
    vocabularies: z.array(z.string()),
    tool_definition_hash: z.string().min(1),
    changelog: z.string().optional(),
    counts: z.record(z.string(), z.number()).optional(),
});
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

/** The whole curated set, as the build reads it from the tree. */
export interface KnowledgeBase {
    readonly sources: readonly Source[];
    readonly methods: readonly Method[];
    readonly rules: readonly Rule[];
    readonly templates: readonly (Template & { readonly body: string })[];
    readonly modalities: readonly Modality[];
    readonly terms: readonly VocabularyTerm[];
}
