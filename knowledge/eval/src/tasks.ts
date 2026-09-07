/**
 * The task set: the YAML plus the data profile the planner reads for each
 * task. The profile has the shape of the persisted `DataProfileResult` of the
 * harness, built from the simulated dataset (the dimensions and the columns)
 * and from the task facts (the organism, the design, the concerns), because
 * the planner reads the profile from the analysis state and never a file.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** The profile entry of each extra input, by kind. The planner reads the profile, never the file. */
const EXTRA_INPUTS: Record<"de_results" | "signature", (rows: number) => { path: string; description: string; dataType: string; format: string; rows: number; cols: number }> = {
    de_results: (rows) => ({
        path: "data/inputs/results/de_results.csv",
        description: "DESeq2 results table of the treated vs control contrast: gene, base_mean, log2_fold_change, log2_fold_change_unshrunken, lfc_se, stat, pvalue, adjusted_pvalue (every tested gene, no cutoff applied)",
        dataType: "results-table",
        format: "CSV",
        rows,
        cols: 8,
    }),
    signature: () => ({
        path: "data/inputs/signature/signature_genes.csv",
        description: "The gene list of the 20-gene signature of the study: one gene symbol per row (column gene), no weights and no direction",
        dataType: "gene-list",
        format: "CSV",
        rows: 20,
        cols: 1,
    }),
};

const EXTRA_SUMMARY: Record<"de_results" | "signature", string> = {
    de_results: "A DESeq2 results table of the primary contrast is included.",
    signature: "The gene list of the 20-gene signature is included as a one-column file.",
};

const ORGANISMS = {
    human: { scientificName: "Homo sapiens", taxonId: "9606" },
    mouse: { scientificName: "Mus musculus", taxonId: "10090" },
    zebrafish: { scientificName: "Danio rerio", taxonId: "7955" },
} as const;

export const TaskSchema = z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    pattern: z.string(),
    question: z.string(),
    tissue: z.string(),
    condition: z.string(),
    experimental_design: z.string(),
    count_source: z.string(),
    concerns: z.array(z.string()),
    reference: z.string(),
    must_match: z.array(z.string()),
    must_not_match: z.array(z.string()),
    /** The organism of the profile. Default human. */
    organism: z.enum(["human", "mouse", "zebrafish"]).default("human"),
    /** The state of the primary matrix the profile describes. `fastq` describes read files and no matrix. */
    data_state: z.enum(["counts", "tpm_or_fpkm", "log_normalized", "fastq"]).default("counts"),
    /**
     * The import state of a count table from a transcript quantifier, as the profile states it. Default `unknown`:
     * the correction state is not recorded. `quantifications` describes per-sample quant.sf directories and a
     * transcript-to-gene map in place of a count matrix. Read only when `data_state` is counts.
     */
    import_state: z.enum(["quantifications", "estimated_counts_with_lengths", "corrected_counts", "integer_counts", "unknown"]).default("unknown"),
    /** Extra inputs beside the matrix: a DESeq2 results table for an enrichment-only question, or the gene list of a signature. */
    extra_inputs: z.array(z.enum(["de_results", "signature"])).default([]),
    /** Metadata columns the profile does not describe, for example a batch column the analyst did not record. */
    hide_columns: z.array(z.string()).default([]),
    /** A user constraint the planner receives as it is, for example a language. */
    constraints: z.string().optional(),
    /** The terminal outcome a correct planner reaches. Default a submitted plan. */
    expected_outcome: z.enum(["plan_submitted", "clarification_needed"]).default("plan_submitted"),
});
export type Task = z.infer<typeof TaskSchema>;

export const EVAL_ROOT = join(import.meta.dir, "..");

export async function loadTasks(path = join(EVAL_ROOT, "tasks", "tasks.yaml")): Promise<Task[]> {
    const raw = Bun.YAML.parse(await Bun.file(path).text());
    return z.array(TaskSchema).parse(raw);
}

export function datasetDir(task: Task, seed = 1): string {
    return join(EVAL_ROOT, "data", task.pattern, `seed-${seed}`);
}

async function csvShape(path: string): Promise<{ rows: number; cols: number; header: string[] }> {
    const text = await Bun.file(path).text();
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const header = (lines[0] ?? "").split(",").map((cell) => cell.replace(/^"|"$/g, ""));
    return { rows: lines.length - 1, cols: header.length, header };
}

/**
 * The data profile record, in the shape the harness persists. The analysis id
 * gives the input paths their `/{analysisId}/data/inputs/...` form, which the
 * orientation projects into the planner seed.
 */
/**
 * The description of a count table by its import state. The state says whether the length correction
 * occurred; the quantifier name alone does not. The `quantifications` state describes no table: the
 * profile carries the quantification directories in its place (see `buildProfile`).
 */
const COUNTS_BY_STATE: Record<Exclude<Task["import_state"], "quantifications">, (source: string) => string> = {
    integer_counts: (source) => `Raw integer gene-level counts from ${source}; no transcript-level data and no per-sample transcript lengths; first column gene symbol, one column per sample`,
    corrected_counts: (source) => `Gene-level counts from abundance made by ${source} with tximport (lengthScaledTPM); the length correction is inside the counts, thus the model takes no length offset; non-integer values; first column gene symbol, one column per sample`,
    estimated_counts_with_lengths: (source) =>
        `Gene-level estimated counts from ${source} summed with tximport (countsFromAbundance no), non-integer values, with the average transcript length table beside them; the length correction is not inside the counts; first column gene symbol, one column per sample`,
    unknown: (source) => `Gene-level counts from ${source} as delivered; the record does not say whether the length correction occurred, and no quantification directories and no transcript length table were delivered; first column gene symbol, one column per sample`,
};

const MATRIX: Record<Task["data_state"], { file: string; path: string; describe: (source: string, state: Task["import_state"]) => string; dataType: string; summary: string }> = {
    counts: { file: "counts.csv", path: "data/inputs/counts/counts.csv", describe: (source, state) => COUNTS_BY_STATE[state === "quantifications" ? "unknown" : state](source), dataType: "count-matrix", summary: "raw gene-level count matrix" },
    tpm_or_fpkm: { file: "tpm.csv", path: "data/inputs/abundance/tpm.csv", describe: (source) => `Gene-level TPM abundances from ${source} (no raw counts were kept); first column gene symbol, one column per sample`, dataType: "abundance-matrix", summary: "gene-level TPM abundance matrix" },
    log_normalized: { file: "log_expr.csv", path: "data/inputs/expression/log_expr.csv", describe: () => "Log2-scale normalized expression values (log2(TPM + 1)) as delivered by the core facility; first column gene symbol, one column per sample", dataType: "expression-matrix", summary: "log2-scale normalized expression matrix" },
    fastq: { file: "counts.csv", path: "data/inputs/reads/", describe: () => "Paired-end FASTQ read files, one pair per sample, not yet quantified", dataType: "raw-reads", summary: "set of paired-end FASTQ read files" },
};

/** One profiled file, in the shape the harness persists. */
interface ProfileFile {
    readonly path: string;
    readonly description: string;
    readonly dataType: string;
    readonly format: string;
    readonly rows: number;
    readonly cols: number;
}

/** The per-sample quantification tree of a Salmon dataset: the samples that hold a quant.sf, and the transcript count of the first. */
async function quantShape(dir: string): Promise<{ samples: string[]; transcripts: number }> {
    const entries = await readdir(join(dir, "quant"), { withFileTypes: true });
    const samples = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    if (samples.length === 0) throw new Error(`no per-sample quant.sf under ${join(dir, "quant")}`);
    const text = await Bun.file(join(dir, "quant", samples[0]!, "quant.sf")).text();
    return { samples, transcripts: text.split(/\r?\n/).filter((line) => line.length > 0).length - 1 };
}

/**
 * The files of the quantifications state: the per-sample Salmon directories and the transcript-to-gene map,
 * in place of a count matrix. The planner reads these entries and must ask for the tximport import.
 */
async function quantificationFiles(dir: string, source: string): Promise<{ files: ProfileFile[]; summary: string }> {
    const quant = await quantShape(dir);
    const tx2gene = await csvShape(join(dir, "tx2gene.csv"));
    return {
        files: [
            {
                path: "data/inputs/quant/",
                description: `${source} quantification directories, one per sample (<sample>/quant.sf with the columns Name, Length, EffectiveLength, TPM, NumReads); transcript-level estimates, NumReads is not an integer; ${quant.samples.length} samples, ${quant.transcripts} transcripts; no gene-level count matrix was delivered`,
                dataType: "transcript-quantification",
                format: "TSV",
                rows: quant.transcripts,
                cols: 5,
            },
            {
                path: "data/inputs/quant/tx2gene.csv",
                description: "Transcript-to-gene map of the annotation: one row per transcript with the columns transcript and gene, in the identifier space of the quant.sf Name column",
                dataType: "identifier-map",
                format: "CSV",
                rows: tx2gene.rows,
                cols: tx2gene.cols,
            },
        ],
        summary: `${source} transcript quantifications (${quant.transcripts} transcripts x ${quant.samples.length} samples, one quant.sf per sample) and a transcript-to-gene map`,
    };
}

/** The average transcript length table of the estimated_counts_with_lengths state, described from the gene lengths of the dataset. */
async function lengthsFile(dir: string): Promise<ProfileFile> {
    const lengths = await csvShape(join(dir, "gene_lengths.csv"));
    return {
        path: "data/inputs/lengths/gene_lengths.csv",
        description: "Average transcript length per gene from the quantifier, for the length offset of the count model; first column gene symbol",
        dataType: "length-table",
        format: "CSV",
        rows: lengths.rows,
        cols: lengths.cols,
    };
}

export async function buildProfile(task: Task, seed = 1): Promise<Record<string, unknown>> {
    const dir = datasetDir(task, seed);
    const matrix = MATRIX[task.data_state];
    const shape = await csvShape(join(dir, matrix.file));
    const metadata = await csvShape(join(dir, "metadata.csv"));
    const columns = metadata.header.filter((column) => column !== "sample" && !task.hide_columns.includes(column));
    const organism = ORGANISMS[task.organism];
    const quantifications = task.data_state === "counts" && task.import_state === "quantifications" ? await quantificationFiles(dir, task.count_source) : undefined;
    const withLengths = task.data_state === "counts" && task.import_state === "estimated_counts_with_lengths" ? [await lengthsFile(dir)] : [];
    const matrixFile: ProfileFile =
        task.data_state === "fastq"
            ? { path: matrix.path, description: `${matrix.describe(task.count_source, task.import_state)} (${shape.cols - 1} samples)`, dataType: matrix.dataType, format: "FASTQ", rows: 0, cols: shape.cols - 1 }
            : { path: matrix.path, description: matrix.describe(task.count_source, task.import_state), dataType: matrix.dataType, format: "CSV", rows: shape.rows, cols: shape.cols };
    const primary: ProfileFile[] = quantifications ? quantifications.files : [matrixFile, ...withLengths];
    const extra = task.extra_inputs.map((kind) => EXTRA_INPUTS[kind](shape.rows));
    const summaryShape = task.data_state === "fastq" ? `${shape.cols - 1} samples` : `${shape.rows} genes x ${shape.cols - 1} samples`;
    const summaryPrimary = quantifications ? quantifications.summary : `${matrix.summary} (${summaryShape})`;
    return {
        summary: `Bulk RNA-seq ${summaryPrimary} with a sample table (${metadata.rows} samples; columns: ${["sample", ...columns].join(", ")}).${task.extra_inputs.map((kind) => ` ${EXTRA_SUMMARY[kind]}`).join("")}`,
        files: [
            ...primary,
            {
                path: "data/inputs/metadata/metadata.csv",
                description: `Sample table: one row per sample with ${columns.join(", ")}`,
                dataType: "clinical-metadata",
                format: "CSV",
                rows: metadata.rows,
                cols: columns.length + 1,
            },
            ...extra,
        ],
        profiledAt: "2026-09-04T12:00:00.000Z",
        domain: "transcriptomics",
        subtype: "bulk-rna-seq",
        organism: { ...organism, source: "metadata", confidence: "high" },
        tissue: task.tissue,
        condition: task.condition,
        experimentalDesign: task.experimental_design,
        caveats: task.concerns,
        qualityAssessment: { concerns: task.concerns },
    };
}
