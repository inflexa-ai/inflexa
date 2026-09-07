/**
 * The calibration of the report judge against two blinded experts. The judge
 * of `judge.ts` is accepted only at a quadratic-weighted kappa of at least
 * 0.7 against each expert on the 0-100 total, and the report labels every
 * contrast `uncalibrated` until `calibration.json` says `pass`.
 *
 * The export samples runs of a campaign stratified by arm with a seeded rng
 * (equal allocation per arm, the remainder round-robin in arm order), gives
 * each run an anonymized key, and writes under `results/<campaign>/calibration/`:
 * the key file `sample.json` (key -> arm, task, run, record file), one packet
 * per run holding exactly the user text of `judgePrompt` (the task, the
 * reference, the criteria, the outcome, and the plan; never the arm, the
 * model, or the grounding), and one score-sheet template per expert with the
 * rows `key,criterion,score`. The key file stays with the operator; the
 * experts receive the packets and a sheet.
 *
 * The score step reads the two filled sheets and the judge verdict files of
 * the sampled runs, and computes the quadratic-weighted kappa per criterion
 * (0-10) and on the total (0-100 in 5-point bins), the judge against each
 * expert and the experts against each other. `kappa_total` is the smaller of
 * the two judge-versus-expert totals, `pass` needs both at or above the
 * threshold, and `double_scored_share` is the share of the records of the
 * campaign that both experts scored.
 *
 *   bun eval/src/calibrate.ts --export --campaign c1 --n 40 [--seed 20260904] [--judge-tag opus]
 *   bun eval/src/calibrate.ts --score --campaign c1 --sheets sheet-expert-1.csv sheet-expert-2.csv [--judge-tag opus]
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { CRITERIA, JudgeVerdictSchema, judgePrompt } from "./judge.js";
import type { RunRecord } from "./record.js";
import { EVAL_ROOT, loadTasks, type Task } from "./tasks.js";

export type CriterionKey = (typeof CRITERIA)[number][0];

/** The scores of one rater on one run; a criterion the rater left empty is absent. */
export type Scores = Partial<Record<CriterionKey, number>>;

export const CRITERION_KEYS: readonly CriterionKey[] = CRITERIA.map(([key]) => key);

export const KAPPA_THRESHOLD = 0.7;

/** The width of one bin of the 0-100 total. The bin of a total is floor(total / 5), thus 100 is the bin 20. */
export const TOTAL_BIN = 5;

// ── Kappa ───────────────────────────────────────────────────────────

/**
 * The quadratic-weighted kappa of two raters over paired integer scores. The
 * weight of a cell is the squared distance of the two scores, thus the scale
 * of the categories cancels. Undefined when there is no pair, and when the
 * expected disagreement is zero (both raters used one category only), because
 * the ratio has no meaning there.
 */
export function weightedKappa(pairs: readonly (readonly [number, number])[]): number | undefined {
    if (pairs.length === 0) return undefined;
    const rows = new Map<number, number>();
    const columns = new Map<number, number>();
    let observed = 0;
    for (const [a, b] of pairs) {
        observed += (a - b) ** 2;
        rows.set(a, (rows.get(a) ?? 0) + 1);
        columns.set(b, (columns.get(b) ?? 0) + 1);
    }
    let expected = 0;
    for (const [a, countA] of rows) for (const [b, countB] of columns) expected += ((a - b) ** 2 * countA * countB) / pairs.length;
    if (expected === 0) return undefined;
    return 1 - observed / expected;
}

/** The 0-100 total of a complete score set, as the judge and the report compute it; undefined when a criterion is absent. */
export function totalOf(scores: Scores): number | undefined {
    let sum = 0;
    for (const key of CRITERION_KEYS) {
        const value = scores[key];
        if (value === undefined) return undefined;
        sum += value;
    }
    return sum * 1.25;
}

export function binOf(total: number): number {
    return Math.min(100 / TOTAL_BIN, Math.floor(total / TOTAL_BIN));
}

export interface RaterComparison {
    /** The runs both raters scored on every criterion; the pairs of the total. */
    readonly n: number;
    readonly kappa_total: number | null;
    readonly kappa_by_criterion: Record<CriterionKey, number | null>;
}

/** The agreement of two raters: per criterion over the runs both scored on it, and on the binned total over the runs both completed. */
export function compareRaters(a: ReadonlyMap<string, Scores>, b: ReadonlyMap<string, Scores>): RaterComparison {
    const shared = [...a.keys()].filter((key) => b.has(key));
    const byCriterion = Object.fromEntries(
        CRITERION_KEYS.map((criterion) => {
            const pairs = shared.flatMap((key) => {
                const left = a.get(key)![criterion];
                const right = b.get(key)![criterion];
                return left !== undefined && right !== undefined ? [[Math.round(left), Math.round(right)] as const] : [];
            });
            return [criterion, weightedKappa(pairs) ?? null];
        }),
    ) as Record<CriterionKey, number | null>;
    const totals = shared.flatMap((key) => {
        const left = totalOf(a.get(key)!);
        const right = totalOf(b.get(key)!);
        return left !== undefined && right !== undefined ? [[binOf(left), binOf(right)] as const] : [];
    });
    return { n: totals.length, kappa_total: weightedKappa(totals) ?? null, kappa_by_criterion: byCriterion };
}

// ── The sample ──────────────────────────────────────────────────────

/** A deterministic linear congruential generator, the same as the report uses, thus a sample is reproducible from its seed. */
export function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
}

/** One run as the sample names it. `file` is the record file inside the arm directory. */
export interface SampledRun {
    readonly arm: string;
    readonly task: string;
    readonly run: number;
    readonly file: string;
}

/**
 * Sample `n` runs stratified by arm: each arm is shuffled with the seeded rng
 * and the arms are drawn round-robin in name order, thus the arms are equally
 * represented and the remainder goes to the first arms. The result is shuffled
 * again, thus the position of a run carries no arm. The input order does not
 * matter: the runs are sorted by arm, task, and run before the draw.
 */
export function sampleStratified<T extends SampledRun>(runs: readonly T[], n: number, seed: number): T[] {
    const random = rng(seed);
    const sorted = [...runs].sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.run - b.run || a.file.localeCompare(b.file));
    const arms = [...new Set(sorted.map((run) => run.arm))].sort();
    const pools = new Map(arms.map((arm) => [arm, shuffle(sorted.filter((run) => run.arm === arm), random)]));
    const picked: T[] = [];
    let drawn = true;
    while (picked.length < n && drawn) {
        drawn = false;
        for (const arm of arms) {
            if (picked.length >= n) break;
            const next = pools.get(arm)!.shift();
            if (next) {
                picked.push(next);
                drawn = true;
            }
        }
    }
    return shuffle(picked, random);
}

/** The anonymized keys of a sample: `cal-01` to `cal-<n>`, zero-padded to the width of `n`. */
export function keysFor(n: number): string[] {
    const width = Math.max(2, String(n).length);
    return Array.from({ length: n }, (_, index) => `cal-${String(index + 1).padStart(width, "0")}`);
}

export interface Sample {
    readonly campaign: string;
    readonly seed: number;
    readonly n: number;
    /** The total number of records of the campaign at the export; the denominator of `double_scored_share`. */
    readonly records: number;
    readonly exported_at: string;
    readonly runs: Record<string, SampledRun>;
}

/** The score-sheet template of one expert: one empty row per key and criterion. */
export function sheetTemplate(keys: readonly string[]): string {
    const rows = keys.flatMap((key) => CRITERION_KEYS.map((criterion) => `${key},${criterion},`));
    return `key,criterion,score\n${rows.join("\n")}\n`;
}

// ── The sheets ──────────────────────────────────────────────────────

function cell(value: string | undefined): string {
    return (value ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
}

/**
 * Parse one filled sheet. A row with an empty score is skipped, thus a partly
 * scored run counts on the criteria the expert scored. A score outside 0-10,
 * an unknown criterion, and a duplicate row are refused with the line number.
 */
export function parseSheet(text: string): Map<string, Scores> {
    const lines = text.split(/\r?\n/);
    const header = lines[0]?.split(",").map(cell);
    if (!header || header[0] !== "key" || header[1] !== "criterion" || header[2] !== "score") throw new Error("the sheet does not start with the header key,criterion,score");
    const known = new Set<string>(CRITERION_KEYS);
    const scores = new Map<string, Scores>();
    lines.forEach((line, index) => {
        if (index === 0 || line.trim().length === 0) return;
        const [key, criterion, score] = line.split(",").map(cell);
        if (!key || !criterion) throw new Error(`line ${index + 1} of the sheet has no key or no criterion`);
        if (!known.has(criterion)) throw new Error(`line ${index + 1} of the sheet names the criterion ${criterion}, not one of ${CRITERION_KEYS.join(", ")}`);
        if (!score) return;
        const value = Number(score);
        if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error(`line ${index + 1} of the sheet holds the score ${score}, not a number from 0 to 10`);
        const run = scores.get(key) ?? {};
        if (run[criterion as CriterionKey] !== undefined) throw new Error(`line ${index + 1} of the sheet scores ${key} ${criterion} a second time`);
        run[criterion as CriterionKey] = value;
        scores.set(key, run);
    });
    return scores;
}

// ── The calibration record ──────────────────────────────────────────

export interface CalibrationJudge {
    readonly model: string;
    readonly provider?: string;
    readonly tag?: string;
    readonly prompt_digest?: string;
}

export interface Calibration {
    readonly campaign: string;
    readonly judge: CalibrationJudge;
    readonly experts: readonly string[];
    /** The size of the sample. */
    readonly n: number;
    /** The runs of the sample with a verdict; the others are failed or missing judge files. */
    readonly judged: number;
    /** The smaller of the two judge-versus-expert totals. */
    readonly kappa_total: number | null;
    /** The smaller of the two judge-versus-expert values per criterion. */
    readonly kappa_by_criterion: Record<CriterionKey, number | null>;
    readonly judge_versus_expert: Record<string, RaterComparison>;
    readonly expert_agreement: RaterComparison;
    readonly threshold: number;
    readonly pass: boolean;
    readonly double_scored_share: number;
}

function smaller(a: number | null, b: number | null): number | null {
    return a === null || b === null ? null : Math.min(a, b);
}

export function buildCalibration(input: {
    readonly campaign: string;
    readonly judge: CalibrationJudge;
    readonly sampleSize: number;
    readonly records: number;
    readonly judgeScores: ReadonlyMap<string, Scores>;
    readonly experts: readonly (readonly [string, ReadonlyMap<string, Scores>])[];
    readonly threshold?: number;
}): Calibration {
    const threshold = input.threshold ?? KAPPA_THRESHOLD;
    const [first, second] = input.experts;
    if (!first || !second || input.experts.length !== 2) throw new Error(`the calibration needs two expert sheets, not ${input.experts.length}`);
    const versus = Object.fromEntries(input.experts.map(([name, scores]) => [name, compareRaters(input.judgeScores, scores)]));
    const agreement = compareRaters(first[1], second[1]);
    const values = Object.values(versus);
    const kappaTotal = values.reduce<number | null>((min, comparison) => smaller(min, comparison.kappa_total), values[0]!.kappa_total);
    const byCriterion = Object.fromEntries(CRITERION_KEYS.map((criterion) => [criterion, values.reduce<number | null>((min, comparison) => smaller(min, comparison.kappa_by_criterion[criterion]), values[0]!.kappa_by_criterion[criterion])])) as Record<
        CriterionKey,
        number | null
    >;
    const bothScored = [...first[1].keys()].filter((key) => totalOf(first[1].get(key)!) !== undefined && second[1].has(key) && totalOf(second[1].get(key)!) !== undefined).length;
    return {
        campaign: input.campaign,
        judge: input.judge,
        experts: input.experts.map(([name]) => name),
        n: input.sampleSize,
        judged: input.judgeScores.size,
        kappa_total: kappaTotal,
        kappa_by_criterion: byCriterion,
        judge_versus_expert: versus,
        expert_agreement: agreement,
        threshold,
        pass: values.every((comparison) => comparison.n > 0 && comparison.kappa_total !== null && comparison.kappa_total >= threshold),
        double_scored_share: input.records === 0 ? 0 : bothScored / input.records,
    };
}

// ── The campaign directory ──────────────────────────────────────────

const RECORD_FILE = /\.json$/;
const JUDGE_FILE = /\.judge(-[a-z0-9]+)?\.json$/;
const CALIBRATION_DIR = "calibration";

/** Every record of the campaign with its arm and its file; the calibration directory is not an arm. */
export async function listRecords(root: string): Promise<{ arm: string; file: string; record: RunRecord }[]> {
    const found: { arm: string; file: string; record: RunRecord }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === CALIBRATION_DIR) continue;
        const dir = join(root, entry.name);
        for (const file of (await readdir(dir)).filter((name) => RECORD_FILE.test(name) && !JUDGE_FILE.test(name)).sort()) {
            found.push({ arm: entry.name, file, record: (await Bun.file(join(dir, file)).json()) as RunRecord });
        }
    }
    return found;
}

/**
 * Write the sample, the packets, and the sheet templates. A packet is the
 * user text of the judge prompt and nothing else. A record whose task is not
 * in the task set is not sampled. An existing sample is refused, because a
 * second export would break the key of the sheets the experts hold.
 */
export async function exportSample(options: {
    readonly root: string;
    readonly campaign: string;
    readonly tasks: ReadonlyMap<string, Task>;
    readonly n: number;
    readonly seed: number;
    readonly experts?: number;
    readonly exportedAt?: string;
}): Promise<{ sample: Sample; dir: string }> {
    const dir = join(options.root, CALIBRATION_DIR);
    const samplePath = join(dir, "sample.json");
    if (await Bun.file(samplePath).exists()) throw new Error(`the sample ${samplePath} exists; remove the calibration directory to export again`);
    const records = await listRecords(options.root);
    const candidates = records.filter(({ record }) => options.tasks.has(record.task)).map(({ arm, file, record }) => ({ arm, file, task: record.task, run: record.run, record }));
    const picked = sampleStratified(candidates, options.n, options.seed);
    const keys = keysFor(picked.length);
    const runs = Object.fromEntries(picked.map(({ arm, task, run, file }, index) => [keys[index]!, { arm, task, run, file }]));
    const sample: Sample = { campaign: options.campaign, seed: options.seed, n: picked.length, records: records.length, exported_at: options.exportedAt ?? new Date().toISOString(), runs };
    await mkdir(join(dir, "packets"), { recursive: true });
    await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`, { flag: "wx" });
    for (const [index, { record }] of picked.entries()) {
        await Bun.write(join(dir, "packets", `${keys[index]!}.md`), judgePrompt(options.tasks.get(record.task)!, record).user);
    }
    for (let expert = 1; expert <= (options.experts ?? 2); expert += 1) await Bun.write(join(dir, `sheet-expert-${expert}.csv`), sheetTemplate(keys));
    return { sample, dir };
}

export async function readSample(root: string): Promise<Sample> {
    const path = join(root, CALIBRATION_DIR, "sample.json");
    if (!(await Bun.file(path).exists())) throw new Error(`no sample at ${path}; export the calibration set first with eval:calibrate --export`);
    return (await Bun.file(path).json()) as Sample;
}

/** The verdict of each sampled run under the judge suffix, keyed by the sample key; a failed or a missing file leaves no entry. */
export async function readJudgeScores(root: string, sample: Sample, judgeSuffix: string): Promise<{ scores: Map<string, Scores>; judge: CalibrationJudge }> {
    const scores = new Map<string, Scores>();
    const identities = new Map<string, CalibrationJudge>();
    for (const [key, run] of Object.entries(sample.runs)) {
        const file = Bun.file(join(root, run.arm, run.file.replace(RECORD_FILE, judgeSuffix)));
        if (!(await file.exists())) continue;
        const raw = (await file.json()) as Record<string, unknown>;
        const parsed = JudgeVerdictSchema.safeParse(raw);
        if (!parsed.success) continue;
        scores.set(key, parsed.data.scores);
        const identity: CalibrationJudge = {
            model: String(raw.model ?? raw.judge ?? ""),
            ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
            ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}),
            ...(typeof raw.prompt_digest === "string" ? { prompt_digest: raw.prompt_digest } : {}),
        };
        identities.set(JSON.stringify(identity), identity);
    }
    if (identities.size > 1) throw new Error(`the verdicts of the sample come from ${identities.size} judges: ${[...identities.values()].map((judge) => judge.model).join(", ")}`);
    const judge = identities.values().next().value ?? { model: "" };
    return { scores, judge };
}

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentList(name: string): string[] {
    const values: string[] = [];
    const index = process.argv.indexOf(name);
    if (index < 0) return values;
    for (let next = index + 1; next < process.argv.length && !process.argv[next]!.startsWith("--"); next += 1) values.push(process.argv[next]!);
    return values;
}

function format(value: number | null): string {
    return value === null ? "n/a" : value.toFixed(3);
}

if (import.meta.main) {
    const campaign = argument("--campaign") ?? "phase0";
    const root = join(argument("--out") ?? join(EVAL_ROOT, "results"), campaign);
    const tag = argument("--judge-tag");
    const judgeSuffix = tag ? `.judge-${tag}.json` : ".judge.json";

    if (process.argv.includes("--export")) {
        const tasks = new Map((await loadTasks()).map((task) => [task.id, task]));
        const n = Number(argument("--n") ?? "40");
        const seed = Number(argument("--seed") ?? "20260904");
        if (!Number.isInteger(n) || n < 1) throw new Error(`--n holds ${argument("--n")}, not a positive integer`);
        if (!Number.isInteger(seed) || seed < 1) throw new Error(`--seed holds ${argument("--seed")}, not a positive integer`);
        const { sample, dir } = await exportSample({ root, campaign, tasks, n, seed });
        const perArm = new Map<string, number>();
        for (const run of Object.values(sample.runs)) perArm.set(run.arm, (perArm.get(run.arm) ?? 0) + 1);
        console.log(
            `exported ${sample.n} of ${sample.records} runs of ${campaign} -> ${dir}\n` +
                `  per arm: ${[...perArm.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([arm, count]) => `${arm} ${count}`).join(", ")}\n` +
                `  seed ${sample.seed}; the key is sample.json, the experts receive packets/ and one sheet-expert-<n>.csv each`,
        );
    } else if (process.argv.includes("--score")) {
        const sheets = argumentList("--sheets");
        if (sheets.length !== 2) throw new Error(`--sheets needs two files, not ${sheets.length}`);
        const sample = await readSample(root);
        const experts = await Promise.all(sheets.map(async (path, index) => [`expert_${index + 1}`, parseSheet(await Bun.file(path).text())] as const));
        const { scores, judge } = await readJudgeScores(root, sample, judgeSuffix);
        const calibration = buildCalibration({ campaign, judge, sampleSize: sample.n, records: sample.records, judgeScores: scores, experts });
        const path = join(root, "calibration.json");
        await Bun.write(path, `${JSON.stringify({ ...calibration, sheets: sheets.map((sheet) => basename(sheet)) }, null, 2)}\n`);
        const lines = [
            `calibration of ${campaign} -> ${path}`,
            `  judge ${judge.model}${judge.tag ? ` tag ${judge.tag}` : ""}, sample ${sample.n}, verdicts ${calibration.judged}`,
            ...Object.entries(calibration.judge_versus_expert).map(([name, comparison]) => `  judge vs ${name}: kappa_total ${format(comparison.kappa_total)} over ${comparison.n} runs`),
            `  expert vs expert: kappa_total ${format(calibration.expert_agreement.kappa_total)} over ${calibration.expert_agreement.n} runs`,
            `  by criterion: ${CRITERION_KEYS.map((key) => `${key} ${format(calibration.kappa_by_criterion[key])}`).join(", ")}`,
            `  kappa_total ${format(calibration.kappa_total)}, threshold ${calibration.threshold}, pass ${calibration.pass}, double scored ${(calibration.double_scored_share * 100).toFixed(0)}% of ${sample.records} records`,
        ];
        console.log(lines.join("\n"));
    } else {
        console.error("pass --export or --score; see the header of eval/src/calibrate.ts");
        process.exit(1);
    }
}
