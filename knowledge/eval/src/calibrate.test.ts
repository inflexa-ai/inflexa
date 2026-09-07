import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { binOf, buildCalibration, compareRaters, CRITERION_KEYS, exportSample, keysFor, listRecords, parseSheet, readJudgeScores, readSample, rng, sampleStratified, type Scores, sheetTemplate, totalOf, weightedKappa } from "./calibrate.js";
import { judgePrompt } from "./judge.js";
import { TaskSchema } from "./tasks.js";

const DIGEST = "sha256:1322cd0c9a10fdcdaa179664686e6635ddbc6790ab33a90c8534ca73db0e40ed";
const CLAIM = "R-0033@40bf";
const REASON = "Raw counts before a model: blind VST and PCA are the prescribed sample-structure QC.";

const task = TaskSchema.parse({
    id: "t1",
    pattern: "two_group_n6",
    question: "Which genes differ between treated and control?",
    tissue: "liver",
    condition: "drug",
    experimental_design: "Six treated and six control mice.",
    count_source: "salmon",
    concerns: ["one shallow library"],
    reference: "DESeq2 Wald test on the raw counts with BH at 0.05.",
    must_match: [],
    must_not_match: [],
});

function record(arm: string, model: string, run: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const condition = arm.startsWith("with--") ? "with" : "without";
    return {
        campaign: "probe",
        condition,
        model,
        task: "t1",
        run,
        seed: 1,
        outcome: "plan_submitted",
        usage: {},
        toolCalls: [],
        knowledgeCalls: [],
        snapshot: { date: "2026-09-05", digest: DIGEST },
        plan: {
            title: `A plan of run ${run}`,
            analytical_narrative: "QC, then the count model, then the report.",
            steps: [
                {
                    id: "T1S1",
                    name: "Sample QC",
                    agent: "bulk-transcriptomics-agent",
                    question: "Do the samples separate by condition?",
                    description: "Load the counts and plot the PCA.",
                    constraints: ["Use a blind VST"],
                    packages: ["DESeq2"],
                    grounding: { status: "grounded", claims: [CLAIM], snapshot: DIGEST, reason: REASON, template: "tpl-qc-eda@1.0.0" },
                },
            ],
        },
        ...extra,
    };
}

function scoresOf(values: readonly number[]): Scores {
    return Object.fromEntries(CRITERION_KEYS.map((key, index) => [key, values[index % values.length]!])) as Scores;
}

function randomScores(random: () => number): Scores {
    return Object.fromEntries(CRITERION_KEYS.map((key) => [key, Math.floor(random() * 11)])) as Scores;
}

function sheetOf(scores: ReadonlyMap<string, Scores>): string {
    const rows = [...scores.entries()].flatMap(([key, run]) => CRITERION_KEYS.map((criterion) => `${key},${criterion},${run[criterion] ?? ""}`));
    return `key,criterion,score\n${rows.join("\n")}\n`;
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "calibrate-"));
    try {
        return await work(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** A campaign directory of two arms with `perArm` records each; every record of the first arm carries a verdict. */
async function writeCampaign(root: string, perArm: number, options: { failed?: readonly number[] } = {}): Promise<Map<string, Scores>> {
    const verdicts = new Map<string, Scores>();
    const arms = [
        ["with--claude-opus-5", "claude-opus-5"],
        ["without--claude-sonnet-5", "claude-sonnet-5"],
    ] as const;
    for (const [arm, model] of arms) {
        await mkdir(join(root, arm), { recursive: true });
        for (let run = 1; run <= perArm; run += 1) {
            const file = `t1.seed-1.run-${run}.json`;
            await Bun.write(join(root, arm, file), JSON.stringify(record(arm, model, run)));
            const scores = scoresOf([10, 9, 8, run % 3 + 5, 7, 10 - (run % 4), 9, 6 + (run % 5)]);
            verdicts.set(`${arm}/${file}`, scores);
            const failed = options.failed?.includes(run) && arm === arms[0][0];
            const verdict = failed
                ? { failed: "the judge call failed: 503", judge: "claude-opus-5", provider: "cliproxy", model: "claude-opus-5", tag: "opus", prompt_digest: "sha256:p" }
                : { judge: "claude-opus-5", provider: "cliproxy", model: "claude-opus-5", tag: "opus", prompt_digest: "sha256:p", scores, rationale: "fine" };
            await Bun.write(join(root, arm, file.replace(/\.json$/, ".judge-opus.json")), JSON.stringify(verdict));
        }
    }
    return verdicts;
}

describe("the quadratic-weighted kappa", () => {
    it("is 1 on identical sheets", () => {
        const a = new Map<string, Scores>();
        for (let i = 0; i < 12; i += 1) a.set(`cal-${i}`, scoresOf([i % 11, (i * 3) % 11, (i * 5) % 11, (i * 7) % 11, (i + 2) % 11, (i * 2) % 11, (i * 4) % 11, (i * 6) % 11]));
        const same = compareRaters(a, new Map(a));
        expect(same.n).toBe(12);
        expect(same.kappa_total).toBe(1);
        for (const key of CRITERION_KEYS) expect(same.kappa_by_criterion[key]).toBe(1);
    });

    it("is about 0 on independent sheets", () => {
        const random = rng(7);
        const a = new Map<string, Scores>();
        const b = new Map<string, Scores>();
        for (let i = 0; i < 3000; i += 1) {
            a.set(`k${i}`, randomScores(random));
            b.set(`k${i}`, randomScores(random));
        }
        const independent = compareRaters(a, b);
        expect(independent.n).toBe(3000);
        expect(Math.abs(independent.kappa_total!)).toBeLessThan(0.08);
        for (const key of CRITERION_KEYS) expect(Math.abs(independent.kappa_by_criterion[key]!)).toBeLessThan(0.08);
    });

    it("matches a hand-computed 3x3 table", () => {
        // Rows are the first rater, columns the second: [[4, 1, 0], [1, 3, 1], [0, 1, 4]], N = 15.
        // Observed weighted disagreement 4 / 15; expected (5 * 5 / 15) * (1 + 1 + 1 + 1 + 4 + 4) / 15 = 4 / 3; kappa = 1 - 0.2.
        const table = [
            [4, 1, 0],
            [1, 3, 1],
            [0, 1, 4],
        ];
        const pairs: [number, number][] = [];
        table.forEach((row, i) => row.forEach((count, j) => pairs.push(...Array.from({ length: count }, () => [i, j] as [number, number]))));
        expect(weightedKappa(pairs)).toBeCloseTo(0.8, 12);
        expect(weightedKappa(pairs.map(([i, j]) => [i * 5, j * 5]))).toBeCloseTo(0.8, 12);
    });

    it("is undefined without a pair and without a spread", () => {
        expect(weightedKappa([])).toBeUndefined();
        expect(weightedKappa([[3, 3], [3, 3]])).toBeUndefined();
        expect(weightedKappa([[3, 3], [3, 4]])).toBe(0);
    });

    it("bins the total in 5-point bins and scales the eight criteria to 100", () => {
        expect(totalOf(scoresOf([10]))).toBe(100);
        expect(totalOf(scoresOf([0]))).toBe(0);
        expect(totalOf({ method_fits_design: 5 })).toBeUndefined();
        expect(binOf(100)).toBe(20);
        expect(binOf(97.5)).toBe(19);
        expect(binOf(0)).toBe(0);
        expect(binOf(5)).toBe(1);
    });

    it("pairs a criterion where both raters scored it and a total where both completed the run", () => {
        const a = new Map<string, Scores>([
            ["x", scoresOf([1, 2, 3, 4, 5, 6, 7, 8])],
            ["y", scoresOf([10, 9, 8, 7, 6, 5, 4, 3])],
            ["z", { method_fits_design: 5 }],
        ]);
        const b = new Map<string, Scores>([
            ["x", scoresOf([1, 2, 3, 4, 5, 6, 7, 8])],
            ["y", scoresOf([10, 9, 8, 7, 6, 5, 4, 3])],
            ["z", { method_fits_design: 9, qc_present: 2 }],
            ["w", scoresOf([3])],
        ]);
        const comparison = compareRaters(a, b);
        expect(comparison.n).toBe(2);
        expect(comparison.kappa_total).toBe(1);
        expect(comparison.kappa_by_criterion.qc_present).toBe(1);
        expect(comparison.kappa_by_criterion.method_fits_design).not.toBe(1);
    });
});

describe("the stratified sample", () => {
    const runs = ["b", "a", "c"].flatMap((arm) => Array.from({ length: 10 }, (_, index) => ({ arm: `${arm}--m`, task: `t${index % 4}`, run: index + 1, file: `t${index % 4}.run-${index + 1}.json` })));

    function countByArm(sample: readonly { arm: string }[]): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const run of sample) counts[run.arm] = (counts[run.arm] ?? 0) + 1;
        return counts;
    }

    it("takes an equal share of each arm and gives the remainder to the first arms", () => {
        expect(countByArm(sampleStratified(runs, 12, 1))).toEqual({ "a--m": 4, "b--m": 4, "c--m": 4 });
        expect(countByArm(sampleStratified(runs, 10, 1))).toEqual({ "a--m": 4, "b--m": 3, "c--m": 3 });
        expect(sampleStratified(runs, 40, 1)).toHaveLength(30);
        expect(sampleStratified(runs, 0, 1)).toHaveLength(0);
    });

    it("is reproducible from the seed and independent of the input order", () => {
        const first = sampleStratified(runs, 12, 42);
        expect(sampleStratified(runs, 12, 42)).toEqual(first);
        expect(sampleStratified([...runs].reverse(), 12, 42)).toEqual(first);
        expect(sampleStratified(runs, 12, 43)).not.toEqual(first);
        expect(new Set(first.map((run) => `${run.arm}/${run.file}`)).size).toBe(12);
    });

    it("does not order the sample by arm", () => {
        const arms = sampleStratified(runs, 30, 42).map((run) => run.arm);
        expect(arms).not.toEqual([...arms].sort());
    });

    it("names the keys with a zero-padded index", () => {
        expect(keysFor(3)).toEqual(["cal-01", "cal-02", "cal-03"]);
        expect(keysFor(120)[119]).toBe("cal-120");
        expect(sheetTemplate(["cal-01"])).toBe(`key,criterion,score\n${CRITERION_KEYS.map((key) => `cal-01,${key},`).join("\n")}\n`);
    });
});

describe("the export", () => {
    it("writes the key, a blinded packet per run, and a sheet per expert", async () => {
        await withTempDir(async (root) => {
            await writeCampaign(root, 3);
            const tasks = new Map([[task.id, task]]);
            const { sample, dir } = await exportSample({ root, campaign: "probe", tasks, n: 4, seed: 5, exportedAt: "2026-09-07T00:00:00.000Z" });
            expect(sample.n).toBe(4);
            expect(sample.records).toBe(6);
            expect(sample.seed).toBe(5);
            expect(Object.keys(sample.runs)).toEqual(["cal-01", "cal-02", "cal-03", "cal-04"]);
            const arms = Object.values(sample.runs).map((run) => run.arm).sort();
            expect(arms).toEqual(["with--claude-opus-5", "with--claude-opus-5", "without--claude-sonnet-5", "without--claude-sonnet-5"]);
            expect(await readSample(root)).toEqual(sample);

            const packets = (await readdir(join(dir, "packets"))).sort();
            expect(packets).toEqual(["cal-01.md", "cal-02.md", "cal-03.md", "cal-04.md"]);
            for (const [key, run] of Object.entries(sample.runs)) {
                const text = await Bun.file(join(dir, "packets", `${key}.md`)).text();
                const original = (await Bun.file(join(root, run.arm, run.file)).json()) as never;
                expect(text).toBe(judgePrompt(task, original).user);
                expect(text).toContain("## The plan");
                expect(text).toContain(`A plan of run ${run.run}`);
                for (const leak of ["with--", "without--", "claude-opus-5", "claude-sonnet-5", CLAIM, DIGEST, REASON, "grounding", "tpl-qc-eda", "snapshot", key, run.arm]) expect(text).not.toContain(leak);
            }
            for (const expert of ["sheet-expert-1.csv", "sheet-expert-2.csv"]) {
                const sheet = await Bun.file(join(dir, expert)).text();
                expect(sheet).toBe(sheetTemplate(Object.keys(sample.runs)));
                expect(sheet.split("\n").filter((line) => line.length > 0)).toHaveLength(1 + 4 * CRITERION_KEYS.length);
            }

            await expect(exportSample({ root, campaign: "probe", tasks, n: 4, seed: 5 })).rejects.toThrow(/exists/);
            expect((await listRecords(root)).map((entry) => entry.arm)).not.toContain("calibration");
            expect(await listRecords(root)).toHaveLength(6);
        });
    });

    it("samples the same runs from the same seed", async () => {
        await withTempDir(async (root) => {
            await writeCampaign(root, 5);
            const tasks = new Map([[task.id, task]]);
            const first = (await exportSample({ root: join(root), campaign: "probe", tasks, n: 6, seed: 9 })).sample.runs;
            await rm(join(root, "calibration"), { recursive: true });
            const second = (await exportSample({ root, campaign: "probe", tasks, n: 6, seed: 9 })).sample.runs;
            expect(second).toEqual(first);
            await rm(join(root, "calibration"), { recursive: true });
            const other = (await exportSample({ root, campaign: "probe", tasks, n: 6, seed: 10 })).sample.runs;
            expect(other).not.toEqual(first);
        });
    });

    it("skips a record whose task is not in the task set", async () => {
        await withTempDir(async (root) => {
            await writeCampaign(root, 2);
            await Bun.write(join(root, "with--claude-opus-5", "zz.seed-1.run-1.json"), JSON.stringify(record("with--claude-opus-5", "claude-opus-5", 9, { task: "zz" })));
            const { sample } = await exportSample({ root, campaign: "probe", tasks: new Map([[task.id, task]]), n: 40, seed: 1 });
            expect(sample.n).toBe(4);
            expect(sample.records).toBe(5);
            expect(Object.values(sample.runs).every((run) => run.task === "t1")).toBe(true);
        });
    });
});

describe("the score sheet", () => {
    it("reads a filled sheet, skips an empty score, and accepts quotes and CRLF", () => {
        const text = 'key,criterion,score\r\n"cal-01","method_fits_design","8"\r\ncal-01,qc_present,\r\n\r\ncal-02,qc_present,3\r\n';
        const sheet = parseSheet(text);
        expect(sheet.get("cal-01")).toEqual({ method_fits_design: 8 });
        expect(sheet.get("cal-02")).toEqual({ qc_present: 3 });
    });

    it("refuses a bad header, an unknown criterion, a score outside 0-10, and a duplicate row", () => {
        expect(() => parseSheet("id,criterion,score\n")).toThrow(/header/);
        expect(() => parseSheet("key,criterion,score\ncal-01,style,5\n")).toThrow(/criterion style/);
        expect(() => parseSheet("key,criterion,score\ncal-01,qc_present,11\n")).toThrow(/score 11/);
        expect(() => parseSheet("key,criterion,score\ncal-01,qc_present,high\n")).toThrow(/score high/);
        expect(() => parseSheet("key,criterion,score\ncal-01,qc_present,5\ncal-01,qc_present,6\n")).toThrow(/second time/);
        expect(() => parseSheet("key,criterion,score\n,qc_present,5\n")).toThrow(/no key/);
    });
});

describe("the calibration record", () => {
    it("gives kappa_total 1 and pass on two sheets identical to the judge", async () => {
        await withTempDir(async (root) => {
            const verdicts = await writeCampaign(root, 8);
            const tasks = new Map([[task.id, task]]);
            const { sample } = await exportSample({ root, campaign: "probe", tasks, n: 6, seed: 3 });
            const { scores, judge } = await readJudgeScores(root, sample, ".judge-opus.json");
            expect(scores.size).toBe(6);
            expect(judge).toEqual({ model: "claude-opus-5", provider: "cliproxy", tag: "opus", prompt_digest: "sha256:p" });
            for (const [key, run] of Object.entries(sample.runs)) expect(scores.get(key)).toEqual(verdicts.get(`${run.arm}/${run.file}`));

            const sheet = parseSheet(sheetOf(scores));
            const calibration = buildCalibration({ campaign: "probe", judge, sampleSize: sample.n, records: sample.records, judgeScores: scores, experts: [["expert_1", sheet], ["expert_2", parseSheet(sheetOf(scores))]] });
            expect(calibration.kappa_total).toBe(1);
            expect(calibration.pass).toBe(true);
            expect(calibration.n).toBe(6);
            expect(calibration.judged).toBe(6);
            expect(calibration.threshold).toBe(0.7);
            expect(calibration.experts).toEqual(["expert_1", "expert_2"]);
            expect(calibration.judge_versus_expert.expert_1!.n).toBe(6);
            expect(calibration.judge_versus_expert.expert_2!.kappa_total).toBe(1);
            expect(calibration.expert_agreement.kappa_total).toBe(1);
            expect(calibration.double_scored_share).toBeCloseTo(6 / 16, 12);
            expect(calibration.kappa_by_criterion.fdr_shrinkage).toBe(1);
            // Every run scores method_fits_design 10, thus its kappa has no meaning.
            expect(calibration.kappa_by_criterion.method_fits_design).toBeNull();
        });
    });

    it("fails on a disagreeing expert, reports the smaller kappa, and skips a failed verdict", async () => {
        await withTempDir(async (root) => {
            await writeCampaign(root, 8, { failed: [2] });
            const tasks = new Map([[task.id, task]]);
            const { sample } = await exportSample({ root, campaign: "probe", tasks, n: 16, seed: 3 });
            const { scores } = await readJudgeScores(root, sample, ".judge-opus.json");
            expect(scores.size).toBe(15);
            const random = rng(11);
            const noise = new Map([...scores.keys()].map((key) => [key, randomScores(random)]));
            const calibration = buildCalibration({ campaign: "probe", judge: { model: "claude-opus-5" }, sampleSize: sample.n, records: sample.records, judgeScores: scores, experts: [["expert_1", new Map(scores)], ["expert_2", noise]] });
            expect(calibration.judged).toBe(15);
            expect(calibration.judge_versus_expert.expert_1!.kappa_total).toBe(1);
            expect(calibration.judge_versus_expert.expert_2!.kappa_total).toBeLessThan(0.7);
            expect(calibration.kappa_total).toBe(calibration.judge_versus_expert.expert_2!.kappa_total);
            expect(calibration.pass).toBe(false);
            expect(calibration.double_scored_share).toBeCloseTo(15 / 16, 12);
        });
    });

    it("fails without a verdict and refuses one sheet", () => {
        const empty = new Map<string, Scores>();
        const calibration = buildCalibration({ campaign: "probe", judge: { model: "m" }, sampleSize: 4, records: 4, judgeScores: empty, experts: [["expert_1", empty], ["expert_2", empty]] });
        expect(calibration.kappa_total).toBeNull();
        expect(calibration.pass).toBe(false);
        expect(calibration.double_scored_share).toBe(0);
        expect(() => buildCalibration({ campaign: "probe", judge: { model: "m" }, sampleSize: 4, records: 4, judgeScores: empty, experts: [["expert_1", empty]] })).toThrow(/two expert sheets/);
    });
});
