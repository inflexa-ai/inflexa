/**
 * The report of a run (JSON plus a short table), and the comparison of two
 * reports: a baseline and a candidate of one prompt.
 */

import { z } from "zod";

import { parseJsonAs } from "@inflexa-ai/harness/lib/parse-json.js";
import type { CaseSet, EvalCase } from "./case.js";
import type { ProviderIdentity } from "./provider.js";
import type { TrialResult } from "./run.js";
import { pairedMean, passHatK, rateDifference, wilson, type Interval } from "./stats.js";

const IntervalSchema = z.object({ low: z.number(), high: z.number() });

const CaseReportSchema = z.object({
    id: z.string(),
    set: z.enum(["dev", "held-out"]),
    source: z.string(),
    /** The graded trials. A trial that failed with an error is not graded, and it does not count. */
    trials: z.number(),
    passes: z.number(),
    errors: z.number(),
    rate: z.number(),
    interval: IntervalSchema,
    passHatK: z.number().optional(),
    results: z.array(z.json()),
});

export const ReportSchema = z.object({
    version: z.literal(1),
    startedAt: z.string(),
    commit: z.string().optional(),
    /** The digest of the system prompt and the tool definitions. */
    promptDigest: z.string(),
    provider: z.object({ kind: z.string(), baseURL: z.string().optional(), model: z.string(), reasoning: z.string().optional() }),
    trialsPerCase: z.number(),
    k: z.number(),
    cases: z.array(CaseReportSchema),
});

export type Report = z.infer<typeof ReportSchema>;
export type CaseReport = z.infer<typeof CaseReportSchema>;

export type ReportMeta = {
    readonly startedAt: string;
    readonly commit?: string;
    readonly promptDigest: string;
    readonly provider: ProviderIdentity;
    readonly trialsPerCase: number;
    readonly k: number;
};

function caseReport(evalCase: EvalCase, results: readonly TrialResult[], k: number): CaseReport {
    const graded = results.filter((result) => result.kind === "graded");
    const passes = graded.filter((result) => result.pass).length;
    return {
        id: evalCase.id,
        set: evalCase.set,
        source: evalCase.source,
        trials: graded.length,
        passes,
        errors: results.length - graded.length,
        rate: graded.length === 0 ? 0 : passes / graded.length,
        interval: wilson(passes, graded.length),
        passHatK: passHatK(passes, graded.length, k),
        results: results.map((result) => parseJsonAs(JSON.stringify(result), z.json())),
    };
}

export function buildReport(meta: ReportMeta, cases: readonly EvalCase[], results: ReadonlyMap<string, readonly TrialResult[]>): Report {
    return {
        version: 1,
        ...meta,
        provider: { ...meta.provider },
        cases: cases.map((evalCase) => caseReport(evalCase, results.get(evalCase.id) ?? [], meta.k)),
    };
}

function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function interval(value: Interval): string {
    return `${percent(value.low)}-${percent(value.high)}`;
}

function signed(value: number): string {
    const rounded = Math.round(value * 100);
    return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
    const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
    const line = (row: readonly string[]): string =>
        row
            .map((cell, index) => cell.padEnd(widths[index] ?? 0))
            .join("  ")
            .trimEnd();
    return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function reportTable(report: Report): string {
    const rows = report.cases.map((c) => [
        c.id,
        c.set,
        `${c.passes}/${c.trials}`,
        percent(c.rate),
        interval(c.interval),
        c.passHatK === undefined ? "-" : percent(c.passHatK),
        c.errors === 0 ? "" : String(c.errors),
    ]);
    const head = `${report.provider.model} · prompt ${report.promptDigest}${report.commit === undefined ? "" : ` · ${report.commit}`}`;
    return `${head}\n${table(["case", "set", "pass", "rate", "95% CI", `pass^${report.k}`, "errors"], rows)}`;
}

export type CaseComparison = {
    readonly id: string;
    readonly set: CaseSet;
    readonly baseline: number;
    readonly candidate: number;
    readonly difference: Interval & { readonly estimate: number };
    /** The interval of the difference is below zero. */
    readonly regressed: boolean;
    readonly improved: boolean;
};

export type Comparison = {
    readonly cases: readonly CaseComparison[];
    /** The mean of the per-case differences of each set, paired by case. */
    readonly sets: Readonly<Record<string, Interval & { readonly estimate: number }>>;
    /** The cases of one report that the other report does not hold. */
    readonly unpaired: readonly string[];
};

export function compareReports(baseline: Report, candidate: Report): Comparison {
    const byId = new Map(baseline.cases.map((c) => [c.id, c]));
    const candidateIds = new Set(candidate.cases.map((c) => c.id));
    const cases: CaseComparison[] = [];
    for (const c of candidate.cases) {
        const base = byId.get(c.id);
        if (base === undefined || base.trials === 0 || c.trials === 0) continue;
        const difference = rateDifference({ passes: base.passes, trials: base.trials }, { passes: c.passes, trials: c.trials });
        cases.push({ id: c.id, set: c.set, baseline: base.rate, candidate: c.rate, difference, regressed: difference.high < 0, improved: difference.low > 0 });
    }
    const sets: Record<string, Interval & { readonly estimate: number }> = {};
    for (const set of new Set(cases.map((c) => c.set))) {
        sets[set] = pairedMean(cases.filter((c) => c.set === set).map((c) => c.difference.estimate));
    }
    const paired = new Set(cases.map((c) => c.id));
    const unpaired = [...new Set([...byId.keys(), ...candidateIds])].filter((id) => !paired.has(id));
    return { cases, sets, unpaired };
}

export function comparisonTable(comparison: Comparison, baseline: Report, candidate: Report): string {
    const rows = comparison.cases.map((c) => [
        c.id,
        c.set,
        percent(c.baseline),
        percent(c.candidate),
        signed(c.difference.estimate),
        `${signed(c.difference.low)}..${signed(c.difference.high)}`,
        c.regressed ? "REGRESSED" : c.improved ? "improved" : "",
    ]);
    const head = `baseline ${baseline.promptDigest} (${baseline.provider.model}) -> candidate ${candidate.promptDigest} (${candidate.provider.model})`;
    const sets = Object.entries(comparison.sets).map(
        ([set, d]) => `${set}: mean difference ${signed(d.estimate)} points, 95% CI ${signed(d.low)}..${signed(d.high)}`,
    );
    const unpaired = comparison.unpaired.length === 0 ? [] : [`unpaired cases: ${comparison.unpaired.join(", ")}`];
    return [head, table(["case", "set", "base", "cand", "diff", "95% CI", ""], rows), ...sets, ...unpaired].join("\n");
}
