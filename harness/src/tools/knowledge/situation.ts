/**
 * The situation fields as a flat tool input. Each `.describe()` is the whole
 * of what the model knows about a field, thus the descriptions carry the
 * definitions of the terms, and they tell the planner where in the Data
 * Context each value comes from.
 */

import { z } from "zod";

import type { KnowledgeSituation, KnowledgePreferences } from "./client.js";

export const SituationFieldsSchema = z.object({
    question: z
        .enum([
            "differential_expression",
            "enrichment",
            "qc",
            "full_plan",
            "tf_activity",
            "deconvolution",
            "coexpression",
            "clustering",
            "survival",
            "signature_scoring",
        ])
        .describe(
            "What the plan needs a procedure for. `full_plan` returns QC, filtering, the model, the test, shrinkage, multiple testing, enrichment, and the report in one answer. " +
                "Use `differential_expression` when the research question does not ask for pathways or gene sets; an enrichment step the user did not ask for is unasked scope. " +
                "Use `enrichment` when a results table is the input and no new test is fitted, and `qc` when the question stops at the sample structure. " +
                "Use `tf_activity` for regulator or pathway activity, `deconvolution` for cell type proportions, `coexpression` for modules, `clustering` for sample subgroups, `survival` for an outcome association, " +
                "and `signature_scoring` for a per-sample score, or with `classifier: true` for a classifier of the samples.",
        ),
    modality: z.literal("bulk_rna_seq").describe("The assay. Phase 0 serves bulk RNA-seq only."),
    data_state: z
        .enum(["fastq", "counts", "tpm_or_fpkm", "log_normalized"])
        .describe(
            "The state of the expression data in the inputs: raw reads, a raw integer count matrix, TPM/FPKM/RPKM abundances, or log-scale normalized values (log-CPM, microarray).",
        ),
    count_source: z
        .enum(["salmon", "kallisto", "star_featurecounts", "rsem", "unknown"])
        .optional()
        .describe(
            "The quantifier that produced the counts, when the profile names one. The quantifier does not establish the length correction; `import_state` does.",
        ),
    import_state: z
        .enum(["quantifications", "estimated_counts_with_lengths", "corrected_counts", "integer_counts", "unknown"])
        .optional()
        .describe(
            "The import state of a count table from a transcript quantifier (Salmon, kallisto, RSEM): whether the length correction occurred. Read it from the profile. " +
                "`quantifications`: per-sample quantification files (quant.sf or abundance.h5) or a quantification directory, plus a transcript-to-gene map. " +
                "`estimated_counts_with_lengths`: a fractional gene-by-sample matrix plus a table of average transcript lengths per gene and sample. " +
                "`corrected_counts`: a table described as lengthScaledTPM or scaledTPM counts. " +
                "`integer_counts`: integer counts from an aligner and a counter (STAR, featureCounts) or from a 3' protocol, with no length data. " +
                "`unknown`: a count table from a quantifier with no statement of the correction. Omit when `data_state` is not `counts`.",
        ),
    organism: z.enum(["human", "mouse", "other"]).describe("The organism of the samples."),
    n_groups: z.number().int().min(1).describe("The number of levels of the condition of interest (2 for a two-group comparison; 4 for a 2x2 design)."),
    n_per_group_min: z.number().int().min(1).describe("The smallest number of biological replicates in any group. 1 means a group has no replication."),
    n_per_group_max: z.number().int().min(1).describe("The largest number of biological replicates in any group."),
    paired: z.boolean().describe("True when each subject contributes a sample to more than one condition (paired or repeated measures)."),
    blocking_factor: z
        .string()
        .min(1)
        .nullable()
        .optional()
        .describe("The name of a blocking factor that is not the condition, for example `subject` or `donor`. Omit when there is none."),
    batch: z
        .enum(["none", "known_balanced", "known_confounded", "suspected"])
        .describe(
            "The batch structure: none; a known batch whose levels each hold every condition; a known batch whose levels coincide with the conditions; or a suspected structure (dates, lanes, plates) the metadata does not name.",
        ),
    covariates: z
        .array(z.string().min(1))
        .optional()
        .describe('Other sample covariates the design must hold, by column name, for example ["sex", "age"]. Omit when there are none.'),
    n_timepoints: z.number().int().min(1).nullable().optional().describe("The number of time points when the design is a time course. Omit otherwise."),
    library_type: z.enum(["polyA", "total", "three_prime", "unknown"]).optional().describe("The library preparation, when known."),
    strandedness: z
        .enum(["verified", "declared_unverified", "unknown"])
        .optional()
        .describe("Whether the strandedness was verified against the quantification, declared but not verified, or unknown."),
    interaction: z.boolean().optional().describe("True when the question is the interaction of two factors (for example genotype by treatment)."),
    classifier: z
        .boolean()
        .optional()
        .describe(
            "Set true when the question is a classifier of the samples into classes (a model that predicts the class of a sample from its expression, with cross-validation). Omit for a per-sample score.",
        ),
    extra_analyses: z
        .array(
            z.enum([
                "variance_partition",
                "tf_activity",
                "pathway_activity",
                "signature_scoring",
                "deconvolution",
                "coexpression",
                "clustering",
                "survival",
                "transcript_level",
                "annotation",
            ]),
        )
        .optional()
        .describe(
            "Analyses the research question asks for beside the question kind, for example a regulator activity beside a differential expression. Each joins the procedure at its place. Omit when none.",
        ),
    preferred_language: z
        .enum(["R", "python"])
        .optional()
        .describe(
            "The script language the user asked for, when the user constraints name one. The answer then names the template in that language when the method has one. Omit otherwise.",
        ),
    enrichment_input: z
        .enum(["ranked_list", "gene_list", "sample_scores"])
        .optional()
        .describe(
            "What the enrichment step takes: `ranked_list` for every tested gene ranked by a statistic (the default), `gene_list` for a discrete list such as the significant genes, `sample_scores` for a pathway score per sample. Omit when the question has no enrichment.",
        ),
    quality_flags: z
        .array(z.enum(["low_depth_sample", "outlier_sample", "sample_identity_doubt", "high_duplication"]))
        .optional()
        .describe(
            "The quality concerns of the profile as typed flags: a sample with a library size far below the median; a sample that does not cluster with its group; a doubt about the identity of a sample; high duplication.",
        ),
});

export type SituationFields = z.infer<typeof SituationFieldsSchema>;

/** The situation as the client sends it: the fields as given, with an absent optional field omitted. */
export function toSituation(fields: SituationFields): KnowledgeSituation {
    const situation: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (key === "preferred_language") continue;
        if (value !== undefined) situation[key] = value;
    }
    // The schema above validated every field, thus the record has the shape of the client type.
    return situation as unknown as KnowledgeSituation;
}

/** The preferences of the caller, beside the situation: the language of the template. */
export function toPreferences(fields: SituationFields): KnowledgePreferences | undefined {
    return fields.preferred_language ? { language: fields.preferred_language } : undefined;
}

/** One worked example, in the descriptions of the two planner tools. Examples raise complex-parameter accuracy. */
export const SITUATION_EXAMPLE =
    '{"question":"differential_expression","modality":"bulk_rna_seq","data_state":"counts","count_source":"salmon","import_state":"unknown","organism":"human",' +
    '"n_groups":2,"n_per_group_min":6,"n_per_group_max":6,"paired":false,"batch":"none","quality_flags":["low_depth_sample"]}';
