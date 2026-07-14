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
        .describe("Format-specific profiling metrics as flat key-value pairs (e.g. sparsity, medianLibrarySize, tiTvRatio, gcContent, missingRate)"),
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

export const ProfilerOutputSchema = z.object({
    files: z.array(ProfilerFileSchema),
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
