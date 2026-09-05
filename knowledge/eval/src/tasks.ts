/**
 * The task set: the YAML plus the data profile the planner reads for each
 * task. The profile has the shape of the persisted `DataProfileResult` of the
 * harness, built from the simulated dataset (the dimensions and the columns)
 * and from the task facts (the organism, the design, the concerns), because
 * the planner reads the profile from the analysis state and never a file.
 */

import { join } from "node:path";
import { z } from "zod";

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
export async function buildProfile(task: Task, seed = 1): Promise<Record<string, unknown>> {
    const dir = datasetDir(task, seed);
    const counts = await csvShape(join(dir, "counts.csv"));
    const metadata = await csvShape(join(dir, "metadata.csv"));
    const columns = metadata.header.filter((column) => column !== "sample");
    return {
        summary: `Bulk RNA-seq raw gene-level count matrix (${counts.rows} genes x ${counts.cols - 1} samples) with a sample table (${metadata.rows} samples; columns: ${metadata.header.join(", ")}).`,
        files: [
            {
                path: "data/inputs/counts/counts.csv",
                description: `Raw integer gene-level counts from ${task.count_source}; first column gene symbol, one column per sample`,
                dataType: "count-matrix",
                format: "CSV",
                rows: counts.rows,
                cols: counts.cols,
            },
            {
                path: "data/inputs/metadata/metadata.csv",
                description: `Sample table: one row per sample with ${columns.join(", ")}`,
                dataType: "clinical-metadata",
                format: "CSV",
                rows: metadata.rows,
                cols: metadata.cols,
            },
        ],
        profiledAt: "2026-09-04T12:00:00.000Z",
        domain: "transcriptomics",
        subtype: "bulk-rna-seq",
        organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
        tissue: task.tissue,
        condition: task.condition,
        experimentalDesign: task.experimental_design,
        caveats: task.concerns,
        qualityAssessment: { concerns: task.concerns },
    };
}
