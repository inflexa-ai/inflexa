/**
 * Schemas for data profiling.
 *
 * Defines the profiler structured output schema used by the data-profile
 * task and sandbox agent.
 */

import { z } from "zod";

// ── Profiler structured output (sandbox agent) ─────────────────────

/** Per-file metadata — includes path so the agent can discover files itself. */
export const ProfilerFileSchema = z.object({
    path: z.string().describe("File path relative to analysis root (e.g. data/inputs/{fileId}/counts.txt)"),
    description: z.string().describe("What this file contains and its role in the analysis"),
    dataType: z
        .string()
        .describe(
            "Semantic data type: count-matrix, normalized-expression, variants, alignments, " +
                "clinical-metadata, clinical-sdtm, clinical-adam, clinical-response, " +
                "pharmacokinetic-data, adverse-events, safety-labs, " +
                "molecular-structures, annotations, document (paper PDF, README, methods doc)",
        ),
    format: z.string().describe("File format (e.g. CSV, TSV, h5ad, MTX, VCF, BAM, SDF, FASTQ)"),
    rows: z.number().nullish(),
    cols: z.number().nullish(),
    tags: z.array(z.string()).optional().describe("Searchable labels for downstream discovery"),
    warnings: z.array(z.string()).optional().describe("Quality issues or concerns specific to this file"),
    metrics: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Identity-establishing facts as flat key-value pairs (e.g. sparsity, delimiter, normalizationState, missingRate)"),
});

/**
 * Where an extracted subject fact came from. Used so downstream agents can
 * judge how much to trust a field and so this profiler can flag conflicts.
 */
export const SubjectSourceEnum = z.enum([
    "metadata", // sample-sheet/header column, internal manifest
    "document", // paper PDF, README, methods doc
    "filename", // file or folder naming convention (GSExxx, "human_", etc.)
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
                "low: inferred from gene IDs or other indirect signals, OR sources disagree (in which case also record the conflict in qualityAssessment.concerns).",
        ),
    notes: z.string().optional().describe("Brief note when source is 'inferred' or confidence is 'low' (one sentence)."),
});
export type Organism = z.infer<typeof OrganismSchema>;

/** Kinds an output may carry. A tree needing more than this is not being grouped. */
export const MAX_KINDS = 30;

/** Axes an output may carry — an experimental design with more varying dimensions is vanishingly rare. */
export const MAX_AXES = 8;

/**
 * Individually described files an output may carry. `files` holds NOTABLE SINGLETONS
 * — the metadata sheet, the README, the paper, an outlier that fits no kind — not the
 * dataset's contents.
 */
export const MAX_NOTABLE_FILES = 50;

/**
 * A repeating set of files that are the same sort of thing.
 *
 * A kind is a claim about MEANING, so only the agent can author one: the input scan
 * reports shapes (these filenames differ only here) and cannot establish that the
 * files are the same sort of thing. Kinds need not correspond one-to-one with observed
 * shapes — one kind may span several shapes, and one shape may split into several
 * kinds.
 *
 * A singleton is a kind of `count` 1. There is one concept with a count, not two
 * concepts with a threshold between them, so degenerate datasets need no special case.
 */
export const KindSchema = z.object({
    name: z.string().describe("Short label for this set, e.g. 'per-patient variant calls', 'reference transcriptome'."),
    memberRepresents: z
        .string()
        .describe(
            "What ONE member of this set represents — 'one patient's somatic variant calls', 'one sequencing lane of one sample'. " +
                "This is your grouping decision stated outright, and it is NOT the description: it cannot be answered by " +
                "restating the shape the scan observed.",
        ),
    description: z.string().describe("What this set contains and the role it plays in the analysis."),
    count: z.number().int().describe("How many files are in this set."),
    pathPattern: z
        .string()
        .describe(
            "Glob matching this set's members, relative to the analysis root (e.g. 'data/inputs/vcf/*.vcf.gz'). " +
                "Coverage is computed by matching this against the scanned tree, so a pattern that matches nothing reads as an uncovered kind.",
        ),
    format: z.string().optional().describe("File format shared by the members (VCF, h5ad, CSV, …)."),
    axisLabels: z
        .array(z.string())
        .max(MAX_AXES)
        .optional()
        .describe("Labels of the axes (see `axes`) that vary across this set's members — the design this kind participates in."),
});
export type ProfilerKind = z.infer<typeof KindSchema>;

/**
 * What varies across a kind's members.
 *
 * The scan reports that a filename position varies and which values it takes; what the
 * variation IS — a subject, a timepoint, a treatment arm, a chromosome shard — is not
 * derivable from the values, so the label is required and agent-supplied. An axis
 * evident from a metadata sheet but not from filenames belongs here too.
 */
export const AxisSchema = z.object({
    label: z.string().describe("What this dimension is: 'patient', 'timepoint', 'treatment arm', 'chromosome shard', 'replicate'."),
    cardinality: z.number().int().describe("How many distinct values this dimension takes."),
    exampleValues: z.array(z.string()).max(20).optional().describe("A few observed values, for orientation."),
    description: z.string().optional().describe("Anything a downstream planner needs about this dimension (ordering, pairing, imbalance)."),
});
export type ProfilerAxis = z.infer<typeof AxisSchema>;

export const ProfilerOutputSchema = z.object({
    /**
     * Notable singletons only. The workspace filesystem is the authoritative file list
     * — `list_files`, `grep`, and the vector index all read the live tree — so a record
     * per input file would store a stale duplicate of something that cannot go wrong.
     */
    files: z.array(ProfilerFileSchema).max(MAX_NOTABLE_FILES),
    kinds: z
        .array(KindSchema)
        .max(MAX_KINDS)
        .describe("The repeating sets this dataset is made of. Group; do not enumerate members — the cap is a hard bound, not a target."),
    axes: z.array(AxisSchema).max(MAX_AXES).optional().describe("What varies across the kinds' members — the experimental design, as far as it is observable."),
    analysisSummary: z.string().describe("Narrative overview of the dataset — structure, content, analytical potential, and limitations"),
    domain: z
        .string()
        .describe("Scientific domain (e.g. transcriptomics, proteomics, genomics, cheminformatics, clinical, imaging, metabolomics, multi-omics)"),
    subtype: z.string().optional().describe("Specific subtype within domain (e.g. bulk-rna-seq, single-cell, LC-MS/MS, whole-genome-sequencing)"),
    organism: OrganismSchema.nullable().describe(
        "Subject organism, identified from any input (metadata files, paper PDFs, READMEs, filenames, accession patterns). " +
            "Set to null ONLY when no input identifies the organism — never guess. " +
            "A null organism is acceptable; a wrong taxon ID is not. " +
            "If inputs disagree on organism, pick the most-trusted source, set confidence accordingly, and add the conflict to qualityAssessment.concerns.",
    ),
    tissue: z
        .string()
        .nullable()
        .optional()
        .describe(
            "Subject tissue or anatomical site when applicable (e.g. 'rectal mucosal biopsy', 'liver', 'PBMC', 'whole blood'). null if not applicable or unknown.",
        ),
    cellType: z
        .string()
        .nullable()
        .optional()
        .describe(
            "Subject cell type when applicable (e.g. 'CD4+ T cells', 'iPSC-derived hepatocytes', 'primary hepatocytes'). null if not applicable or unknown.",
        ),
    condition: z
        .string()
        .nullable()
        .optional()
        .describe(
            "Disease, treatment, or perturbation under study (e.g. 'Ulcerative Colitis vs healthy controls', 'cisplatin dose-response', 'CRISPR knockout of TP53'). null if not applicable or unknown.",
        ),
    accessions: z
        .array(z.string())
        .optional()
        .describe(
            "Public dataset accessions found in any input (filenames, metadata, paper). " +
                "GEO (GSE/GSM), SRA (SRP/SRR/SRX), BioProject (PRJNA/PRJEB/PRJDB), ArrayExpress (E-MTAB-xxxx), dbGaP (phs), EGA (EGAS/EGAD).",
        ),
    experimentalDesign: z.string().optional().describe("Description of experimental design — conditions, groups, comparisons, replicates, pairing"),
    qualityAssessment: z
        .object({
            concerns: z
                .array(z.string())
                .describe(
                    "Dataset-wide quality issues (e.g. batch effects, sample imbalance, high missing rate, conflicting organism declarations across inputs)",
                ),
            strengths: z.array(z.string()).describe("Dataset strengths (e.g. deep coverage, balanced groups, low duplication)"),
        })
        .optional(),
});
export type ProfilerOutput = z.infer<typeof ProfilerOutputSchema>;
