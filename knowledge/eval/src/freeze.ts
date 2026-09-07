/**
 * The campaign freeze: one manifest per campaign, written before the first
 * lane runs and never written again. The manifest holds the complete identity
 * of the experiment: the task set by digest and split, the seeds by split, the
 * served corpus, the runtime commits, the arms with their provider settings,
 * the judge by model and prompt digest, and the statistics of the report. The
 * runner, the judge, and the report read it, and each refuses an identity
 * outside it unless `--exploratory` is passed.
 *
 *   bun eval/src/freeze.ts --campaign c1 --seeds-dev 1 --seeds-held 7 \
 *       --tasks-dev two-group-n3,two-group-n6-enrich --tasks-held batch-balanced-n6 \
 *       --arms economical_with=with:economical:openai-compatible:z-ai/glm-5.3-flash \
 *              economical_without=without:economical:openai-compatible:z-ai/glm-5.3-flash \
 *              frontier_with=with:frontier:cliproxy:claude-opus-5 \
 *              frontier_without=without:frontier:cliproxy:claude-opus-5 \
 *       --judge cliproxy:claude-opus-5 --judge-tag opus --margin 5 --runs 3
 *
 * Options: --service-url (default http://127.0.0.1:8790), --out (default
 * eval/results), and --base-url, --provider-order, --request-timeout-ms: the
 * settings of every openai-compatible arm, as run.ts receives them. An arm name
 * is free. The contrasts name the arms by role and condition, the primary
 * (economical with tools versus frontier without) first. Without --tasks-dev,
 * every task outside the held-out list is a development task.
 *
 * The weights and the price basis are placeholders until W01 sets them: every
 * task weighs 1 and the price basis is empty.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { $ } from "bun";
import { z } from "zod";

import { CRITERIA, criteriaText, judgeSystem } from "./judge.js";
import { EVAL_ROOT, loadTasks } from "./tasks.js";

export const ArmSchema = z.object({
    name: z.string().min(1),
    condition: z.enum(["with", "without"]),
    role: z.enum(["economical", "frontier"]),
    provider: z.enum(["cliproxy", "anthropic", "openai-compatible"]),
    model: z.string().min(1),
    baseUrl: z.string().optional(),
    providerOrder: z.array(z.string()).optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
});
export type Arm = z.infer<typeof ArmSchema>;

export const CorpusSchema = z.object({
    date: z.string(),
    digest: z.string(),
    schema_version: z.string(),
    tool_definition_hash: z.string(),
});

export const ManifestSchema = z.object({
    campaign: z.string().min(1),
    frozen_at: z.string(),
    task_set: z.object({
        path: z.string(),
        digest: z.string(),
        ids: z.array(z.string()),
        split: z.object({ development: z.array(z.string()), held_out: z.array(z.string()) }),
        weights: z.record(z.string(), z.number()),
    }),
    seeds: z.object({ development: z.array(z.number().int()), held_out: z.array(z.number().int()) }),
    corpus: CorpusSchema,
    runtime: z.object({ harness_commit: z.string(), knowledge_commit: z.string(), bun: z.string() }),
    arms: z.array(ArmSchema),
    judge: z.object({
        provider: z.enum(["cliproxy", "anthropic", "openai-compatible"]),
        model: z.string().min(1),
        tag: z.string().optional(),
        prompt_digest: z.string(),
    }),
    statistics: z.object({
        margin: z.number(),
        alpha_one_sided: z.number(),
        contrasts: z.array(z.tuple([z.string(), z.string()])),
        runs_per_task: z.number().int().positive(),
    }),
    price_basis: z.record(z.string(), z.unknown()),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const TASKS_PATH = join(EVAL_ROOT, "tasks", "tasks.yaml");

/** The contrast family, the primary first, as `<role>_<condition>` slots that the arms fill. */
const CONTRAST_SLOTS: readonly (readonly [string, string])[] = [
    ["economical_with", "frontier_without"],
    ["economical_with", "economical_without"],
    ["frontier_with", "frontier_without"],
    ["economical_with", "frontier_with"],
];

function sha256(text: string | Uint8Array): string {
    return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The digest of the task set file, byte for byte. */
export async function tasksDigest(path = TASKS_PATH): Promise<string> {
    return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

/** The digest of the judge prompt: the system text and the criteria. A changed criterion changes it. */
export function promptDigest(criteria: readonly (readonly [string, string])[] = CRITERIA): string {
    return sha256(`${judgeSystem(criteria)}\n${criteriaText(criteria)}`);
}

/** Write the manifest once. An existing file is refused, never replaced. */
export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
    const text = `${JSON.stringify(ManifestSchema.parse(manifest), null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeFile(path, text, { flag: "wx" });
    } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") throw new Error(`the manifest ${path} exists; a campaign is frozen once`);
        throw error;
    }
}

export async function readManifest(path: string): Promise<Manifest> {
    if (!(await Bun.file(path).exists())) throw new Error(`no manifest at ${path}; freeze the campaign first with eval:freeze`);
    return ManifestSchema.parse(await Bun.file(path).json());
}

/** One arm from `<name>=<condition>:<role>:<provider>:<model>`; the model keeps any further colon. */
export function parseArm(spec: string, settings: Pick<Arm, "baseUrl" | "providerOrder" | "requestTimeoutMs"> = {}): Arm {
    const equals = spec.indexOf("=");
    if (equals <= 0) throw new Error(`the arm ${spec} is not <name>=<condition>:<role>:<provider>:<model>`);
    const name = spec.slice(0, equals);
    const [condition, role, provider, ...model] = spec.slice(equals + 1).split(":");
    if (model.length === 0) throw new Error(`the arm ${spec} is not <name>=<condition>:<role>:<provider>:<model>`);
    const openai = provider === "openai-compatible";
    return ArmSchema.parse({
        name,
        condition,
        role,
        provider,
        model: model.join(":"),
        ...(openai && settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
        ...(openai && settings.providerOrder ? { providerOrder: settings.providerOrder } : {}),
        ...(settings.requestTimeoutMs ? { requestTimeoutMs: settings.requestTimeoutMs } : {}),
    });
}

export interface FreezeInput {
    readonly campaign: string;
    readonly taskIds: readonly string[];
    readonly tasksPath: string;
    readonly tasksDigest: string;
    /** Absent: every task outside the held-out list. */
    readonly tasksDev?: readonly string[];
    readonly tasksHeld: readonly string[];
    readonly seedsDev: readonly number[];
    readonly seedsHeld: readonly number[];
    readonly corpus: Manifest["corpus"];
    readonly runtime: Manifest["runtime"];
    readonly arms: readonly Arm[];
    readonly judge: Manifest["judge"];
    readonly margin: number;
    readonly runsPerTask: number;
    readonly frozenAt?: string;
}

function disjoint<T>(label: string, a: readonly T[], b: readonly T[]): void {
    const shared = a.filter((item) => b.includes(item));
    if (shared.length > 0) throw new Error(`the ${label} ${shared.join(", ")} cannot be development and held out at once`);
}

/** Assemble the manifest from parsed inputs; the network and the git reads happen before. */
export function buildManifest(input: FreezeInput): Manifest {
    const known = new Set(input.taskIds);
    const unknown = [...(input.tasksDev ?? []), ...input.tasksHeld].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`the task set has no task ${unknown.join(", ")}`);
    const held = [...new Set(input.tasksHeld)];
    const development = [...new Set(input.tasksDev ?? input.taskIds.filter((id) => !held.includes(id)))];
    disjoint("task", development, held);
    disjoint("seed", input.seedsDev, input.seedsHeld);
    if (input.seedsDev.length === 0 && input.seedsHeld.length === 0) throw new Error("a campaign needs at least one seed");
    const ids = input.taskIds.filter((id) => development.includes(id) || held.includes(id));

    const names = new Set<string>();
    const bySlot = new Map<string, string>();
    for (const arm of input.arms) {
        if (names.has(arm.name)) throw new Error(`two arms are named ${arm.name}`);
        names.add(arm.name);
        const slot = `${arm.role}_${arm.condition}`;
        if (bySlot.has(slot)) throw new Error(`two arms fill the slot ${slot}: ${bySlot.get(slot)} and ${arm.name}`);
        bySlot.set(slot, arm.name);
    }
    const contrasts = CONTRAST_SLOTS.flatMap(([a, b]) => {
        const left = bySlot.get(a);
        const right = bySlot.get(b);
        return left && right ? [[left, right] as [string, string]] : [];
    });

    return ManifestSchema.parse({
        campaign: input.campaign,
        frozen_at: input.frozenAt ?? new Date().toISOString(),
        task_set: {
            path: input.tasksPath,
            digest: input.tasksDigest,
            ids,
            split: { development, held_out: held },
            weights: Object.fromEntries(ids.map((id) => [id, 1])),
        },
        seeds: { development: [...input.seedsDev], held_out: [...input.seedsHeld] },
        corpus: input.corpus,
        runtime: input.runtime,
        arms: [...input.arms],
        judge: input.judge,
        statistics: { margin: input.margin, alpha_one_sided: 0.025, contrasts, runs_per_task: input.runsPerTask },
        price_basis: {},
    });
}

/** The last commit that touched a subsystem, with `-dirty` when its working copy differs. */
async function gitIdentity(subdir: string): Promise<string> {
    const root = join(EVAL_ROOT, "..", "..");
    const sha = (await $`git -C ${root} log -1 --format=%H -- ${subdir}`.text()).trim();
    const dirty = (await $`git -C ${root} status --porcelain -- ${subdir}`.text()).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
}

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Every value after each occurrence of the option, up to the next option. */
function argumentList(name: string): string[] {
    const values: string[] = [];
    process.argv.forEach((token, index) => {
        if (token !== name) return;
        for (let next = index + 1; next < process.argv.length && !process.argv[next]!.startsWith("--"); next += 1) values.push(process.argv[next]!);
    });
    return values;
}

function idList(value: string | undefined): string[] {
    return (value ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function seedList(name: string, value: string | undefined): number[] {
    return idList(value).map((item) => {
        const seed = Number(item);
        if (!Number.isInteger(seed) || seed < 1) throw new Error(`${name} holds ${item}, not a positive integer`);
        return seed;
    });
}

if (import.meta.main) {
    const campaign = argument("--campaign") ?? "phase0";
    const serviceUrl = argument("--service-url") ?? "http://127.0.0.1:8790";
    const out = argument("--out") ?? join(EVAL_ROOT, "results");
    const path = join(out, campaign, "manifest.json");
    if (await Bun.file(path).exists()) {
        console.error(`the manifest ${path} exists; a campaign is frozen once`);
        process.exit(1);
    }
    const response = await fetch(`${serviceUrl}/v1/snapshot`).catch(() => undefined);
    if (!response?.ok) {
        console.error(`the knowledge service at ${serviceUrl} does not answer; start it with \`bun run serve\``);
        process.exit(1);
    }
    const corpus = CorpusSchema.parse(await response.json());
    const settings = {
        ...(argument("--base-url") ? { baseUrl: argument("--base-url") } : {}),
        ...(argument("--provider-order") ? { providerOrder: argument("--provider-order")!.split(",") } : {}),
        ...(argument("--request-timeout-ms") ? { requestTimeoutMs: Number(argument("--request-timeout-ms")) } : {}),
    };
    const [judgeProvider, ...judgeModel] = (argument("--judge") ?? "cliproxy:claude-opus-5").split(":");
    const tag = argument("--judge-tag");
    const tasksDev = argument("--tasks-dev");
    const manifest = buildManifest({
        campaign,
        taskIds: (await loadTasks(TASKS_PATH)).map((task) => task.id),
        tasksPath: relative(join(EVAL_ROOT, ".."), TASKS_PATH),
        tasksDigest: await tasksDigest(TASKS_PATH),
        ...(tasksDev !== undefined ? { tasksDev: idList(tasksDev) } : {}),
        tasksHeld: idList(argument("--tasks-held")),
        seedsDev: seedList("--seeds-dev", argument("--seeds-dev") ?? "1"),
        seedsHeld: seedList("--seeds-held", argument("--seeds-held")),
        corpus,
        runtime: { harness_commit: await gitIdentity("harness"), knowledge_commit: await gitIdentity("knowledge"), bun: Bun.version },
        arms: argumentList("--arms").map((spec) => parseArm(spec, settings)),
        judge: {
            provider: judgeProvider as Manifest["judge"]["provider"],
            model: judgeModel.join(":"),
            ...(tag ? { tag } : {}),
            prompt_digest: promptDigest(),
        },
        margin: Number(argument("--margin") ?? "5"),
        runsPerTask: Number(argument("--runs") ?? "1"),
    });
    await writeManifest(path, manifest);
    const { task_set, seeds, arms, judge } = manifest;
    console.log(
        `froze ${campaign} -> ${path}\n` +
            `  corpus ${corpus.date} ${corpus.digest} (schema ${corpus.schema_version}, tools ${corpus.tool_definition_hash})\n` +
            `  tasks ${task_set.ids.length} (${task_set.split.development.length} development, ${task_set.split.held_out.length} held out), digest ${task_set.digest}\n` +
            `  seeds development [${seeds.development.join(", ")}] held out [${seeds.held_out.join(", ")}]\n` +
            `  arms ${arms.length}: ${arms.map((arm) => `${arm.name} (${arm.condition}, ${arm.role}, ${arm.provider}:${arm.model})`).join(", ") || "none"}\n` +
            `  judge ${judge.provider}:${judge.model}${judge.tag ? ` tag ${judge.tag}` : ""} prompt ${judge.prompt_digest}\n` +
            `  contrasts ${manifest.statistics.contrasts.map(([a, b]) => `${a} vs ${b}`).join(", ") || "none"}, margin ${manifest.statistics.margin}, runs per task ${manifest.statistics.runs_per_task}`,
    );
}
