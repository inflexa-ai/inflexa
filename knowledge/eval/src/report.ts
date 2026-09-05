/**
 * The report of a campaign: every run scored, aggregated by arm (condition
 * and model), with the paired bootstrap of the rubric difference between the
 * two conditions of one model, the grounding, the call rate, the references,
 * the tokens, and the time. Markdown and JSON, side by side.
 *
 *   bun eval/src/report.ts --campaign c1 [--service-url http://127.0.0.1:8790]
 *   bun eval/src/report.ts --campaign c1 --judge-tag sonnet --contrast with--claude-sonnet-5 without--claude-opus-5
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { CRITERIA, type JudgeVerdict } from "./judge.js";
import type { RunRecord } from "./run.js";
import { resolveAgainstSnapshot, scoreRun, type DeterministicScore } from "./score.js";
import { EVAL_ROOT, loadTasks } from "./tasks.js";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

interface ScoredRun {
    readonly arm: string;
    readonly condition: string;
    readonly model: string;
    readonly task: string;
    readonly run: number;
    readonly score: DeterministicScore;
    readonly rubric?: number;
    readonly criteria?: Record<string, number>;
    readonly judge?: string;
}

function mean(values: readonly number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

/** A deterministic linear congruential generator, thus a report is reproducible. */
function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/**
 * The paired bootstrap over tasks of the mean rubric difference (with minus
 * without). The unit is the task: the run means of each arm pair up by task,
 * the bootstrap resamples tasks, and the one-sided 97.5% lower bound answers
 * the non-inferiority question against the margin.
 */
function pairedBootstrap(withByTask: Map<string, number>, withoutByTask: Map<string, number>, iterations = 4000): { diff: number; lower: number; upper: number; n: number } {
    const tasks = [...withByTask.keys()].filter((task) => withoutByTask.has(task));
    const diffs = tasks.map((task) => withByTask.get(task)! - withoutByTask.get(task)!);
    if (diffs.length === 0) return { diff: 0, lower: 0, upper: 0, n: 0 };
    const random = rng(20260904);
    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
        let sum = 0;
        for (let j = 0; j < diffs.length; j += 1) sum += diffs[Math.floor(random() * diffs.length)]!;
        samples.push(sum / diffs.length);
    }
    samples.sort((a, b) => a - b);
    return { diff: mean(diffs), lower: samples[Math.floor(0.025 * samples.length)]!, upper: samples[Math.floor(0.975 * samples.length)]!, n: diffs.length };
}

if (import.meta.main) {
    const campaign = argument("--campaign") ?? "phase0";
    const serviceUrl = argument("--service-url") ?? "http://127.0.0.1:8790";
    const serviceKey = Bun.env[argument("--service-key-env") ?? "INFLEXA_KNOWLEDGE_SERVICE_KEY"] ?? "";
    const margin = Number(argument("--margin") ?? "5");
    const root = join(argument("--out") ?? join(EVAL_ROOT, "results"), campaign);
    const tag = argument("--judge-tag");
    const judgeSuffix = tag ? `.judge-${tag}.json` : ".judge.json";
    // `--contrast <arm A> <arm B>` adds a paired bootstrap between two arms of any
    // model, for example a small model with the tools against a frontier model without.
    const contrastIndex = process.argv.indexOf("--contrast");
    const contrastArms = contrastIndex >= 0 ? [process.argv[contrastIndex + 1], process.argv[contrastIndex + 2]] : undefined;
    const tasks = new Map((await loadTasks()).map((task) => [task.id, task]));
    const serviceUp = await fetch(`${serviceUrl}/health`)
        .then((response) => response.ok)
        .catch(() => false);

    const runs: ScoredRun[] = [];
    for (const arm of await readdir(root, { withFileTypes: true })) {
        if (!arm.isDirectory()) continue;
        const dir = join(root, arm.name);
        for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json") && !/\.judge(-[a-z0-9]+)?\.json$/.test(name))) {
            const record = (await Bun.file(join(dir, file)).json()) as RunRecord;
            const task = tasks.get(record.task);
            if (!task) continue;
            let score = scoreRun(record, task);
            if (serviceUp && (score.claims.length > 0 || score.dois_in_plan.length > 0)) score = await resolveAgainstSnapshot(score, serviceUrl, serviceKey);
            const judgePath = join(dir, file.replace(/\.json$/, judgeSuffix));
            let rubric: number | undefined;
            let criteria: Record<string, number> | undefined;
            let judge: string | undefined;
            if (await Bun.file(judgePath).exists()) {
                const verdict = (await Bun.file(judgePath).json()) as JudgeVerdict & { judge?: string };
                judge = verdict.judge;
                criteria = verdict.scores;
                rubric = Object.values(verdict.scores).reduce((sum, value) => sum + value, 0) * 1.25;
            }
            runs.push({ arm: arm.name, condition: record.condition, model: record.model, task: record.task, run: record.run, score, ...(rubric !== undefined ? { rubric } : {}), ...(criteria ? { criteria } : {}), ...(judge ? { judge } : {}) });
        }
    }

    const arms = [...new Set(runs.map((run) => run.arm))].sort();
    const summary = arms.map((arm) => {
        const rows = runs.filter((run) => run.arm === arm);
        const scores = rows.map((run) => run.score);
        const judged = rows.filter((run) => run.rubric !== undefined);
        const methodSteps = scores.reduce((sum, score) => sum + score.method_steps, 0);
        const grounded = scores.reduce((sum, score) => sum + score.grounded_steps + score.flagged_steps, 0);
        const claims = scores.reduce((sum, score) => sum + score.claims.length, 0);
        const claimsResolving = scores.reduce((sum, score) => sum + (score.claims_resolving ?? 0), 0);
        const dois = scores.reduce((sum, score) => sum + score.dois_in_plan.length, 0);
        const doisKnown = scores.reduce((sum, score) => sum + (score.dois_in_snapshot ?? 0), 0);
        const criteriaMeans = Object.fromEntries(CRITERIA.map(([key]) => [key, mean(judged.map((run) => run.criteria?.[key] ?? 0))]));
        return {
            arm,
            condition: rows[0]?.condition,
            model: rows[0]?.model,
            runs: rows.length,
            tasks: new Set(rows.map((run) => run.task)).size,
            planned_share: mean(scores.map((score) => (score.planned ? 1 : 0))),
            rubric_mean: judged.length ? mean(judged.map((run) => run.rubric!)) : null,
            rubric_sd_within_task: judged.length ? mean([...new Set(judged.map((run) => run.task))].map((task) => sd(judged.filter((run) => run.task === task).map((run) => run.rubric!)))) : null,
            criteria_means: criteriaMeans,
            expectations_share: mean(scores.map((score) => (score.expectations_total === 0 ? 1 : score.expectations_met / score.expectations_total))),
            recommend_call_rate: mean(scores.map((score) => (score.knowledge_recommend_calls > 0 ? 1 : 0))),
            check_call_rate: mean(scores.map((score) => (score.knowledge_check_calls > 0 ? 1 : 0))),
            grounding_share: methodSteps === 0 ? 0 : grounded / methodSteps,
            claims_total: claims,
            claims_resolving: claimsResolving,
            dois_in_plans: dois,
            dois_in_snapshot: doisKnown,
            snapshot_pinned_share: mean(scores.map((score) => (score.snapshot_pinned ? 1 : 0))),
            tool_calls_mean: mean(scores.map((score) => score.tool_calls)),
            input_tokens_mean: Math.round(mean(scores.map((score) => score.input_tokens))),
            output_tokens_mean: Math.round(mean(scores.map((score) => score.output_tokens))),
            cache_read_tokens_mean: Math.round(mean(scores.map((score) => score.cache_read_tokens))),
            elapsed_s_mean: Math.round(mean(scores.map((score) => score.elapsed_s))),
        };
    });

    const contrasts = [...new Set(runs.map((run) => run.model))].map((model) => {
        const byTask = (condition: string) => {
            const map = new Map<string, number>();
            const rows = runs.filter((run) => run.model === model && run.condition === condition && run.rubric !== undefined);
            for (const task of new Set(rows.map((run) => run.task))) map.set(task, mean(rows.filter((run) => run.task === task).map((run) => run.rubric!)));
            return map;
        };
        const bootstrap = pairedBootstrap(byTask("with"), byTask("without"));
        return { model, ...bootstrap, margin, non_inferior: bootstrap.n > 0 && bootstrap.lower > -margin };
    });

    const byArm = (arm: string) => {
        const map = new Map<string, number>();
        const rows = runs.filter((run) => run.arm === arm && run.rubric !== undefined);
        for (const task of new Set(rows.map((run) => run.task))) map.set(task, mean(rows.filter((run) => run.task === task).map((run) => run.rubric!)));
        return map;
    };
    const crossContrast =
        contrastArms && contrastArms[0] && contrastArms[1]
            ? { arms: [contrastArms[0], contrastArms[1]] as const, ...pairedBootstrap(byArm(contrastArms[0]), byArm(contrastArms[1])), margin }
            : undefined;
    const judges = [...new Set(runs.map((run) => run.judge).filter((judge): judge is string => judge !== undefined))];

    const lines: string[] = [`# Phase 0 campaign \`${campaign}\``, ""];
    if (judges.length > 0) lines.push(`Judge: ${judges.join(", ")}${tag ? ` (tag ${tag})` : ""}.`, "");
    lines.push(`Runs: ${runs.length}. Judge verdicts: ${runs.filter((run) => run.rubric !== undefined).length}. Service for claim resolution: ${serviceUp ? "reachable" : "not reachable (claims unresolved)"}.`, "");
    lines.push("| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const row of summary) {
        lines.push(
            `| ${row.arm} | ${row.runs} | ${(row.planned_share * 100).toFixed(0)}% | ${row.rubric_mean === null ? "n/a" : row.rubric_mean.toFixed(1)} | ${row.rubric_sd_within_task === null ? "n/a" : row.rubric_sd_within_task.toFixed(1)} | ${(row.expectations_share * 100).toFixed(0)}% | ${(row.recommend_call_rate * 100).toFixed(0)}% | ${(row.check_call_rate * 100).toFixed(0)}% | ${(row.grounding_share * 100).toFixed(0)}% | ${row.claims_resolving}/${row.claims_total} | ${row.dois_in_plans} (${row.dois_in_snapshot}) | ${(row.snapshot_pinned_share * 100).toFixed(0)}% | ${row.tool_calls_mean.toFixed(1)} | ${row.input_tokens_mean} | ${row.output_tokens_mean} | ${row.cache_read_tokens_mean} | ${row.elapsed_s_mean} |`,
        );
    }
    lines.push("", "## Rubric criteria, mean of 0 to 10", "", `| Arm | ${CRITERIA.map(([key]) => key).join(" | ")} |`, `|---|${CRITERIA.map(() => "---").join("|")}|`);
    for (const row of summary) lines.push(`| ${row.arm} | ${CRITERIA.map(([key]) => (row.criteria_means[key] ?? 0).toFixed(1)).join(" | ")} |`);
    lines.push("", "## Non-inferiority of the tools, paired by task (with minus without)", "");
    for (const contrast of contrasts) {
        lines.push(
            contrast.n === 0
                ? `- ${contrast.model}: no judged pair of arms`
                : `- ${contrast.model}: difference ${contrast.diff.toFixed(1)} points over ${contrast.n} tasks, 95% bootstrap interval [${contrast.lower.toFixed(1)}, ${contrast.upper.toFixed(1)}], margin ${margin}: ${contrast.non_inferior ? "non-inferior" : "not shown"}`,
        );
    }
    if (crossContrast) {
        lines.push("", `## Contrast of two arms, paired by task (${crossContrast.arms[0]} minus ${crossContrast.arms[1]})`, "");
        lines.push(
            crossContrast.n === 0
                ? "- no judged pair of arms"
                : `- difference ${crossContrast.diff.toFixed(1)} points over ${crossContrast.n} tasks, 95% bootstrap interval [${crossContrast.lower.toFixed(1)}, ${crossContrast.upper.toFixed(1)}], margin ${margin}: ${crossContrast.lower > -margin ? "non-inferior" : "not shown"}${crossContrast.lower > 0 ? ", and superior" : ""}`,
        );
    }
    lines.push("", "## Per run", "", "| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const run of [...runs].sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.run - b.run)) {
        const s = run.score;
        lines.push(
            `| ${run.arm} | ${run.task} | ${run.run} | ${s.outcome} | ${run.rubric === undefined ? "n/a" : run.rubric.toFixed(0)} | ${s.expectations_met}/${s.expectations_total} | ${s.grounded_steps}/${s.flagged_steps}/${s.ungrounded_steps} | ${s.claims.length}${s.claims_resolving !== undefined ? ` (${s.claims_resolving} resolve)` : ""} | ${s.knowledge_recommend_calls} | ${s.knowledge_check_calls} | ${s.output_tokens} | ${s.elapsed_s} | ${s.failed_expectations.join("; ")} |`,
        );
    }
    const markdown = `${lines.join("\n")}\n`;
    const reportName = tag ? `report-${tag}` : "report";
    await Bun.write(join(root, `${reportName}.md`), markdown);
    await Bun.write(join(root, `${reportName}.json`), `${JSON.stringify({ campaign, judges, summary, contrasts, ...(crossContrast ? { cross_contrast: crossContrast } : {}), runs }, null, 2)}\n`);
    console.log(markdown);
}
