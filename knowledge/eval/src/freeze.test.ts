import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest, type Manifest, parseArm, promptDigest, readManifest, tasksDigest, TASKS_PATH, writeManifest } from "./freeze.js";
import { CRITERIA, isVerdictFile, judgeCampaign, type JudgeIdentity, manifestDifferences } from "./judge.js";
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
            parseArm("economical_with=with:economical:openai-compatible:z-ai/glm-5.3-flash", { baseUrl: "https://openrouter.ai/api/v1", providerOrder: ["z-ai/fp8"] }),
            parseArm("economical_without=without:economical:openai-compatible:z-ai/glm-5.3-flash", { baseUrl: "https://openrouter.ai/api/v1", providerOrder: ["z-ai/fp8"] }),
            parseArm("frontier_with=with:frontier:cliproxy:claude-opus-5"),
            parseArm("frontier_without=without:frontier:cliproxy:claude-opus-5"),
        ],
        judge: JUDGE,
        margin: 5,
        runsPerTask: 3,
        frozenAt: "2026-09-07T00:00:00.000Z",
    });
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "freeze-"));
    try {
        return await work(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("the campaign manifest", () => {
    it("digests the task set the same way twice, and differently for different bytes", async () => {
        await withTempDir(async (dir) => {
            const path = join(dir, "tasks.yaml");
            await Bun.write(path, "- id: a\n");
            const first = await tasksDigest(path);
            expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
            expect(await tasksDigest(path)).toBe(first);
            await Bun.write(path, "- id: b\n");
            expect(await tasksDigest(path)).not.toBe(first);
        });
        const real = await tasksDigest(TASKS_PATH);
        expect(real).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(await tasksDigest(TASKS_PATH)).toBe(real);
    });

    it("refuses a second write", async () => {
        await withTempDir(async (dir) => {
            const path = join(dir, "results", "probe", "manifest.json");
            await writeManifest(path, sampleManifest());
            await expect(writeManifest(path, sampleManifest())).rejects.toThrow(/frozen once/);
        });
    });

    it("reads back what it wrote", async () => {
        await withTempDir(async (dir) => {
            const path = join(dir, "manifest.json");
            const manifest = sampleManifest();
            await writeManifest(path, manifest);
            expect(await readManifest(path)).toEqual(manifest);
            await expect(readManifest(join(dir, "absent.json"))).rejects.toThrow(/no manifest/);
        });
    });

    it("builds the split, the weights, and the contrast family with the primary first", () => {
        const manifest = sampleManifest();
        expect(manifest.task_set.ids).toEqual(["a", "b", "c", "d"]);
        expect(manifest.task_set.split).toEqual({ development: ["a", "b"], held_out: ["c", "d"] });
        expect(manifest.task_set.weights).toEqual({ a: 1, b: 1, c: 1, d: 1 });
        expect(manifest.seeds).toEqual({ development: [1], held_out: [7] });
        expect(manifest.statistics).toEqual({
            margin: 5,
            alpha_one_sided: 0.025,
            contrasts: [
                ["economical_with", "frontier_without"],
                ["economical_with", "economical_without"],
                ["frontier_with", "frontier_without"],
                ["economical_with", "frontier_with"],
            ],
            runs_per_task: 3,
        });
        expect(manifest.arms[0]).toEqual({ name: "economical_with", condition: "with", role: "economical", provider: "openai-compatible", model: "z-ai/glm-5.3-flash", baseUrl: "https://openrouter.ai/api/v1", providerOrder: ["z-ai/fp8"] });
        expect(manifest.arms[2]).toEqual({ name: "frontier_with", condition: "with", role: "frontier", provider: "cliproxy", model: "claude-opus-5" });
    });

    it("refuses an overlap of the splits, an unknown task, and a duplicate slot", () => {
        const base = { campaign: "probe", taskIds: ["a", "b"], tasksPath: "p", tasksDigest: "d", tasksHeld: [], seedsDev: [1], seedsHeld: [], corpus: CORPUS, runtime: RUNTIME, arms: [], judge: JUDGE, margin: 5, runsPerTask: 1 };
        expect(() => buildManifest({ ...base, tasksDev: ["a"], tasksHeld: ["a"] })).toThrow(/development and held out/);
        expect(() => buildManifest({ ...base, seedsDev: [1], seedsHeld: [1] })).toThrow(/development and held out/);
        expect(() => buildManifest({ ...base, tasksHeld: ["zzz"] })).toThrow(/no task zzz/);
        expect(() => buildManifest({ ...base, arms: [parseArm("x=with:frontier:cliproxy:m1"), parseArm("y=with:frontier:cliproxy:m2")] })).toThrow(/slot frontier_with/);
        const defaulted = buildManifest({ ...base, tasksHeld: ["b"] });
        expect(defaulted.task_set.split).toEqual({ development: ["a"], held_out: ["b"] });
    });

    it("keeps a colon inside the model of an arm", () => {
        expect(parseArm("e=with:economical:openai-compatible:qwen:7b").model).toBe("qwen:7b");
        expect(() => parseArm("e=with:economical")).toThrow(/not <name>/);
        expect(() => parseArm("e=with:other:cliproxy:m")).toThrow();
    });

    it("changes the prompt digest when the criteria change", () => {
        expect(promptDigest()).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(promptDigest()).toBe(promptDigest(CRITERIA));
        expect(promptDigest([...CRITERIA, ["extra", "An extra criterion."]])).not.toBe(promptDigest());
        const [first, ...rest] = CRITERIA;
        expect(promptDigest([[first![0], `${first![1]} And more.`], ...rest])).not.toBe(promptDigest());
    });
});

describe("the judge record", () => {
    const task = TaskSchema.parse({ id: "t1", pattern: "p", question: "q", tissue: "liver", condition: "c", experimental_design: "d", count_source: "salmon", concerns: [], reference: "r", must_match: [], must_not_match: [] });
    const identity: JudgeIdentity = { provider: "cliproxy", model: "claude-opus-5", tag: "opus", prompt_digest: promptDigest() };
    const scores = Object.fromEntries(CRITERIA.map(([key]) => [key, 8])) as Record<(typeof CRITERIA)[number][0], number>;

    it("leaves a failed file for a failed call, retries it, and skips a verdict", async () => {
        await withTempDir(async (root) => {
            const arm = join(root, "with--claude-opus-5");
            await mkdir(arm, { recursive: true });
            await Bun.write(join(arm, "t1.seed-1.run-1.json"), JSON.stringify({ task: "t1", run: 1, outcome: "plan_submitted", usage: {}, toolCalls: [] }));
            await Bun.write(join(arm, "t2.seed-1.run-1.json"), JSON.stringify({ task: "t2", run: 1, outcome: "plan_submitted", usage: {}, toolCalls: [] }));
            const tasks = new Map([[task.id, task]]);
            const verdictPath = join(arm, "t1.seed-1.run-1.judge-opus.json");
            const log = (): void => undefined;

            const failing = await judgeCampaign({ root, tasks, identity, judge: async () => { throw new Error("the judge call failed: 503"); }, log });
            expect(failing).toEqual({ judged: 0, failed: 1, skipped: 0 });
            expect(await Bun.file(verdictPath).json()).toEqual({ failed: "the judge call failed: 503", judge: "claude-opus-5", provider: "cliproxy", model: "claude-opus-5", tag: "opus", prompt_digest: promptDigest() });
            expect(await isVerdictFile(verdictPath)).toBe(false);

            let calls = 0;
            const answering = async (): Promise<{ scores: typeof scores; rationale: string }> => {
                calls += 1;
                return { scores, rationale: "fine" };
            };
            expect(await judgeCampaign({ root, tasks, identity, judge: answering, log })).toEqual({ judged: 1, failed: 0, skipped: 0 });
            expect(await Bun.file(verdictPath).json()).toEqual({ judge: "claude-opus-5", provider: "cliproxy", model: "claude-opus-5", tag: "opus", prompt_digest: promptDigest(), scores, rationale: "fine" });
            expect(await isVerdictFile(verdictPath)).toBe(true);

            expect(await judgeCampaign({ root, tasks, identity, judge: answering, log })).toEqual({ judged: 0, failed: 0, skipped: 1 });
            expect(calls).toBe(1);
        });
    });

    it("names each field on which a judge differs from the frozen one", () => {
        const manifest = sampleManifest();
        expect(manifestDifferences(manifest, identity)).toEqual([]);
        expect(manifestDifferences(undefined, identity)).toEqual(["the campaign has no manifest"]);
        expect(manifestDifferences(manifest, { ...identity, model: "claude-sonnet-5", prompt_digest: "sha256:0" })).toEqual([
            "the judge model claude-sonnet-5 is not the frozen claude-opus-5",
            "the judge prompt_digest sha256:0 is not the frozen " + promptDigest(),
        ]);
        const { tag: _tag, ...untagged } = identity;
        expect(manifestDifferences(manifest, untagged)).toEqual(["the judge tag (none) is not the frozen opus"]);
    });
});
