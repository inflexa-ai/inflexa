/**
 * The report of a campaign: every run scored, aggregated by arm inside one
 * split and one seed, with the paired bootstrap of the rubric difference over
 * the declared contrast family, the Holm step-down over that family, and one
 * decision per contrast. Markdown and JSON, side by side.
 *
 * The unit of the bootstrap is the cluster of the task: the simulation
 * pattern of a simulated task. The run means of each arm pair up by cluster,
 * the bootstrap resamples clusters, the one-sided 97.5% lower bound answers
 * the non-inferiority question against the margin, and `p_one_sided` is the
 * share of resamples at or below minus the margin. The family comes from the
 * manifest with the primary contrast first. Without a manifest the report
 * derives the with-versus-without pair of each model, and it is exploratory.
 *
 * A decision is `non_inferior` only when Holm rejects the contrast, no
 * judgment is missing, and the calibration of the judge passes. A missing
 * judgment blocks the decision (`blocked_missing_judgments`), an absent or a
 * failed calibration leaves it `uncalibrated`, and a contrast that Holm does
 * not reject is `not_shown`. A failed judge file is an absent judgment. A task
 * with fewer than two judged runs has no within-task variability: the arm
 * reports `unknown`, never zero.
 *
 * The runs of different splits and seeds never pool: each split and seed has
 * its own arm summaries and its own contrasts. A record outside the manifest
 * (its arm, seed, task, snapshot, or manifest digest), a record of an
 * exploratory lane, or a verdict of another judge marks the whole report
 * exploratory, and the report refuses to write unless `--exploratory` is passed.
 *
 *   bun eval/src/report.ts --campaign c1 [--service-url http://127.0.0.1:8790] [--judge-tag opus]
 *   bun eval/src/report.ts --campaign c1 --judge-tag sonnet --contrast with--claude-sonnet-5 without--claude-opus-5 --exploratory
 */

import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { KAPPA_THRESHOLD, rng } from "./calibrate.js";
import { readManifest, type Manifest } from "./freeze.js";
import { CRITERIA, JudgeVerdictSchema } from "./judge.js";
import { splitOf, type FullRunRecord, type RunRecord, type RunSplit } from "./record.js";
import { resolveAgainstSnapshot, scoreRun, type DeterministicScore } from "./score.js";
import { scoreOutputs, type OutputScore } from "./score-outputs.js";
import { datasetDir, EVAL_ROOT, loadTasks, type Task } from "./tasks.js";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

// ── Statistics ──────────────────────────────────────────────────────

export function mean(values: readonly number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The sample standard deviation. Undefined below two values: one value has no spread, and zero would claim one. */
export function sd(values: readonly number[]): number | undefined {
    if (values.length < 2) return undefined;
    const m = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

export const BOOTSTRAP_ITERATIONS = 4000;
export const BOOTSTRAP_SEED = 20260904;

export interface BootstrapOptions {
    /** The non-inferiority margin in rubric points. */
    readonly margin: number;
    readonly iterations?: number;
    readonly seed?: number;
}

export interface BootstrapResult {
    /** The clusters with a judged mean in both arms. */
    readonly n_pairs: number;
    /** The mean paired difference, first arm minus second arm; null without a pair. */
    readonly diff: number | null;
    /** The 2.5% percentile of the bootstrap: the one-sided 97.5% lower bound. Null below two pairs. */
    readonly lower: number | null;
    /** The 97.5% percentile of the bootstrap. Null below two pairs. */
    readonly upper: number | null;
    /** The share of resamples whose mean difference is at or below minus the margin. Null below two pairs. */
    readonly p_one_sided: number | null;
}

/**
 * The paired bootstrap of the mean difference between two arms over the
 * clusters both arms hold. The clusters are resampled with a seeded generator,
 * thus a report is reproducible. One pair has no spread: the difference is
 * reported, the interval and the p-value are not.
 */
export function pairedBootstrap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>, options: BootstrapOptions): BootstrapResult {
    const keys = [...a.keys()].filter((key) => b.has(key)).sort();
    const diffs = keys.map((key) => a.get(key)! - b.get(key)!);
    if (diffs.length === 0) return { n_pairs: 0, diff: null, lower: null, upper: null, p_one_sided: null };
    if (diffs.length < 2) return { n_pairs: 1, diff: diffs[0]!, lower: null, upper: null, p_one_sided: null };
    const iterations = options.iterations ?? BOOTSTRAP_ITERATIONS;
    const random = rng(options.seed ?? BOOTSTRAP_SEED);
    const samples: number[] = [];
    let atOrBelow = 0;
    for (let i = 0; i < iterations; i += 1) {
        let sum = 0;
        for (let j = 0; j < diffs.length; j += 1) sum += diffs[Math.floor(random() * diffs.length)]!;
        const value = sum / diffs.length;
        if (value <= -options.margin) atOrBelow += 1;
        samples.push(value);
    }
    samples.sort((x, y) => x - y);
    return {
        n_pairs: diffs.length,
        diff: mean(diffs),
        lower: samples[Math.floor(0.025 * samples.length)]!,
        upper: samples[Math.floor(0.975 * samples.length)]!,
        p_one_sided: atOrBelow / iterations,
    };
}

/**
 * The Holm step-down over one family of p-values: sorted ascending, the i-th
 * (1-based) is rejected while p_(i) <= alpha / (m - i + 1), and the adjusted
 * value is the running maximum of (m - i + 1) p_(i), capped at 1. A null
 * p-value (a contrast without an interval) counts in the family size, sorts
 * last, keeps a null adjusted value, and is never rejected.
 */
export function holm(p: readonly (number | null)[], alpha: number): { adjusted: (number | null)[]; rejected: boolean[] } {
    const m = p.length;
    const order = p.map((value, index) => ({ value: value ?? 1, index })).sort((x, y) => x.value - y.value || x.index - y.index);
    const adjusted: (number | null)[] = new Array<number | null>(m).fill(null);
    const rejected: boolean[] = new Array<boolean>(m).fill(false);
    let running = 0;
    order.forEach(({ value, index }, rank) => {
        running = Math.max(running, Math.min(1, (m - rank) * value));
        if (p[index] === null) return;
        adjusted[index] = running;
        rejected[index] = running <= alpha;
    });
    return { adjusted, rejected };
}

export type Decision = "non_inferior" | "not_shown" | "blocked_missing_judgments" | "uncalibrated";

/** The decision of one contrast. A missing judgment blocks first, then the calibration gate, then the test. */
export function decide(input: { readonly rejected: boolean; readonly n_missing: number; readonly calibrated: boolean }): Decision {
    if (input.n_missing > 0) return "blocked_missing_judgments";
    if (!input.calibrated) return "uncalibrated";
    return input.rejected ? "non_inferior" : "not_shown";
}

// ── The scored run ──────────────────────────────────────────────────

export interface ScoredRun {
    readonly arm: string;
    readonly condition: string;
    readonly model: string;
    readonly task: string;
    /** The statistical cluster of the task: the simulation pattern of a simulated task. */
    readonly cluster: string;
    readonly run: number;
    readonly seed: number;
    readonly split: RunSplit;
    /** True when the record is outside the manifest, or ran under `--exploratory`. */
    readonly exploratory: boolean;
    /** True when the record reports neither input nor output tokens. */
    readonly usage_missing: boolean;
    readonly score: DeterministicScore;
    /** The executed-output score; present for a record of the end-to-end runner only. */
    readonly outputs?: OutputScore;
    readonly rubric?: number;
    readonly criteria?: Record<string, number>;
    readonly judge?: string;
}

export interface RunGroup {
    readonly split: RunSplit;
    readonly seed: number;
    readonly runs: readonly ScoredRun[];
}

const SPLIT_ORDER: Record<RunSplit, number> = { development: 0, held_out: 1, none: 2 };

/** The runs by split and seed, in split order then seed order. The groups never pool. */
export function groupRuns(runs: readonly ScoredRun[]): RunGroup[] {
    const groups = new Map<string, { split: RunSplit; seed: number; runs: ScoredRun[] }>();
    for (const run of runs) {
        const key = `${run.split}/${run.seed}`;
        const group = groups.get(key) ?? { split: run.split, seed: run.seed, runs: [] };
        group.runs.push(run);
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => SPLIT_ORDER[a.split] - SPLIT_ORDER[b.split] || a.seed - b.seed);
}

// ── The family and the contrasts ────────────────────────────────────

/** `primary` is the manifest family, `derived` the per-model pairs of a campaign without a manifest, `exploratory` the extra pair of `--contrast`. */
export type Family = "primary" | "derived" | "exploratory";

export interface FamilyEntry {
    readonly family: Family;
    /** The contrast as the manifest names it, or the model of a derived pair. */
    readonly label: string;
    /** The two arms by directory name; the difference is the first minus the second. */
    readonly arms: readonly [string, string];
    readonly primary: boolean;
}

/** The directory of an arm, as the runner names it. */
export function armDirectory(condition: string, model: string): string {
    return `${condition}--${model.replace(/[^a-z0-9.-]/gi, "_")}`;
}

/**
 * The contrast family under test. With a manifest: its contrasts in order,
 * the first primary, each arm name resolved to its directory. Without one:
 * the with-versus-without pair of each model in model order, the first
 * primary, as a derived family.
 */
export function familyOf(manifest: Manifest | undefined, runs: readonly Pick<ScoredRun, "arm" | "condition" | "model">[]): FamilyEntry[] {
    if (manifest) {
        const directories = new Map(manifest.arms.map((arm) => [arm.name, armDirectory(arm.condition, arm.model)]));
        return manifest.statistics.contrasts.flatMap(([a, b], index) => {
            const left = directories.get(a);
            const right = directories.get(b);
            return left && right ? [{ family: "primary" as const, label: `${a} vs ${b}`, arms: [left, right] as const, primary: index === 0 }] : [];
        });
    }
    const models = [...new Set(runs.map((run) => run.model))].sort();
    const pairs = models.flatMap((model) => {
        const left = runs.find((run) => run.model === model && run.condition === "with")?.arm;
        const right = runs.find((run) => run.model === model && run.condition === "without")?.arm;
        return left && right ? [{ model, arms: [left, right] as const }] : [];
    });
    return pairs.map(({ model, arms }, index) => ({ family: "derived" as const, label: `${model} with vs without`, arms, primary: index === 0 }));
}

export interface ContrastOptions extends BootstrapOptions {
    /** The one-sided level of the family. */
    readonly alpha: number;
    /** True when the calibration of the judge passes. */
    readonly calibrated: boolean;
}

export interface Contrast extends FamilyEntry, BootstrapResult {
    /** Tasks with a record in both arms and a run without a verdict in at least one of them. */
    readonly n_missing: number;
    readonly holm_adjusted_p: number | null;
    readonly rejected: boolean;
    readonly decision: Decision;
}

/** The judged mean of each cluster of one arm: the run means by task, then the task means by cluster. */
export function clusterMeans(rows: readonly ScoredRun[]): Map<string, number> {
    const byCluster = new Map<string, number[]>();
    for (const task of new Set(rows.map((run) => run.task))) {
        const judged = rows.filter((run) => run.task === task && run.rubric !== undefined).map((run) => run.rubric!);
        if (judged.length === 0) continue;
        const cluster = rows.find((run) => run.task === task)!.cluster;
        byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), mean(judged)]);
    }
    return new Map([...byCluster].map(([cluster, values]) => [cluster, mean(values)]));
}

/**
 * The contrasts of one group of runs: the bootstrap of each family entry, the
 * missing judgments of each pair, the Holm step-down over the family under
 * test (an exploratory extra stays outside it), and the decision.
 */
export function contrastsOf(runs: readonly ScoredRun[], family: readonly FamilyEntry[], options: ContrastOptions): Contrast[] {
    const tested = family.map((entry) => {
        const [a, b] = entry.arms;
        const rowsA = runs.filter((run) => run.arm === a);
        const rowsB = runs.filter((run) => run.arm === b);
        const tasksB = new Set(rowsB.map((run) => run.task));
        const shared = [...new Set(rowsA.map((run) => run.task))].filter((task) => tasksB.has(task));
        const unjudged = (rows: readonly ScoredRun[], task: string): boolean => rows.some((run) => run.task === task && run.rubric === undefined);
        const missing = shared.filter((task) => unjudged(rowsA, task) || unjudged(rowsB, task)).length;
        return { entry, missing, bootstrap: pairedBootstrap(clusterMeans(rowsA), clusterMeans(rowsB), options) };
    });
    const inFamily = tested.map((item, index) => (item.entry.family === "exploratory" ? -1 : index)).filter((index) => index >= 0);
    const { adjusted, rejected } = holm(
        inFamily.map((index) => tested[index]!.bootstrap.p_one_sided),
        options.alpha,
    );
    return tested.map((item, index) => {
        const rank = inFamily.indexOf(index);
        const holmAdjusted = rank >= 0 ? adjusted[rank]! : null;
        const isRejected = rank >= 0 ? rejected[rank]! : false;
        return {
            ...item.entry,
            ...item.bootstrap,
            n_missing: item.missing,
            holm_adjusted_p: holmAdjusted,
            rejected: isRejected,
            decision: decide({ rejected: isRejected, n_missing: item.missing, calibrated: options.calibrated }),
        };
    });
}

// ── The arm summary ─────────────────────────────────────────────────

export type Variability = "unknown" | "estimated";

export interface ArmSummary {
    readonly arm: string;
    readonly condition: string;
    readonly model: string;
    readonly split: RunSplit;
    readonly seed: number;
    readonly runs: number;
    readonly tasks: number;
    readonly judged_runs: number;
    readonly unjudged_runs: number;
    readonly usage_missing_runs: number;
    readonly exploratory_runs: number;
    readonly planned_share: number;
    readonly rubric_mean: number | null;
    /** The mean of the within-task standard deviations; null when the variability is unknown. */
    readonly rubric_sd_within_task: number | null;
    /** `unknown` when any task of the arm has fewer than two judged runs. */
    readonly variability: Variability;
    readonly criteria_means: Record<string, number>;
    readonly expectations_share: number;
    readonly recommend_call_rate: number;
    readonly check_call_rate: number;
    readonly method_steps: number;
    /** Applicable method steps over method steps, pooled over the runs. */
    readonly grounding_share: number;
    readonly grounded_applicable_steps: number;
    readonly flagged_applicable_steps: number;
    readonly inapplicable_steps: number;
    readonly unresolved_steps: number;
    readonly fabricated_steps: number;
    readonly ungrounded_steps: number;
    /** The share of runs whose every method step pins the digest of the record. */
    readonly snapshot_pinned_share: number;
    /** Pinned method steps over method steps, pooled over the runs. */
    readonly snapshot_pinned_steps_share: number;
    readonly claims_total: number;
    readonly claims_applicable: number;
    readonly claims_inapplicable: number;
    readonly claims_unresolved: number;
    readonly claims_fabricated: number;
    readonly claims_resolving: number;
    readonly dois_in_plans: number;
    readonly dois_in_snapshot: number;
    readonly fabricated_references: number;
    /** The runs with an executed-output score. The output fields are null without one. */
    readonly executed_runs: number;
    readonly valid_completion_rate: number | null;
    readonly de_recall_mean: number | null;
    readonly de_fdr_mean: number | null;
    /** The failed steps over the executed runs. */
    readonly failed_steps: number | null;
    /** The mean over the executed runs that completed a step. */
    readonly tokens_per_completed_step: number | null;
    readonly tool_calls_mean: number;
    readonly input_tokens_mean: number;
    readonly output_tokens_mean: number;
    readonly cache_read_tokens_mean: number;
    readonly elapsed_s_mean: number;
}

/** The summary of one arm over the runs of one group. The rows must share the arm, the split, and the seed. */
export function summarizeArm(arm: string, rows: readonly ScoredRun[]): ArmSummary {
    const first = rows[0];
    if (!first) throw new Error(`the arm ${arm} has no run`);
    const scores = rows.map((run) => run.score);
    const judged = rows.filter((run) => run.rubric !== undefined);
    const sum = (pick: (score: DeterministicScore) => number): number => scores.reduce((total, score) => total + pick(score), 0);
    const methodSteps = sum((score) => score.method_steps);
    const applicable = sum((score) => score.grounded_applicable_steps + score.flagged_applicable_steps);
    const tasks = [...new Set(rows.map((run) => run.task))];
    const withinTask = tasks.map((task) => sd(judged.filter((run) => run.task === task).map((run) => run.rubric!)));
    const estimated = withinTask.length > 0 && withinTask.every((value) => value !== undefined);
    const executed = rows.flatMap((run) => (run.outputs ? [run.outputs] : []));
    const recalls = executed.map((output) => output.de_recall).filter((value): value is number => value !== null);
    const fdrs = executed.map((output) => output.de_fdr).filter((value): value is number => value !== null);
    const tokensPerStep = executed.map((output) => output.tokens_per_completed_step).filter((value): value is number => value !== null);
    return {
        arm,
        condition: first.condition,
        model: first.model,
        split: first.split,
        seed: first.seed,
        runs: rows.length,
        tasks: tasks.length,
        judged_runs: judged.length,
        unjudged_runs: rows.length - judged.length,
        usage_missing_runs: rows.filter((run) => run.usage_missing).length,
        exploratory_runs: rows.filter((run) => run.exploratory).length,
        planned_share: mean(scores.map((score) => (score.planned ? 1 : 0))),
        rubric_mean: judged.length ? mean(judged.map((run) => run.rubric!)) : null,
        rubric_sd_within_task: estimated ? mean(withinTask.map((value) => value!)) : null,
        variability: estimated ? "estimated" : "unknown",
        criteria_means: Object.fromEntries(CRITERIA.map(([key]) => [key, mean(judged.map((run) => run.criteria?.[key] ?? 0))])),
        expectations_share: mean(scores.map((score) => (score.expectations_total === 0 ? 1 : score.expectations_met / score.expectations_total))),
        recommend_call_rate: mean(scores.map((score) => (score.knowledge_recommend_calls > 0 ? 1 : 0))),
        check_call_rate: mean(scores.map((score) => (score.knowledge_check_calls > 0 ? 1 : 0))),
        method_steps: methodSteps,
        grounding_share: methodSteps === 0 ? 0 : applicable / methodSteps,
        grounded_applicable_steps: sum((score) => score.grounded_applicable_steps),
        flagged_applicable_steps: sum((score) => score.flagged_applicable_steps),
        inapplicable_steps: sum((score) => score.inapplicable_steps),
        unresolved_steps: sum((score) => score.unresolved_steps),
        fabricated_steps: sum((score) => score.fabricated_steps),
        ungrounded_steps: sum((score) => score.ungrounded_steps),
        snapshot_pinned_share: mean(scores.map((score) => (score.snapshot_pinned ? 1 : 0))),
        snapshot_pinned_steps_share: methodSteps === 0 ? 0 : sum((score) => score.snapshot_pinned_steps) / methodSteps,
        claims_total: sum((score) => score.claims.length),
        claims_applicable: sum((score) => score.claims_applicable),
        claims_inapplicable: sum((score) => score.claims_inapplicable),
        claims_unresolved: sum((score) => score.claims_unresolved),
        claims_fabricated: sum((score) => score.claims_fabricated),
        claims_resolving: sum((score) => score.claims_resolving ?? 0),
        dois_in_plans: sum((score) => score.dois_in_plan.length),
        dois_in_snapshot: sum((score) => score.dois_in_snapshot ?? 0),
        fabricated_references: sum((score) => score.fabricated_references?.length ?? 0),
        executed_runs: executed.length,
        valid_completion_rate: executed.length ? mean(executed.map((output) => (output.valid_completion ? 1 : 0))) : null,
        de_recall_mean: recalls.length ? mean(recalls) : null,
        de_fdr_mean: fdrs.length ? mean(fdrs) : null,
        failed_steps: executed.length ? executed.reduce((total, output) => total + output.failed_steps, 0) : null,
        tokens_per_completed_step: tokensPerStep.length ? mean(tokensPerStep) : null,
        tool_calls_mean: mean(scores.map((score) => score.tool_calls)),
        input_tokens_mean: Math.round(mean(scores.map((score) => score.input_tokens))),
        output_tokens_mean: Math.round(mean(scores.map((score) => score.output_tokens))),
        cache_read_tokens_mean: Math.round(mean(scores.map((score) => score.cache_read_tokens))),
        elapsed_s_mean: Math.round(mean(scores.map((score) => score.elapsed_s))),
    };
}

// ── The manifest gate of the report ─────────────────────────────────

/** What the gate reads of one record. */
export interface RecordIdentity {
    readonly condition: string;
    readonly model: string;
    readonly task: string;
    readonly seed: number;
    readonly snapshot?: { readonly digest: string };
    readonly manifest?: { readonly digest: string };
    readonly exploratory?: true;
}

/** What the gate reads of one verdict file. */
export interface VerdictIdentity {
    readonly model?: string;
    readonly prompt_digest?: string;
}

/**
 * The reasons for which one record, and its verdict, are outside the frozen
 * campaign; empty when both are inside. Every reason makes the report
 * exploratory.
 */
export function recordDifferences(manifest: Manifest | undefined, manifestDigest: string | undefined, record: RecordIdentity, verdict?: VerdictIdentity): string[] {
    if (!manifest) return ["the campaign has no manifest"];
    const differences: string[] = [];
    if (record.exploratory) differences.push("a record ran under --exploratory");
    if (!record.manifest) differences.push("a record ran without a manifest");
    else if (record.manifest.digest !== manifestDigest) differences.push(`a record ran under another manifest (${record.manifest.digest})`);
    if (!manifest.arms.some((arm) => arm.condition === record.condition && arm.model === record.model)) differences.push(`the arm ${record.condition} ${record.model} is not a frozen arm`);
    if (![...manifest.seeds.development, ...manifest.seeds.held_out].includes(record.seed)) differences.push(`the seed ${record.seed} is not a frozen seed`);
    if (!manifest.task_set.ids.includes(record.task)) differences.push(`the task ${record.task} is not in the frozen task set`);
    if (record.condition === "with" && record.snapshot?.digest !== manifest.corpus.digest) differences.push(`the snapshot ${record.snapshot?.digest ?? "(none)"} is not the frozen ${manifest.corpus.digest}`);
    if (verdict) {
        if (verdict.model !== undefined && verdict.model !== manifest.judge.model) differences.push(`the judge ${verdict.model} is not the frozen ${manifest.judge.model}`);
        if (verdict.prompt_digest !== manifest.judge.prompt_digest) differences.push(`the judge prompt ${verdict.prompt_digest ?? "(none)"} is not the frozen ${manifest.judge.prompt_digest}`);
    }
    return differences;
}

// ── The campaign directory ──────────────────────────────────────────

const RECORD_FILE = /\.json$/;
const JUDGE_FILE = /\.judge(-[a-z0-9]+)?\.json$/;
const CALIBRATION_DIR = "calibration";

/** One record on disk: a flat file of the planner runner, or the `record.json` of an attempt directory of the end-to-end runner. */
export interface FoundRecord {
    readonly arm: string;
    /** The stem of the record: the file without `.json`, or the name of the attempt directory. */
    readonly name: string;
    readonly record: RunRecord;
    readonly full?: FullRunRecord;
    readonly attemptDir?: string;
}

/**
 * The head of an end-to-end record as the plan scorer reads it. The outcome
 * is the outcome of the planner, because the plan score judges the plan; the
 * execution has its own score. The usage is the total of every role.
 */
export function headOf(full: FullRunRecord): RunRecord {
    const { identity, plan, run: _run, usage, ...head } = full;
    const total: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage.total)) if (typeof value === "number") total[key] = value;
    return {
        ...head,
        run: identity.run,
        outcome: plan.outcome,
        ...(plan.planId ? { planId: plan.planId } : {}),
        ...(plan.plan !== undefined ? { plan: plan.plan } : {}),
        usage: total,
    };
}

async function isDirectory(path: string): Promise<boolean> {
    return stat(path).then(
        (info) => info.isDirectory(),
        () => false,
    );
}

/** Every record of the campaign with its arm. The calibration directory is not an arm. */
export async function listRecords(root: string): Promise<FoundRecord[]> {
    const found: FoundRecord[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === CALIBRATION_DIR) continue;
        const dir = join(root, entry.name);
        for (const name of (await readdir(dir)).sort()) {
            const path = join(dir, name);
            if (await isDirectory(path)) {
                const recordPath = join(path, "record.json");
                if (!(await Bun.file(recordPath).exists())) continue;
                const full = (await Bun.file(recordPath).json()) as FullRunRecord;
                found.push({ arm: entry.name, name, record: headOf(full), full, attemptDir: path });
            } else if (RECORD_FILE.test(name) && !JUDGE_FILE.test(name)) {
                found.push({ arm: entry.name, name: name.replace(RECORD_FILE, ""), record: (await Bun.file(path).json()) as RunRecord });
            }
        }
    }
    return found;
}

type Verdict = { readonly status: "absent" } | { readonly status: "failed" } | { readonly status: "verdict"; readonly scores: Record<string, number>; readonly judge?: string; readonly model?: string; readonly prompt_digest?: string };

/** The verdict of a record: the first file of the candidates that exists. A file that does not parse as a verdict is a failed judgment. */
async function readVerdict(candidates: readonly string[]): Promise<Verdict> {
    for (const path of candidates) {
        const file = Bun.file(path);
        if (!(await file.exists())) continue;
        let raw: unknown;
        try {
            raw = await file.json();
        } catch {
            return { status: "failed" };
        }
        const parsed = JudgeVerdictSchema.safeParse(raw);
        if (!parsed.success) return { status: "failed" };
        const loose = raw as Record<string, unknown>;
        return {
            status: "verdict",
            scores: parsed.data.scores,
            ...(typeof loose.judge === "string" ? { judge: loose.judge } : {}),
            ...(typeof loose.model === "string" ? { model: loose.model } : typeof loose.judge === "string" ? { model: loose.judge } : {}),
            ...(typeof loose.prompt_digest === "string" ? { prompt_digest: loose.prompt_digest } : {}),
        };
    }
    return { status: "absent" };
}

export interface CollectOptions {
    readonly root: string;
    readonly tasks: ReadonlyMap<string, Task>;
    /** `.judge.json`, or `.judge-<tag>.json`. */
    readonly judgeSuffix: string;
    readonly manifest?: Manifest;
    readonly manifestDigest?: string;
    /** The service for the claim resolution. Absent leaves every unrecorded claim unresolved. */
    readonly service?: { readonly url: string; readonly key: string };
}

export interface Collected {
    readonly runs: ScoredRun[];
    /** The distinct reasons for which the report is exploratory. */
    readonly reasons: string[];
    readonly verdicts: { judged: number; failed: number; absent: number };
}

/** The cluster of a task: its simulation pattern. */
export function clusterOf(task: Task): string {
    return task.pattern;
}

/**
 * Score every record of the campaign: the plan score, the claim resolution
 * when a service is given, the executed-output score of an attempt directory,
 * and the verdict. An old record without a seed ran on the default seed of the
 * planner runner, seed 1.
 */
export async function collectRuns(options: CollectOptions): Promise<Collected> {
    const runs: ScoredRun[] = [];
    const reasons = new Set<string>();
    const verdicts = { judged: 0, failed: 0, absent: 0 };
    for (const found of await listRecords(options.root)) {
        const { record } = found;
        const task = options.tasks.get(record.task);
        if (!task) continue;
        const loose = record as Partial<RunRecord>;
        const seed = loose.seed ?? 1;
        const split = loose.split ?? splitOf(options.manifest, task.id, seed);
        let score = scoreRun(record, task);
        if (options.service && (score.claims.length > 0 || score.dois_in_plan.length > 0)) score = await resolveAgainstSnapshot(score, options.service.url, options.service.key);
        const outputs = found.full && found.attemptDir ? await scoreOutputs(found.full, datasetDir(task, seed), found.attemptDir) : undefined;
        const dir = join(options.root, found.arm);
        const verdict = await readVerdict([join(dir, `${found.name}${options.judgeSuffix}`), ...(found.attemptDir ? [join(found.attemptDir, `record${options.judgeSuffix}`)] : [])]);
        verdicts[verdict.status === "verdict" ? "judged" : verdict.status] += 1;
        const identity: RecordIdentity = { condition: record.condition, model: record.model, task: record.task, seed, ...(record.snapshot ? { snapshot: record.snapshot } : {}), ...(record.manifest ? { manifest: record.manifest } : {}), ...(record.exploratory ? { exploratory: true } : {}) };
        const differences = recordDifferences(options.manifest, options.manifestDigest, identity, verdict.status === "verdict" ? verdict : undefined);
        for (const reason of differences) reasons.add(reason);
        const usage = record.usage ?? {};
        runs.push({
            arm: found.arm,
            condition: record.condition,
            model: record.model,
            task: record.task,
            cluster: clusterOf(task),
            run: record.run,
            seed,
            split,
            exploratory: differences.length > 0,
            usage_missing: usage.inputTokens === undefined && usage.outputTokens === undefined,
            score,
            ...(outputs ? { outputs } : {}),
            ...(verdict.status === "verdict"
                ? {
                      rubric: Object.values(verdict.scores).reduce((sum, value) => sum + value, 0) * 1.25,
                      criteria: verdict.scores,
                      ...(verdict.judge ?? verdict.model ? { judge: verdict.judge ?? verdict.model } : {}),
                  }
                : {}),
        });
    }
    return { runs, reasons: [...reasons], verdicts };
}

// ── The report ──────────────────────────────────────────────────────

export interface CalibrationRecord {
    readonly path: string;
    readonly pass?: boolean;
    readonly kappa_total?: number | null;
    readonly threshold?: number;
    readonly [key: string]: unknown;
}

export interface Report {
    readonly campaign: string;
    readonly exploratory: boolean;
    readonly exploratory_reasons: readonly string[];
    readonly manifest: (Manifest & { readonly path: string; readonly digest: string }) | null;
    readonly calibration: CalibrationRecord | null;
    /** True when the calibration passes at the kappa threshold. */
    readonly calibrated: boolean;
    readonly statistics: { readonly margin: number; readonly alpha_one_sided: number; readonly iterations: number; readonly cluster: "pattern" };
    readonly family: readonly FamilyEntry[];
    readonly judges: readonly string[];
    readonly judge_tag: string | null;
    readonly verdicts: { readonly judged: number; readonly failed: number; readonly absent: number };
    readonly service_reachable: boolean;
    readonly splits: readonly { readonly split: RunSplit; readonly seed: number; readonly runs: number; readonly tasks: number; readonly arms: readonly string[] }[];
    readonly summary: readonly ArmSummary[];
    readonly contrasts: readonly (Contrast & { readonly split: RunSplit; readonly seed: number })[];
    readonly runs: readonly ScoredRun[];
}

/** True when the calibration record passes at the kappa threshold. */
export function calibrationPasses(calibration: CalibrationRecord | undefined): boolean {
    if (!calibration) return false;
    const kappa = calibration.kappa_total;
    return calibration.pass === true && typeof kappa === "number" && kappa >= KAPPA_THRESHOLD;
}

export interface BuildOptions {
    readonly campaign: string;
    readonly collected: Collected;
    readonly manifest?: Manifest & { readonly path: string; readonly digest: string };
    readonly calibration?: CalibrationRecord;
    readonly margin: number;
    readonly alpha: number;
    readonly judgeTag?: string;
    readonly serviceReachable: boolean;
    /** The exploratory extra pair of `--contrast`. */
    readonly extraContrast?: readonly [string, string];
    readonly iterations?: number;
}

export function buildReport(options: BuildOptions): Report {
    const { runs, reasons, verdicts } = options.collected;
    const calibrated = calibrationPasses(options.calibration);
    const family: FamilyEntry[] = [
        ...familyOf(options.manifest, runs),
        ...(options.extraContrast ? [{ family: "exploratory" as const, label: `${options.extraContrast[0]} vs ${options.extraContrast[1]}`, arms: options.extraContrast, primary: false }] : []),
    ];
    const groups = groupRuns(runs);
    const contrastOptions: ContrastOptions = { margin: options.margin, alpha: options.alpha, calibrated, ...(options.iterations ? { iterations: options.iterations } : {}) };
    return {
        campaign: options.campaign,
        exploratory: reasons.length > 0,
        exploratory_reasons: reasons,
        manifest: options.manifest ?? null,
        calibration: options.calibration ?? null,
        calibrated,
        statistics: { margin: options.margin, alpha_one_sided: options.alpha, iterations: options.iterations ?? BOOTSTRAP_ITERATIONS, cluster: "pattern" },
        family,
        judges: [...new Set(runs.map((run) => run.judge).filter((judge): judge is string => judge !== undefined))],
        judge_tag: options.judgeTag ?? null,
        verdicts,
        service_reachable: options.serviceReachable,
        splits: groups.map((group) => ({ split: group.split, seed: group.seed, runs: group.runs.length, tasks: new Set(group.runs.map((run) => run.task)).size, arms: [...new Set(group.runs.map((run) => run.arm))].sort() })),
        summary: groups.flatMap((group) => [...new Set(group.runs.map((run) => run.arm))].sort().map((arm) => summarizeArm(arm, group.runs.filter((run) => run.arm === arm)))),
        contrasts: groups.flatMap((group) => contrastsOf(group.runs, family, contrastOptions).map((contrast) => ({ split: group.split, seed: group.seed, ...contrast }))),
        runs,
    };
}

// ── Markdown ────────────────────────────────────────────────────────

function pct(value: number | null): string {
    return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function fixed(value: number | null, digits: number): string {
    return value === null ? "n/a" : value.toFixed(digits);
}

export function renderMarkdown(report: Report): string {
    const lines: string[] = [`# Phase 0 campaign \`${report.campaign}\``, ""];
    if (report.exploratory) lines.push(`**Exploratory report.** ${report.exploratory_reasons.join("; ")}.`, "");
    lines.push(
        report.manifest ? `Manifest: \`${report.manifest.path}\` (${report.manifest.digest}), frozen at ${report.manifest.frozen_at}, corpus ${report.manifest.corpus.digest}.` : "Manifest: none.",
        report.calibration
            ? `Calibration: pass ${report.calibration.pass === true}, kappa_total ${typeof report.calibration.kappa_total === "number" ? report.calibration.kappa_total.toFixed(3) : "n/a"}, threshold ${report.calibration.threshold ?? KAPPA_THRESHOLD}.`
            : "Calibration: absent, thus every decision is uncalibrated.",
    );
    if (report.judges.length > 0) lines.push(`Judge: ${report.judges.join(", ")}${report.judge_tag ? ` (tag ${report.judge_tag})` : ""}.`);
    lines.push(
        `Runs: ${report.runs.length}. Judge verdicts: ${report.verdicts.judged} (${report.verdicts.failed} failed, ${report.verdicts.absent} absent). Service for claim resolution: ${report.service_reachable ? "reachable" : "not reachable (claims unresolved)"}.`,
        `Statistics: margin ${report.statistics.margin}, one-sided alpha ${report.statistics.alpha_one_sided}, cluster by ${report.statistics.cluster}, ${report.statistics.iterations} resamples.`,
        `Family: ${report.family.map((entry) => `${entry.label} [${entry.family}${entry.primary ? ", primary" : ""}]`).join("; ") || "none"}.`,
        "",
    );

    for (const group of report.splits) {
        lines.push(`## Split ${group.split}, seed ${group.seed}: ${group.runs} runs, ${group.tasks} tasks`, "");
        lines.push(
            "| Arm | Runs | Judged | Usage missing | Planned | Rubric mean | Within-task SD | Variability | Expectations | Recommend rate | Check rate | Grounded (applicable) | Pinned steps | Claims A/I/U/F | Fabricated refs | Valid completion | DE recall | DE FDR | Failed steps | Tok/step | Tool calls | In tok | Out tok | Cache tok | Time s |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        );
        const rows = report.summary.filter((row) => row.split === group.split && row.seed === group.seed);
        for (const row of rows) {
            lines.push(
                `| ${row.arm} | ${row.runs} | ${row.judged_runs}/${row.runs} | ${row.usage_missing_runs} | ${pct(row.planned_share)} | ${fixed(row.rubric_mean, 1)} | ${fixed(row.rubric_sd_within_task, 1)} | ${row.variability} | ${pct(row.expectations_share)} | ${pct(row.recommend_call_rate)} | ${pct(row.check_call_rate)} | ${pct(row.grounding_share)} | ${pct(row.snapshot_pinned_steps_share)} | ${row.claims_applicable}/${row.claims_inapplicable}/${row.claims_unresolved}/${row.claims_fabricated} | ${row.fabricated_references} | ${pct(row.valid_completion_rate)} | ${fixed(row.de_recall_mean, 2)} | ${fixed(row.de_fdr_mean, 2)} | ${row.failed_steps ?? "n/a"} | ${row.tokens_per_completed_step === null ? "n/a" : Math.round(row.tokens_per_completed_step)} | ${row.tool_calls_mean.toFixed(1)} | ${row.input_tokens_mean} | ${row.output_tokens_mean} | ${row.cache_read_tokens_mean} | ${row.elapsed_s_mean} |`,
            );
        }
        lines.push("", "### Rubric criteria, mean of 0 to 10", "", `| Arm | ${CRITERIA.map(([key]) => key).join(" | ")} |`, `|---|${CRITERIA.map(() => "---").join("|")}|`);
        for (const row of rows) lines.push(`| ${row.arm} | ${CRITERIA.map(([key]) => (row.criteria_means[key] ?? 0).toFixed(1)).join(" | ")} |`);
        lines.push("", "### Contrasts, paired by cluster (first arm minus second arm)", "");
        lines.push("| Family | Contrast | Arms | Pairs | Missing | Diff | Lower (one-sided 97.5%) | Upper | p one-sided | Holm p | Rejected | Decision |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
        for (const contrast of report.contrasts.filter((row) => row.split === group.split && row.seed === group.seed)) {
            lines.push(
                `| ${contrast.family}${contrast.primary ? " (primary)" : ""} | ${contrast.label} | ${contrast.arms[0]} vs ${contrast.arms[1]} | ${contrast.n_pairs} | ${contrast.n_missing} | ${fixed(contrast.diff, 1)} | ${fixed(contrast.lower, 1)} | ${fixed(contrast.upper, 1)} | ${fixed(contrast.p_one_sided, 4)} | ${fixed(contrast.holm_adjusted_p, 4)} | ${contrast.rejected ? "yes" : "no"} | ${contrast.decision} |`,
            );
        }
        lines.push("");
    }

    lines.push(
        "## Per run",
        "",
        "| Arm | Split | Seed | Task | Run | Outcome | Rubric | Expectations | Steps A/I/U/F/ungrounded | Pinned | Claims A/I/U/F | Recommend | Check | Valid completion | Out tok | Time s | Failed expectations |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const run of [...report.runs].sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.seed - b.seed || a.run - b.run)) {
        const s = run.score;
        lines.push(
            `| ${run.arm} | ${run.split} | ${run.seed} | ${run.task} | ${run.run} | ${s.outcome} | ${run.rubric === undefined ? "absent" : run.rubric.toFixed(0)} | ${s.expectations_met}/${s.expectations_total} | ${s.grounded_applicable_steps + s.flagged_applicable_steps}/${s.inapplicable_steps}/${s.unresolved_steps}/${s.fabricated_steps}/${s.ungrounded_steps} | ${s.snapshot_pinned_steps}/${s.method_steps} | ${s.claims_applicable}/${s.claims_inapplicable}/${s.claims_unresolved}/${s.claims_fabricated} | ${s.knowledge_recommend_calls} | ${s.knowledge_check_calls} | ${run.outputs ? (run.outputs.valid_completion ? "yes" : `no (${run.outputs.missing_outputs.join(", ") || "run not completed"})`) : "n/a"} | ${s.output_tokens} | ${s.elapsed_s} | ${s.failed_expectations.join("; ")} |`,
        );
    }
    return `${lines.join("\n")}\n`;
}

// ── The command ─────────────────────────────────────────────────────

async function fileDigest(path: string): Promise<string> {
    return `sha256:${createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex")}`;
}

if (import.meta.main) {
    const campaign = argument("--campaign") ?? "phase0";
    const serviceUrl = argument("--service-url") ?? "http://127.0.0.1:8790";
    const serviceKey = Bun.env[argument("--service-key-env") ?? "INFLEXA_KNOWLEDGE_SERVICE_KEY"] ?? "";
    const root = join(argument("--out") ?? join(EVAL_ROOT, "results"), campaign);
    const tag = argument("--judge-tag");
    const judgeSuffix = tag ? `.judge-${tag}.json` : ".judge.json";
    const exploratory = process.argv.includes("--exploratory");
    // `--contrast <arm A> <arm B>` adds one exploratory pair outside the family, for
    // example a small model with the tools against another frontier model without.
    const contrastIndex = process.argv.indexOf("--contrast");
    const extraArms = contrastIndex >= 0 ? [process.argv[contrastIndex + 1], process.argv[contrastIndex + 2]] : [];
    const extraContrast = extraArms[0] && extraArms[1] ? ([extraArms[0], extraArms[1]] as const) : undefined;

    const manifestPath = join(root, "manifest.json");
    const manifest = (await Bun.file(manifestPath).exists()) ? { ...(await readManifest(manifestPath)), path: manifestPath, digest: await fileDigest(manifestPath) } : undefined;
    const calibrationPath = join(root, "calibration.json");
    const calibration: CalibrationRecord | undefined = (await Bun.file(calibrationPath).exists()) ? { ...((await Bun.file(calibrationPath).json()) as Record<string, unknown>), path: calibrationPath } : undefined;
    // The frozen statistics win over the options; the options serve a campaign without a manifest.
    const margin = manifest?.statistics.margin ?? Number(argument("--margin") ?? "5");
    const alpha = manifest?.statistics.alpha_one_sided ?? Number(argument("--alpha") ?? "0.025");

    const tasks = new Map((await loadTasks()).map((task) => [task.id, task]));
    const serviceReachable = await fetch(`${serviceUrl}/health`)
        .then((response) => response.ok)
        .catch(() => false);
    const collected = await collectRuns({ root, tasks, judgeSuffix, ...(manifest ? { manifest, manifestDigest: manifest.digest } : {}), ...(serviceReachable ? { service: { url: serviceUrl, key: serviceKey } } : {}) });
    if (collected.reasons.length > 0) {
        if (!exploratory) {
            console.error(`${collected.reasons.join("; ")}. Pass --exploratory to report outside the manifest ${manifestPath}.`);
            process.exit(1);
        }
        console.warn(`exploratory report: ${collected.reasons.join("; ")}`);
    }

    const report = buildReport({ campaign, collected, ...(manifest ? { manifest } : {}), ...(calibration ? { calibration } : {}), margin, alpha, ...(tag ? { judgeTag: tag } : {}), serviceReachable, ...(extraContrast ? { extraContrast } : {}) });
    const markdown = renderMarkdown(report);
    const reportName = tag ? `report-${tag}` : "report";
    await Bun.write(join(root, `${reportName}.md`), markdown);
    await Bun.write(join(root, `${reportName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(markdown);
}
