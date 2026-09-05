/**
 * The situation fields as a flat tool input. Each `.describe()` is the whole
 * of what the model knows about a field, thus the descriptions carry the
 * definitions of the terms, and they tell the planner where in the Data
 * Context each value comes from.
 */

import { z } from "zod";

import type { KnowledgeSituation } from "./client.js";

export const SituationFieldsSchema = z.object({
    question: z
        .enum(["differential_expression", "enrichment", "qc", "full_plan"])
        .describe(
            "What the plan needs a procedure for. `full_plan` returns QC, filtering, the model, the test, shrinkage, multiple testing, enrichment, and the report in one answer.",
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
        .describe("The quantifier that produced the counts, when the profile names one."),
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
        if (value !== undefined) situation[key] = value;
    }
    // The schema above validated every field, thus the record has the shape of the client type.
    return situation as unknown as KnowledgeSituation;
}

/** One worked example, in the descriptions of the two planner tools. Examples raise complex-parameter accuracy. */
export const SITUATION_EXAMPLE =
    '{"question":"differential_expression","modality":"bulk_rna_seq","data_state":"counts","count_source":"salmon","organism":"human",' +
    '"n_groups":2,"n_per_group_min":6,"n_per_group_max":6,"paired":false,"batch":"none","quality_flags":["low_depth_sample"]}';
