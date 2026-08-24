/**
 * The profiler's authoring contract.
 *
 * What the agent submits is JUDGEMENT, never enumeration: operations on the scan's menu,
 * what each resulting group means, and the dimensions it saw with the evidence it saw
 * them in. Membership, counts, and display patterns are computed at resolution from the
 * scanner's own templates, so no field here carries a count or a path pattern — those are
 * unrepresentable rather than discouraged, because a discouraged field is a field that
 * gets filled.
 *
 * Every array is bounded, and the bound is the enforcement: an over-long submission is a
 * schema error the agent corrects, never a silent truncation. The governing invariant is
 * that nothing the agent authors grows with the number of input files.
 *
 * The category enums are derived from the shipped vocabulary (`contracts/profile-vocabulary`),
 * so the catalogue this validates against and the catalogue the prompt renders are one list.
 */

import { z } from "zod";

import { DIMENSION_CATEGORY_IDS, DIMENSION_PROBE_IDS, GROUP_CATEGORY_IDS, GROUP_ROLE_IDS } from "../contracts/profile-vocabulary.js";

// ── Bounds ─────────────────────────────────────────────────────────────────

/** Operations one submission may carry — the menu's own bound. */
export const MAX_OPERATIONS = 40;

/** Groups one split may produce. A slot needing more is an identifier, and identifiers are never split. */
export const MAX_SPLIT_GROUPS = 12;

/** Slot values one split group may name. */
export const MAX_SPLIT_VALUES = 50;

export const MAX_MERGE_SETS = 12;

/** Paths one explicit `group` may gather — the leftover aggregate, not the dataset. */
export const MAX_EXPLICIT_PATHS = 50;

/** Members of one group the agent may annotate individually. Never required to be exhaustive. */
export const MAX_MEMBER_ANNOTATIONS = 25;

/** Dataset-level dimensions. An experimental design with more varying dimensions is vanishingly rare. */
export const MAX_DIMENSIONS = 12;

export const MAX_OBSERVATIONS = 6;
export const MAX_RECONCILIATIONS = 4;
export const MAX_EXAMPLE_VALUES = 5;

/** Files a `not-found` probe may name as searched — the probe-searchable set is bounded by design. */
export const MAX_SEARCHED_FILES = 10;

export const MAX_CAVEATS = 10;

// ── Dataset identity ───────────────────────────────────────────────────────

/**
 * Where an extracted subject fact came from. Used so downstream agents can
 * judge how much to trust a field and so this profiler can flag conflicts.
 */
export const SubjectSourceEnum = z.enum([
    "metadata", // sample-sheet/header column, internal manifest
    "document", // paper PDF, README, methods doc
    "filename", // file or folder naming convention
    "user-context", // user-supplied analysis context
    "inferred", // inferred from data content (e.g. gene symbol patterns)
]);
export type SubjectSource = z.infer<typeof SubjectSourceEnum>;

export const OrganismSchema = z.object({
    scientificName: z.string().describe("Latin binomial, e.g. 'Homo sapiens', 'Macaca fascicularis', 'Mus musculus'."),
    taxonId: z.string().describe("NCBI Taxonomy ID as a string, e.g. '9606' (human), '9541' (cynomolgus macaque), '10090' (mouse)."),
    source: SubjectSourceEnum,
    confidence: z
        .enum(["high", "medium", "low"])
        .describe(
            "high: explicit user-context statement, an organism column, or a paper/README statement. " +
                "medium: filename convention or accession lookup. " +
                "low: inferred from gene IDs or other indirect signals, OR sources disagree (in which case also record the conflict in caveats).",
        ),
    notes: z.string().optional().describe("Brief note when source is 'inferred' or confidence is 'low' (one sentence)."),
});
export type Organism = z.infer<typeof OrganismSchema>;

// ── Group annotations ──────────────────────────────────────────────────────

export const MemberAnnotationSchema = z
    .object({
        path: z.string().describe("Path of the member, relative to the analysis root."),
        note: z.string().describe("What is individually notable about THIS member — what you read in it, or why it stands out from its group."),
    })
    .strict();
export type MemberAnnotation = z.infer<typeof MemberAnnotationSchema>;

/**
 * What a group IS, stated by the agent.
 *
 * `.strict()` because the fields NOT here are the point: a count, a path pattern, and a
 * member list are all computed at resolution from the operation's own membership, and a
 * submission that carries one is rejected rather than quietly overridden.
 */
export const GroupAnnotationSchema = z
    .object({
        name: z.string().describe("Short label for this group, e.g. 'per-subject somatic calls', 'the sample sheet'."),
        memberRepresents: z
            .string()
            .describe(
                "What ONE member of this group represents — 'one subject's somatic variant calls', 'one sequencing lane of one sample'. " +
                    "This is your grouping decision stated outright, and it is NOT the description: it cannot be answered by restating " +
                    "an observation the scan already made.",
            ),
        description: z.string().describe("What this group contains and the role it plays in the analysis."),
        role: z.enum(GROUP_ROLE_IDS).describe("The group's role in the dataset, from the shipped vocabulary."),
        category: z
            .enum(GROUP_CATEGORY_IDS)
            .describe(
                "The group's category, from the shipped vocabulary. Pick the most specific category that covers ALL members — " +
                    "members straddling two categories are usually a split you have not made yet. 'other' is allowed and monitored: " +
                    "a wrong specific category is worse than an honest 'other' with a good label.",
            ),
        categoryLabel: z.string().optional().describe("Required when category is 'other': what this group actually is."),
        subtype: z.string().optional().describe("Free refinement below the category (e.g. 'spatial', 'imaging MS', 'targeted panel')."),
        categoryReason: z.string().optional().describe("Why you overrode a pre-suggested category, or chose one the anti-overlap notes make arguable."),
        memberAnnotations: z
            .array(MemberAnnotationSchema)
            .max(MAX_MEMBER_ANNOTATIONS)
            .optional()
            .describe("Individually notable members. Never a member list — annotate the ones you read or that stand out, and no others."),
    })
    .strict();
export type GroupAnnotation = z.infer<typeof GroupAnnotationSchema>;

// ── Menu operations ────────────────────────────────────────────────────────

const UseOperationSchema = z
    .object({
        op: z.literal("use"),
        setId: z.string().describe("A set id from the menu."),
        group: GroupAnnotationSchema,
    })
    .strict();

const SplitBySlotSchema = z
    .object({
        kind: z.literal("slot"),
        slotId: z.string().describe("A slot id of the named set. One group is resolved per distinct value of this slot."),
        group: GroupAnnotationSchema.describe("The annotation every resulting group carries; the slot value distinguishes them."),
    })
    .strict();

const SplitByValuesSchema = z
    .object({
        kind: z.literal("values"),
        slotId: z.string().describe("A slot id of the named set, whose values the mapping below assigns to groups."),
        groups: z
            .array(
                z
                    .object({
                        values: z.array(z.string()).min(1).max(MAX_SPLIT_VALUES).describe("Slot values, verbatim as the menu reported them."),
                        group: GroupAnnotationSchema,
                    })
                    .strict(),
            )
            .min(2)
            .max(MAX_SPLIT_GROUPS),
        rest: GroupAnnotationSchema.optional().describe("Members whose slot value no mapping named. Omit only when the mapping is exhaustive."),
    })
    .strict();

const SplitOperationSchema = z
    .object({
        op: z.literal("split"),
        setId: z.string(),
        by: z.discriminatedUnion("kind", [SplitBySlotSchema, SplitByValuesSchema]),
        reason: z
            .string()
            .describe(
                "Why these values are different substrates: would a downstream step TYPICALLY consume one value's files differently " +
                    "than another's? Identity slots (high-cardinality ids) are never split.",
            ),
    })
    .strict();

const MergeOperationSchema = z
    .object({
        op: z.literal("merge"),
        setIds: z.array(z.string()).min(2).max(MAX_MERGE_SETS).describe("Set ids from the menu, merged into one group."),
        group: GroupAnnotationSchema,
        reason: z.string().describe("Why these sets are one group despite instantiating different templates."),
    })
    .strict();

const GroupOperationSchema = z
    .object({
        op: z.literal("group"),
        paths: z.array(z.string()).min(1).max(MAX_EXPLICIT_PATHS).describe("Paths relative to the analysis root, for files no set speaks for."),
        group: GroupAnnotationSchema,
    })
    .strict();

/**
 * The four ways an agent expresses a grouping.
 *
 * Operations, not freehand patterns: a mistyped value is a rejectable error at submit
 * rather than a silent zero-match, and every run starts from the same menu, so two runs
 * over one tree can only differ where the judgement differs.
 */
export const MenuOperationSchema = z.discriminatedUnion("op", [UseOperationSchema, SplitOperationSchema, MergeOperationSchema, GroupOperationSchema]);
export type MenuOperation = z.infer<typeof MenuOperationSchema>;

// ── Dimensions and their observations ──────────────────────────────────────

const CheckedSchema = z
    .object({
        matched: z.number().int().min(0).describe("Values of this observation found in the other source."),
        of: z.number().int().min(1).describe("Values compared."),
    })
    .strict()
    .describe(
        "A measurement you actually performed. Omit the whole field when you did not perform it — its absence is 'unchecked', " +
            "and there is no way to claim a check that did not happen.",
    );

const SlotObservationSchema = z
    .object({
        kind: z.literal("slot"),
        setId: z.string(),
        slotId: z.string().describe("The slot this dimension is seen in. Cardinality and values are computed from the scan, not asserted."),
        note: z.string().optional(),
    })
    .strict();

const ColumnObservationSchema = z
    .object({
        kind: z.literal("column"),
        path: z.string().describe("The file you read, relative to the analysis root."),
        column: z.string().describe("The column name, verbatim."),
        exampleValues: z.array(z.string()).min(1).max(MAX_EXAMPLE_VALUES).describe("Verbatim example values, so the citation is checkable against the file."),
        distinctValues: z.number().int().min(1).optional().describe("Distinct values in the column, when you counted them."),
        checked: CheckedSchema.optional(),
        checkedAgainst: z.string().optional().describe("What you compared against, when `checked` is present."),
        note: z.string().optional(),
    })
    .strict();

const DocumentObservationSchema = z
    .object({
        kind: z.literal("document"),
        path: z.string().describe("The document or mapping file, relative to the analysis root."),
        citation: z.string().describe("What the document says, close to verbatim."),
        statesCardinality: z.number().int().min(1).optional().describe("The count the document states, when it states one."),
        checked: CheckedSchema.optional(),
        checkedAgainst: z.string().optional().describe("What you compared against, when `checked` is present."),
        note: z.string().optional(),
    })
    .strict();

export const ObservationSchema = z.discriminatedUnion("kind", [SlotObservationSchema, ColumnObservationSchema, DocumentObservationSchema]);
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * A dataset-level thing that varies, with where it was seen.
 *
 * At least one observation, always: a dimension without one is a claim, and a claim is
 * what this schema exists to make unwritable. A slot binding is the ONLY way a group
 * links to a dimension — there is no freehand "this group varies by X" field, so a
 * per-subject dimension attached to a group whose template has no such slot cannot be
 * written down.
 *
 * Naming a slot is not the same as promoting a dimension. Technical, single-set slots
 * (shards, callers, lanes, read pairs) stay on the set; this list is reserved for
 * biological or cross-set variation and must read as the design at a glance. A value
 * constant across the dataset is not a dimension — it is an identity field.
 */
export const DimensionSchema = z
    .object({
        label: z.string().describe("What this dimension is, in the dataset's own words."),
        category: z.enum(DIMENSION_CATEGORY_IDS).describe("The dimension's category, from the shipped vocabulary."),
        categoryLabel: z.string().optional().describe("Required when category is 'other': what actually varies."),
        description: z.string().optional().describe("What a downstream planner needs about this dimension — ordering, pairing, imbalance."),
        observations: z
            .array(ObservationSchema)
            .min(1)
            .max(MAX_OBSERVATIONS)
            .describe("Where you saw it. At least one; a dimension without evidence is refused."),
        reconciliations: z
            .array(
                z
                    .object({
                        note: z.string().describe("What disagrees, and between which observations."),
                        delta: z.number().int().optional().describe("The numeric difference, when the disagreement is a count."),
                    })
                    .strict(),
            )
            .max(MAX_RECONCILIATIONS)
            .optional()
            .describe("Disagreeing observations both stand. Record the delta here; do not pick a winner and do not report one canonical cardinality."),
        nestsUnder: z
            .object({
                dimension: z.string().describe("The label of the dimension this one nests under."),
                evidence: z.string().describe("Path structure or a mapping file's columns — what makes the nesting observable."),
            })
            .strict()
            .optional(),
        treatmentReason: z.string().optional().describe("Required when you deviate from the category's default treatment: why this dataset is the exception."),
    })
    .strict();
export type ProfileDimension = z.infer<typeof DimensionSchema>;

// ── Probe outcomes ─────────────────────────────────────────────────────────

const ProbeFoundSchema = z
    .object({
        probe: z.enum(DIMENSION_PROBE_IDS),
        outcome: z.literal("found"),
        dimension: z.string().describe("The label of the dimension you recorded for it."),
    })
    .strict();

const ProbeNotFoundSchema = z
    .object({
        probe: z.enum(DIMENSION_PROBE_IDS),
        outcome: z.literal("not-found"),
        searched: z
            .array(z.string())
            .min(1)
            .max(MAX_SEARCHED_FILES)
            .describe("The files you looked in — metadata and documentation members, clinical and sample-annotation tables."),
        reason: z.string().describe("Why it is not there. A pointer to where a near-miss landed instead is the most useful form."),
    })
    .strict();

const ProbeConstantSchema = z
    .object({
        probe: z.enum(DIMENSION_PROBE_IDS),
        outcome: z.literal("found-but-constant"),
        value: z.string().describe("The single value the attribute takes across the dataset."),
        evidence: z.string().describe("Where you saw it."),
    })
    .strict();

const ProbeAttestedSchema = z
    .object({
        probe: z.enum(DIMENSION_PROBE_IDS),
        outcome: z.literal("attested"),
        citation: z.string().describe("What the prose says."),
        path: z.string().describe("The document that says it."),
    })
    .strict();

/**
 * One outcome per probe. "Not found after looking" is a correct, complete answer — that
 * is what removes the completeness pressure that otherwise invents dimensions. An
 * attested find is prose-only evidence and can never justify a split.
 */
export const ProbeReportSchema = z.discriminatedUnion("outcome", [ProbeFoundSchema, ProbeNotFoundSchema, ProbeConstantSchema, ProbeAttestedSchema]);
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

// ── The submission ─────────────────────────────────────────────────────────

export const ProfileSubmissionSchema = z
    .object({
        operations: z
            .array(MenuOperationSchema)
            .min(1)
            .max(MAX_OPERATIONS)
            .describe("Your grouping, as operations on the menu. Every kept file lands in exactly one group; whatever you leave unclaimed is swept visibly."),
        dimensions: z
            .array(DimensionSchema)
            .max(MAX_DIMENSIONS)
            .optional()
            .describe("What varies across the dataset, each with the evidence you saw it in. An empty list is a correct answer for a simple tree."),
        probes: z.array(ProbeReportSchema).max(DIMENSION_PROBE_IDS.length).optional().describe("One outcome per probe you were asked to look for."),
        analysisSummary: z.string().describe("Narrative overview of the dataset — structure, content, analytical potential, and limitations."),
        domain: z
            .string()
            .describe("Scientific domain (e.g. transcriptomics, proteomics, genomics, cheminformatics, clinical, imaging, metabolomics, multi-omics)."),
        subtype: z.string().optional().describe("Specific subtype within domain (e.g. bulk-rna-seq, single-cell, LC-MS/MS, whole-genome-sequencing)."),
        organism: OrganismSchema.nullable().describe(
            "Subject organism, identified from any input (metadata files, paper PDFs, READMEs, filenames, accession patterns). " +
                "Set to null ONLY when no input identifies the organism — never guess. " +
                "A null organism is acceptable; a wrong taxon ID is not.",
        ),
        tissue: z.string().nullish().describe("Subject tissue or anatomical site when it is CONSTANT across the dataset. A varying one is a dimension."),
        cellType: z.string().nullish().describe("Subject cell type when it is CONSTANT across the dataset. A varying one is a dimension."),
        condition: z.string().nullish().describe("Disease, treatment, or perturbation under study, when constant. A varying one is a dimension."),
        accessions: z
            .array(z.string())
            .optional()
            .describe(
                "Public dataset accessions found in any input. " +
                    "GEO (GSE/GSM), SRA (SRP/SRR/SRX), BioProject (PRJNA/PRJEB/PRJDB), ArrayExpress (E-MTAB-xxxx), dbGaP (phs), EGA (EGAS/EGAD).",
            ),
        experimentalDesign: z.string().optional().describe("Conditions, groups, comparisons, replicates, pairing — the design as far as it is observable."),
        caveats: z
            .array(z.string())
            .max(MAX_CAVEATS)
            .optional()
            .describe(
                "What a planner must know before designing an analysis, in YOUR words. Companion gaps, incomplete crossings, and " +
                    "reconciliation deltas are computed and recorded separately — do not restate them here.",
            ),
    })
    .strict();
export type ProfileSubmission = z.infer<typeof ProfileSubmissionSchema>;
