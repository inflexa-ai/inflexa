/**
 * The executed-output score of one end-to-end attempt: what the run produced,
 * measured against the truth of the simulated dataset, with no reading of the
 * prose. The plan score and the judge read the text; this file reads the
 * tables on disk, the step outcomes, and the usage of the record.
 *
 * A valid completion is a run that reached `completed` and left every required
 * output on disk: the DE table always, the enrichment table when the plan
 * holds an enrichment step. A run that failed, or a run that completed without
 * its tables, is not a valid completion whatever its report says.
 *
 * The DE table is the file the record names, and it counts only when it
 * carries the columns `gene`, `log2_fold_change`, and `adjusted_pvalue`, the
 * signature the collector locates it by. Recall and the observed false
 * discovery proportion follow the definitions of the template gate
 * (`truth_recall` and `truth_fdr` in `src/build/template-tests.ts`): a gene is
 * called at `adjusted_pvalue < 0.05`, and a true gene is a row of `truth.csv`
 * with `de` equal to 1. Both are numbers, never verdicts: the tolerances live
 * in the campaign manifest.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { FullRunRecord } from "./record.js";

/** The outputs a run must leave on disk to count as a valid completion. */
export type RequiredOutput = "de_table" | "enrichment_table";

export interface OutputScore {
    /** `run.status` is `completed` and no required output is missing. */
    readonly valid_completion: boolean;
    readonly missing_outputs: readonly RequiredOutput[];
    /** The share of the true DE genes called at `adjusted_pvalue < 0.05`; null without a DE table or without a truth. */
    readonly de_recall: number | null;
    /** The share of the called genes that are not true DE genes; null without a DE table or without a truth. */
    readonly de_fdr: number | null;
    /** The steps that ended `failed`, `blocked`, or `canceled`. A skipped step is the consequence of one of them, not a failure of its own. */
    readonly failed_steps: number;
    /** The wall-clock of the whole attempt, as the record head reports it. */
    readonly total_ms: number;
    /** The input and output tokens of every run step over the steps that completed; null when no step completed. */
    readonly tokens_per_completed_step: number | null;
    /** The run synthesis and the summary of the report step are both on disk. */
    readonly report_present: boolean;
}

/** The column signature of a DE table. */
export const DE_TABLE_COLUMNS = ["gene", "log2_fold_change", "adjusted_pvalue"] as const;

/** The significance level of a call, the same as the template gate. */
const ALPHA = 0.05;

/** The statuses of a step that failed on its own. */
const FAILED_STEP_STATUSES = new Set(["failed", "blocked", "canceled"]);

/** The minimum of the plan a scorer reads: which steps it holds. */
interface PlanStepLike {
    readonly agent?: string;
    readonly step_type?: string;
}

interface PlanLike {
    readonly steps?: readonly PlanStepLike[];
}

/** The rows of a CSV file as the template gate reads them: split on the comma, the surrounding quotes stripped. */
function csvRows(text: string): string[][] {
    return text
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
}

/** One column by name; undefined when the header lacks it. */
function column(rows: readonly string[][], name: string): string[] | undefined {
    const index = rows[0]?.indexOf(name) ?? -1;
    if (index < 0) return undefined;
    return rows.slice(1).map((row) => row[index] ?? "");
}

async function readable(path: string): Promise<boolean> {
    return stat(path).then(
        (info) => info.isFile(),
        () => false,
    );
}

/** The path of one output as the file system sees it: absolute as given, relative under the attempt directory. */
function resolveOutput(path: string, attemptDir: string | undefined): string {
    return isAbsolute(path) || attemptDir === undefined ? path : join(attemptDir, path);
}

/** True when the plan holds an enrichment step: by step type, or by the enrichment agent. */
export function planHoldsEnrichment(plan: unknown): boolean {
    const steps = (plan as PlanLike | null | undefined)?.steps ?? [];
    return steps.some((step) => step.step_type === "enrichment" || step.agent === "enrichment-agent");
}

/** The genes called significant in a DE table; undefined when the file is absent or is not a DE table. */
async function calledGenes(path: string): Promise<Set<string> | undefined> {
    if (!(await readable(path))) return undefined;
    const rows = csvRows(await readFile(path, "utf8"));
    if (rows.length === 0) return undefined;
    const header = rows[0]!;
    if (!DE_TABLE_COLUMNS.every((name) => header.includes(name))) return undefined;
    const genes = column(rows, "gene")!;
    const padj = column(rows, "adjusted_pvalue")!.map(Number);
    return new Set(genes.filter((_gene, index) => Number.isFinite(padj[index]) && padj[index]! < ALPHA));
}

/** The true DE genes of the dataset; undefined when the dataset has no truth. */
async function truthGenes(datasetDir: string): Promise<Set<string> | undefined> {
    const path = join(datasetDir, "truth.csv");
    if (!(await readable(path))) return undefined;
    const rows = csvRows(await readFile(path, "utf8"));
    const genes = column(rows, "gene");
    const de = column(rows, "de");
    if (!genes || !de) return undefined;
    return new Set(genes.filter((_gene, index) => de[index] === "1"));
}

/**
 * Recall and the observed false discovery proportion of a called set against
 * the positives, with the conventions of the template gate: no positives gives
 * a recall of 0, and no call gives a proportion of 0.
 */
export function recallAndFdr(called: ReadonlySet<string>, positives: ReadonlySet<string>): { readonly recall: number; readonly fdr: number } {
    const hits = [...called].filter((gene) => positives.has(gene)).length;
    return {
        recall: positives.size === 0 ? 0 : hits / positives.size,
        fdr: called.size === 0 ? 0 : (called.size - hits) / called.size,
    };
}

/**
 * Score the executed outputs of one attempt. `datasetDir` is the directory of
 * the simulated dataset behind the attempt (its `truth.csv`); `attemptDir`
 * resolves an output path the record holds relative to the attempt.
 */
export async function scoreOutputs(record: FullRunRecord, datasetDir: string, attemptDir?: string): Promise<OutputScore> {
    const outputs = record.outputs;
    const missing: RequiredOutput[] = [];

    const called = outputs.de_table === null ? undefined : await calledGenes(resolveOutput(outputs.de_table, attemptDir));
    if (called === undefined) missing.push("de_table");

    if (planHoldsEnrichment(record.plan.plan)) {
        const present = outputs.enrichment_table !== null && (await readable(resolveOutput(outputs.enrichment_table, attemptDir)));
        if (!present) missing.push("enrichment_table");
    }

    const positives = called === undefined ? undefined : await truthGenes(datasetDir);
    const accuracy = called !== undefined && positives !== undefined ? recallAndFdr(called, positives) : undefined;

    const steps = record.run.steps;
    const completed = steps.filter((step) => step.status === "completed").length;
    const stepTokens = Object.values(record.usage.byStep).reduce((sum, rollup) => sum + (rollup.inputTokens ?? 0) + (rollup.outputTokens ?? 0), 0);

    const synthesisPresent = outputs.synthesis !== null && (await readable(resolveOutput(outputs.synthesis, attemptDir)));
    const summaryPresent = outputs.report_step_summary !== null && (await readable(resolveOutput(outputs.report_step_summary, attemptDir)));

    return {
        valid_completion: record.run.status === "completed" && missing.length === 0,
        missing_outputs: missing,
        de_recall: accuracy?.recall ?? null,
        de_fdr: accuracy?.fdr ?? null,
        failed_steps: steps.filter((step) => FAILED_STEP_STATUSES.has(step.status)).length,
        total_ms: record.elapsedMs,
        tokens_per_completed_step: completed === 0 ? null : stepTokens / completed,
        report_present: synthesisPresent && summaryPresent,
    };
}
