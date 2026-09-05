/**
 * The task set: the YAML plus the data profile the planner reads for each
 * task. The profile has the shape of the persisted `DataProfileResult` of the
 * harness, built from the simulated dataset (the dimensions and the columns)
 * and from the task facts (the organism, the design, the concerns), because
 * the planner reads the profile from the analysis state and never a file.
 */

import { join } from "node:path";
import { z } from "zod";

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
    /** Extra inputs beside the matrix: a DESeq2 results table for an enrichment-only question. */
    extra_inputs: z.array(z.enum(["de_results"])).default([]),
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
const MATRIX: Record<Task["data_state"], { file: string; path: string; describe: (source: string) => string; dataType: string; summary: string }> = {
    counts: { file: "counts.csv", path: "data/inputs/counts/counts.csv", describe: (source) => `Raw integer gene-level counts from ${source}; first column gene symbol, one column per sample`, dataType: "count-matrix", summary: "raw gene-level count matrix" },
    tpm_or_fpkm: { file: "tpm.csv", path: "data/inputs/abundance/tpm.csv", describe: (source) => `Gene-level TPM abundances from ${source} (no raw counts were kept); first column gene symbol, one column per sample`, dataType: "abundance-matrix", summary: "gene-level TPM abundance matrix" },
    log_normalized: { file: "log_expr.csv", path: "data/inputs/expression/log_expr.csv", describe: () => "Log2-scale normalized expression values (log2(TPM + 1)) as delivered by the core facility; first column gene symbol, one column per sample", dataType: "expression-matrix", summary: "log2-scale normalized expression matrix" },
    fastq: { file: "counts.csv", path: "data/inputs/reads/", describe: () => "Paired-end FASTQ read files, one pair per sample, not yet quantified", dataType: "raw-reads", summary: "set of paired-end FASTQ read files" },
};

export async function buildProfile(task: Task, seed = 1): Promise<Record<string, unknown>> {
    const dir = datasetDir(task, seed);
    const matrix = MATRIX[task.data_state];
    const shape = await csvShape(join(dir, matrix.file));
    const metadata = await csvShape(join(dir, "metadata.csv"));
    const columns = metadata.header.filter((column) => column !== "sample" && !task.hide_columns.includes(column));
    const organism = ORGANISMS[task.organism];
    const matrixFile =
        task.data_state === "fastq"
            ? { path: matrix.path, description: `${matrix.describe(task.count_source)} (${shape.cols - 1} samples)`, dataType: matrix.dataType, format: "FASTQ", rows: 0, cols: shape.cols - 1 }
            : { path: matrix.path, description: matrix.describe(task.count_source), dataType: matrix.dataType, format: "CSV", rows: shape.rows, cols: shape.cols };
    const extra = task.extra_inputs.map((kind) => ({
        path: "data/inputs/results/de_results.csv",
        description: "DESeq2 results table of the treated vs control contrast: gene, base_mean, log2_fold_change, log2_fold_change_unshrunken, lfc_se, stat, pvalue, adjusted_pvalue (every tested gene, no cutoff applied)",
        dataType: kind === "de_results" ? "results-table" : kind,
        format: "CSV",
        rows: shape.rows,
        cols: 8,
    }));
    const summaryShape = task.data_state === "fastq" ? `${shape.cols - 1} samples` : `${shape.rows} genes x ${shape.cols - 1} samples`;
    return {
        summary: `Bulk RNA-seq ${matrix.summary} (${summaryShape}) with a sample table (${metadata.rows} samples; columns: ${["sample", ...columns].join(", ")}).${extra.length > 0 ? " A DESeq2 results table of the primary contrast is included." : ""}`,
        files: [
            matrixFile,
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
