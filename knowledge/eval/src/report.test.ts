import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest, parseArm, promptDigest, type Manifest } from "./freeze.js";
import { CRITERIA } from "./judge.js";
import {
    armDirectory,
    buildReport,
    calibrationPasses,
    collectRuns,
    contrastsOf,
    decide,
    familyOf,
    groupRuns,
    holm,
    pairedBootstrap,
    recordDifferences,
    renderMarkdown,
    sd,
    summarizeArm,
    type ScoredRun,
} from "./report.js";
import type { DeterministicScore } from "./score.js";
import { TaskSchema } from "./tasks.js";

const CORPUS = { date: "2026-09-06", digest: "sha256:abc", schema_version: "0.1.0", tool_definition_hash: "sha256:def" };
const RUNTIME = { harness_commit: "1111", knowledge_commit: "2222", bun: "1.3.10" };
const JUDGE = { provider: "cliproxy" as const, model: "claude-opus-5", tag: "opus", prompt_digest: promptDigest() };

function sampleManifest(): Manifest {
    return buildManifest({
        campaign: "probe",
        taskIds: ["a", "b", "c", "d"],
        tasksPath: "eval/tasks/tasks.yaml",
        tasksDigest: "sha256:tasks",
        tasksDev: ["a", "b"],
        tasksHeld: ["c", "d"],
        seedsDev: [1],
        seedsHeld: [7],
        corpus: CORPUS,
        runtime: RUNTIME,
        arms: [
            parseArm("economical_with=with:economical:openai-compatible:z-ai/glm-5.3-flash"),
            parseArm("economical_without=without:economical:openai-compatible:z-ai/glm-5.3-flash"),
            parseArm("frontier_with=with:frontier:cliproxy:claude-opus-5"),
            parseArm("frontier_without=without:frontier:cliproxy:claude-opus-5"),
        ],
        judge: JUDGE,
        margin: 5,
        runsPerTask: 3,
        frozenAt: "2026-09-07T00:00:00.000Z",
    });
}

const SCORE: DeterministicScore = {
    outcome: "plan_submitted",
    planned: true,
    steps: 2,
    method_steps: 2,
    expectations_met: 1,
    expectations_total: 1,
    failed_expectations: [],
    grounded_steps: 1,
    flagged_steps: 0,
    grounded_applicable_steps: 1,
    flagged_applicable_steps: 0,
    inapplicable_steps: 0,
    unresolved_steps: 0,
    fabricated_steps: 0,
    ungrounded_steps: 1,
    grounding_share: 0.5,
    snapshot_pinned_steps: 1,
    snapshot_pinned: false,
    evidence_responses: 1,
    claims: ["R-0001@abcd"],
    claim_states: { "R-0001@abcd": "applicable" },
    claims_applicable: 1,
    claims_inapplicable: 0,
    claims_unresolved: 0,
    claims_fabricated: 0,
    resolution_snapshot_mismatch: false,
    dois_in_plan: [],
    step_evidence: [],
    knowledge_recommend_calls: 1,
    knowledge_check_calls: 1,
    tool_calls: 3,
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 0,
    elapsed_s: 1.5,
};

const WITH = "with--m";
const WITHOUT = "without--m";

function scored(arm: string, task: string, options: { readonly cluster?: string; readonly run?: number; readonly rubric?: number; readonly seed?: number; readonly split?: ScoredRun["split"] } = {}): ScoredRun {
    const criteria = Object.fromEntries(CRITERIA.map(([key]) => [key, (options.rubric ?? 0) / 10]));
    return {
        arm,
        condition: arm.startsWith("with--") ? "with" : "without",
        model: arm.replace(/^(with|without)--/, ""),
        task,
        cluster: options.cluster ?? task,
        run: options.run ?? 1,
        seed: options.seed ?? 1,
        split: options.split ?? "development",
        exploratory: false,
        usage_missing: false,
        score: SCORE,
        ...(options.rubric !== undefined ? { rubric: options.rubric, criteria, judge: "judge" } : {}),
    };
}

/** Two arms over the tasks, each task judged in both arms at the given rubrics (with, without). */
function pairs(rubrics: Record<string, readonly [number, number]>, cluster: (task: string) => string = (task) => task): ScoredRun[] {
    return Object.entries(rubrics).flatMap(([task, [a, b]]) => [scored(WITH, task, { rubric: a, cluster: cluster(task) }), scored(WITHOUT, task, { rubric: b, cluster: cluster(task) })]);
}

const FAMILY = [{ family: "primary" as const, label: "with vs without", arms: [WITH, WITHOUT] as const, primary: true }];
const OPTIONS = { margin: 5, alpha: 0.025, calibrated: true, iterations: 400 };

describe("the spread", () => {
    it("is undefined below two values, never zero", () => {
        expect(sd([])).toBeUndefined();
        expect(sd([90])).toBeUndefined();
        expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    });

    it("reports the variability of an arm unknown when any task has fewer than two judged runs", () => {
        const single = summarizeArm(WITH, [scored(WITH, "a", { rubric: 90 }), scored(WITH, "b", { rubric: 80 })]);
        expect(single.variability).toBe("unknown");
        expect(single.rubric_sd_within_task).toBeNull();
        expect(single.judged_runs).toBe(2);
        expect(single.unjudged_runs).toBe(0);

        const doubled = summarizeArm(WITH, [scored(WITH, "a", { run: 1, rubric: 90 }), scored(WITH, "a", { run: 2, rubric: 80 }), scored(WITH, "b", { run: 1, rubric: 70 }), scored(WITH, "b", { run: 2, rubric: 74 })]);
        expect(doubled.variability).toBe("estimated");
        expect(doubled.rubric_sd_within_task).toBeCloseTo((Math.sqrt(50) + Math.sqrt(8)) / 2, 6);

        const halfJudged = summarizeArm(WITH, [scored(WITH, "a", { run: 1, rubric: 90 }), scored(WITH, "a", { run: 2, rubric: 80 }), scored(WITH, "b", { run: 1, rubric: 70 }), scored(WITH, "b", { run: 2 })]);
        expect(halfJudged.variability).toBe("unknown");
        expect(halfJudged.rubric_sd_within_task).toBeNull();
        expect(halfJudged.unjudged_runs).toBe(1);
        expect(halfJudged.rubric_mean).toBe(80);
    });

    it("carries the grounding, the usage, and the executed outputs into the arm summary", () => {
        const rows = [scored(WITH, "a", { rubric: 90 }), { ...scored(WITH, "b", { rubric: 80 }), usage_missing: true, outputs: { valid_completion: true, missing_outputs: [], de_recall: 0.8, de_fdr: 0.1, failed_steps: 1, total_ms: 1000, tokens_per_completed_step: 500, report_present: true } }];
        const summary = summarizeArm(WITH, rows);
        expect(summary.usage_missing_runs).toBe(1);
        expect(summary.grounding_share).toBe(0.5);
        expect(summary.snapshot_pinned_steps_share).toBe(0.5);
        expect(summary.claims_applicable).toBe(2);
        expect(summary.claims_unresolved).toBe(0);
        expect(summary.executed_runs).toBe(1);
        expect(summary.valid_completion_rate).toBe(1);
        expect(summary.de_recall_mean).toBe(0.8);
        expect(summary.de_fdr_mean).toBe(0.1);
        expect(summary.failed_steps).toBe(1);
        expect(summary.tokens_per_completed_step).toBe(500);
        const none = summarizeArm(WITH, [scored(WITH, "a")]);
        expect(none.valid_completion_rate).toBeNull();
        expect(none.de_recall_mean).toBeNull();
        expect(none.failed_steps).toBeNull();
        expect(none.tokens_per_completed_step).toBeNull();
        expect(none.rubric_mean).toBeNull();
    });
});

describe("the paired bootstrap", () => {
    it("has no interval without two pairs", () => {
        expect(pairedBootstrap(new Map(), new Map(), { margin: 5 })).toEqual({ n_pairs: 0, diff: null, lower: null, upper: null, p_one_sided: null });
        expect(pairedBootstrap(new Map([["c1", 90]]), new Map([["c1", 80]]), { margin: 5 })).toEqual({ n_pairs: 1, diff: 10, lower: null, upper: null, p_one_sided: null });
    });

    it("pairs by cluster, is reproducible, and answers the margin with a one-sided p-value", () => {
        const a = new Map([["c1", 90], ["c2", 88], ["c3", 92], ["c9", 50]]);
        const b = new Map([["c1", 80], ["c2", 78], ["c3", 82], ["c8", 10]]);
        const result = pairedBootstrap(a, b, { margin: 5, iterations: 400 });
        expect(result.n_pairs).toBe(3);
        expect(result.diff).toBe(10);
        expect(result.lower).toBe(10);
        expect(result.upper).toBe(10);
        expect(result.p_one_sided).toBe(0);
        expect(pairedBootstrap(a, b, { margin: 5, iterations: 400 })).toEqual(result);
        const worse = pairedBootstrap(b, a, { margin: 5, iterations: 400 });
        expect(worse.diff).toBe(-10);
        expect(worse.p_one_sided).toBe(1);
        const mixed = pairedBootstrap(new Map([["c1", 90], ["c2", 60], ["c3", 95]]), new Map([["c1", 80], ["c2", 90], ["c3", 80]]), { margin: 5, iterations: 400 });
        expect(mixed.lower!).toBeLessThan(mixed.upper!);
        expect(mixed.p_one_sided!).toBeGreaterThan(0);
        expect(mixed.p_one_sided!).toBeLessThan(1);
    });
});

describe("the Holm step-down", () => {
    it("rejects the expected set of a known p-vector at alpha 0.025", () => {
        const { adjusted, rejected } = holm([0.001, 0.02, 0.004, 0.03], 0.025);
        expect(rejected).toEqual([true, false, true, false]);
        expect(adjusted[0]).toBeCloseTo(0.004, 9);
        expect(adjusted[2]).toBeCloseTo(0.012, 9);
        expect(adjusted[1]).toBeCloseTo(0.04, 9);
        expect(adjusted[3]).toBeCloseTo(0.04, 9);
    });

    it("keeps a null p-value in the family size, never rejects it, and caps the adjusted value at 1", () => {
        const { adjusted, rejected } = holm([0.005, null, 0.9], 0.025);
        expect(rejected).toEqual([true, false, false]);
        expect(adjusted).toEqual([0.015, null, 1]);
        expect(holm([0.01, 0.01], 0.025).rejected).toEqual([true, true]);
        expect(holm([0.02, 0.02], 0.025).rejected).toEqual([false, false]);
        expect(holm([], 0.025)).toEqual({ adjusted: [], rejected: [] });
    });
});

describe("the decision", () => {
    it("blocks on a missing judgment first, then the calibration, then the test", () => {
        expect(decide({ rejected: true, n_missing: 1, calibrated: true })).toBe("blocked_missing_judgments");
        expect(decide({ rejected: true, n_missing: 0, calibrated: false })).toBe("uncalibrated");
        expect(decide({ rejected: true, n_missing: 0, calibrated: true })).toBe("non_inferior");
        expect(decide({ rejected: false, n_missing: 0, calibrated: true })).toBe("not_shown");
    });

    it("reads the calibration gate at the kappa threshold", () => {
        expect(calibrationPasses(undefined)).toBe(false);
        expect(calibrationPasses({ path: "c", pass: true, kappa_total: 0.7 })).toBe(true);
        expect(calibrationPasses({ path: "c", pass: true, kappa_total: 0.69 })).toBe(false);
        expect(calibrationPasses({ path: "c", pass: false, kappa_total: 0.9 })).toBe(false);
        expect(calibrationPasses({ path: "c", pass: true, kappa_total: null })).toBe(false);
    });
});

describe("the contrasts", () => {
    it("counts a task with a verdict in one arm only as missing, and blocks the decision", () => {
        const runs = [...pairs({ a: [90, 80], b: [88, 78], c: [92, 82] }), scored(WITH, "d", { rubric: 95 }), scored(WITHOUT, "d")];
        const [contrast] = contrastsOf(runs, FAMILY, OPTIONS);
        expect(contrast!.n_pairs).toBe(3);
        expect(contrast!.n_missing).toBe(1);
        expect(contrast!.rejected).toBe(true);
        expect(contrast!.decision).toBe("blocked_missing_judgments");
        const complete = contrastsOf(pairs({ a: [90, 80], b: [88, 78], c: [92, 82] }), FAMILY, OPTIONS);
        expect(complete[0]!.n_missing).toBe(0);
        expect(complete[0]!.decision).toBe("non_inferior");
        expect(complete[0]!.holm_adjusted_p).toBe(0);
        expect(contrastsOf(pairs({ a: [90, 80], b: [88, 78], c: [92, 82] }), FAMILY, { ...OPTIONS, calibrated: false })[0]!.decision).toBe("uncalibrated");
        const worse = contrastsOf(pairs({ a: [60, 80], b: [58, 78], c: [62, 82] }), FAMILY, OPTIONS)[0]!;
        expect(worse.rejected).toBe(false);
        expect(worse.decision).toBe("not_shown");
        expect(worse.p_one_sided).toBe(1);
    });

    it("clusters the tasks by pattern, and keeps an exploratory extra outside the Holm family", () => {
        const runs = pairs({ a: [90, 80], b: [70, 60], c: [92, 82], d: [88, 78] }, (task) => (task === "a" || task === "b" ? "p1" : "p2"));
        const extra = { family: "exploratory" as const, label: "extra", arms: [WITH, WITHOUT] as const, primary: false };
        const [primary, exploratory] = contrastsOf(runs, [...FAMILY, extra], OPTIONS);
        expect(primary!.n_pairs).toBe(2);
        expect(primary!.diff).toBe(10);
        expect(exploratory!.family).toBe("exploratory");
        expect(exploratory!.n_pairs).toBe(2);
        expect(exploratory!.holm_adjusted_p).toBeNull();
        expect(exploratory!.rejected).toBe(false);
        expect(exploratory!.decision).toBe("not_shown");
    });

    it("gives no pair and no rejection when an arm has no verdict", () => {
        const [contrast] = contrastsOf([scored(WITH, "a", { rubric: 90 }), scored(WITHOUT, "a")], FAMILY, OPTIONS);
        expect(contrast!.n_pairs).toBe(0);
        expect(contrast!.n_missing).toBe(1);
        expect(contrast!.p_one_sided).toBeNull();
        expect(contrast!.holm_adjusted_p).toBeNull();
        expect(contrast!.rejected).toBe(false);
    });
});

describe("the family", () => {
    it("takes the manifest contrasts with the primary first, resolved to the arm directories", () => {
        const family = familyOf(sampleManifest(), []);
        expect(family.map((entry) => entry.primary)).toEqual([true, false, false, false]);
        expect(family[0]).toEqual({ family: "primary", label: "economical_with vs frontier_without", arms: ["with--z-ai_glm-5.3-flash", "without--claude-opus-5"], primary: true });
        expect(family[3]!.arms).toEqual(["with--z-ai_glm-5.3-flash", "with--claude-opus-5"]);
        expect(armDirectory("with", "z-ai/glm-5.3-flash")).toBe("with--z-ai_glm-5.3-flash");
    });

    it("derives the with-versus-without pair of each model without a manifest", () => {
        const runs = [scored("with--b", "a"), scored("without--b", "a"), scored("with--a", "a"), scored("without--a", "a"), scored("with--lonely", "a")];
        const family = familyOf(undefined, runs);
        expect(family).toEqual([
            { family: "derived", label: "a with vs without", arms: ["with--a", "without--a"], primary: true },
            { family: "derived", label: "b with vs without", arms: ["with--b", "without--b"], primary: false },
        ]);
    });
});

describe("the splits", () => {
    it("never pool the runs of different splits or seeds", () => {
        const runs = [
            ...pairs({ a: [90, 80], b: [88, 78] }),
            ...pairs({ c: [95, 60], d: [93, 58] }).map((run) => ({ ...run, split: "held_out" as const, seed: 7 })),
            ...pairs({ a: [50, 80] }).map((run) => ({ ...run, seed: 2 })),
        ];
        const groups = groupRuns(runs);
        expect(groups.map((group) => [group.split, group.seed, group.runs.length])).toEqual([
            ["development", 1, 4],
            ["development", 2, 2],
            ["held_out", 7, 4],
        ]);
        const report = buildReport({ campaign: "probe", collected: { runs, reasons: [], verdicts: { judged: 10, failed: 0, absent: 0 } }, margin: 5, alpha: 0.025, serviceReachable: false, iterations: 400 });
        expect(report.splits.map((group) => `${group.split}/${group.seed}`)).toEqual(["development/1", "development/2", "held_out/7"]);
        expect(report.summary.map((row) => [row.arm, row.split, row.seed, row.runs])).toEqual([
            [WITH, "development", 1, 2],
            [WITHOUT, "development", 1, 2],
            [WITH, "development", 2, 1],
            [WITHOUT, "development", 2, 1],
            [WITH, "held_out", 7, 2],
            [WITHOUT, "held_out", 7, 2],
        ]);
        expect(report.contrasts.map((contrast) => [contrast.split, contrast.seed, contrast.n_pairs, contrast.diff])).toEqual([
            ["development", 1, 2, 10],
            ["development", 2, 1, -30],
            ["held_out", 7, 2, 35],
        ]);
        expect(report.family[0]!.family).toBe("derived");
        expect(report.exploratory).toBe(false);
        const markdown = renderMarkdown(report);
        expect(markdown).toContain("## Split development, seed 1: 4 runs, 2 tasks");
        expect(markdown).toContain("## Split held_out, seed 7: 4 runs, 2 tasks");
        expect(markdown).toContain("| unknown |");
        expect(markdown).toContain("| uncalibrated |");
    });
});

describe("the manifest gate of the report", () => {
    const manifest = sampleManifest();
    const inside = { condition: "with", model: "claude-opus-5", task: "a", seed: 1, snapshot: { digest: CORPUS.digest }, manifest: { digest: "sha256:m" } };

    it("names each field on which a record or its verdict is outside the frozen campaign", () => {
        expect(recordDifferences(manifest, "sha256:m", inside, { model: "claude-opus-5", prompt_digest: promptDigest() })).toEqual([]);
        expect(recordDifferences(undefined, undefined, inside)).toEqual(["the campaign has no manifest"]);
        expect(recordDifferences(manifest, "sha256:m", { ...inside, seed: 3 })).toEqual(["the seed 3 is not a frozen seed"]);
        expect(recordDifferences(manifest, "sha256:m", { ...inside, model: "other" })).toEqual(["the arm with other is not a frozen arm"]);
        expect(recordDifferences(manifest, "sha256:m", { ...inside, snapshot: { digest: "sha256:zzz" } })).toEqual(["the snapshot sha256:zzz is not the frozen sha256:abc"]);
        expect(recordDifferences(manifest, "sha256:m", { ...inside, task: "zzz" })).toEqual(["the task zzz is not in the frozen task set"]);
        expect(recordDifferences(manifest, "sha256:m", { ...inside, exploratory: true, manifest: { digest: "sha256:old" } })).toEqual(["a record ran under --exploratory", "a record ran under another manifest (sha256:old)"]);
        expect(recordDifferences(manifest, "sha256:m", inside, { model: "claude-sonnet-5", prompt_digest: "sha256:0" })).toEqual([
            "the judge claude-sonnet-5 is not the frozen claude-opus-5",
            `the judge prompt sha256:0 is not the frozen ${promptDigest()}`,
        ]);
    });
});

describe("the campaign directory", () => {
    const task = TaskSchema.parse({ id: "t1", pattern: "two_group_n6", question: "q", tissue: "liver", condition: "c", experimental_design: "d", count_source: "salmon", concerns: [], reference: "r", must_match: [], must_not_match: [] });
    const scores = Object.fromEntries(CRITERIA.map(([key]) => [key, 8]));

    function record(run: number, extra: Record<string, unknown> = {}): string {
        return JSON.stringify({ campaign: "probe", condition: "without", model: "claude-opus-5", task: "t1", run, startedAt: "2026-09-07T00:00:00.000Z", elapsedMs: 1000, outcome: "plan_submitted", plan: { title: "p", steps: [] }, usage: { inputTokens: 10, outputTokens: 2 }, toolCalls: [], ...extra });
    }

    it("counts a failed judge file and a missing one as absent judgments, and reads an old record on seed 1", async () => {
        const root = await mkdtemp(join(tmpdir(), "report-"));
        try {
            const arm = join(root, "without--claude-opus-5");
            await mkdir(arm, { recursive: true });
            await mkdir(join(root, "calibration"));
            await Bun.write(join(arm, "t1.run-1.json"), record(1));
            await Bun.write(join(arm, "t1.run-1.judge-opus.json"), JSON.stringify({ judge: "claude-opus-5", provider: "cliproxy", model: "claude-opus-5", tag: "opus", prompt_digest: promptDigest(), scores, rationale: "fine" }));
            await Bun.write(join(arm, "t1.run-2.json"), record(2));
            await Bun.write(join(arm, "t1.run-2.judge-opus.json"), JSON.stringify({ failed: "the judge call failed: 503", judge: "claude-opus-5", prompt_digest: promptDigest() }));
            await Bun.write(join(arm, "t1.seed-1.run-3.json"), record(3, { seed: 1, split: "development", usage: {} }));
            await Bun.write(join(arm, "t2.seed-1.run-1.json"), record(1, { task: "t2", seed: 1, split: "development" }));

            const collected = await collectRuns({ root, tasks: new Map([[task.id, task]]), judgeSuffix: ".judge-opus.json" });
            expect(collected.verdicts).toEqual({ judged: 1, failed: 1, absent: 1 });
            expect(collected.reasons).toEqual(["the campaign has no manifest"]);
            expect(collected.runs.map((run) => [run.run, run.seed, run.split, run.rubric, run.usage_missing, run.exploratory])).toEqual([
                [1, 1, "none", 80, false, true],
                [2, 1, "none", undefined, false, true],
                [3, 1, "development", undefined, true, true],
            ]);
            expect(collected.runs[0]!.judge).toBe("claude-opus-5");
            expect(collected.runs[0]!.cluster).toBe("two_group_n6");

            const report = buildReport({ campaign: "probe", collected, margin: 5, alpha: 0.025, serviceReachable: false, iterations: 400 });
            expect(report.exploratory).toBe(true);
            expect(report.family).toEqual([]);
            expect(report.contrasts).toEqual([]);
            expect(report.summary.map((row) => [row.arm, row.split, row.runs, row.judged_runs, row.unjudged_runs, row.usage_missing_runs, row.variability])).toEqual([
                ["without--claude-opus-5", "development", 1, 0, 1, 1, "unknown"],
                ["without--claude-opus-5", "none", 2, 1, 1, 0, "unknown"],
            ]);
            const markdown = renderMarkdown(report);
            expect(markdown).toContain("**Exploratory report.** the campaign has no manifest.");
            expect(markdown).toContain("Judge verdicts: 1 (1 failed, 1 absent)");
            expect(markdown).toContain("| without--claude-opus-5 | 2 | 1/2 |");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
