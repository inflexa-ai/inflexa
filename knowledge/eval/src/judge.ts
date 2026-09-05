/**
 * The rubric judge: one frontier model scores a plan on the eight criteria
 * of Section 10 against the reference paragraph of the task. The judge sees
 * the plan as the user would (the step fields), never the condition, never
 * the model that wrote it, and never the tool calls, thus it is blind to the
 * arm. A calibration against two blinded experts is the Phase 0 gate that
 * this file does not replace: the judge is accepted at a weighted kappa of at
 * least 0.7, and the report says when that calibration has not run.
 *
 *   bun eval/src/judge.ts --campaign c1 --judge-model claude-opus-5 --provider cliproxy
 *   bun eval/src/judge.ts --campaign c1 --judge-model claude-sonnet-5 --judge-tag sonnet   (a second judge, beside the first)
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { buildProvider, replyText, type ModelConnection } from "./provider.js";
import type { RunRecord } from "./run.js";
import { EVAL_ROOT, loadTasks, type Task } from "./tasks.js";
import type { PlanLike } from "./score.js";

export const CRITERIA = [
    ["method_fits_design", "The statistical method fits the design: the data state, the replicate number, the pairing or blocking, the batch structure, the interaction or time course."],
    ["qc_present", "A sample structure QC precedes the test: PCA, sample distances, library sizes, colored by condition and batch, with a policy for an outlier or a shallow sample."],
    ["low_count_filter", "A low count filter that is minimal and justified, not arbitrary and not too strict."],
    ["normalization", "Normalization inside the model (size factors or TMM); no pre-normalized values into a count model; no count adjustment before the model."],
    ["model_formula_contrasts", "The design formula and the contrast are explicit and correct: the reference level, the blocking or batch term, the interaction term, the reduced model."],
    ["fdr_shrinkage", "Multiple testing by BH at a stated alpha, fold change shrinkage for the reported effect, thresholds in the test rather than post hoc."],
    ["enrichment_universe_sets", "Enrichment, when asked or warranted: the full ranked list for GSEA with the ranking metric stated, an explicit universe for ORA, a named collection and version, a size window. Score 10 when enrichment is not warranted and the plan correctly omits it."],
    ["report_completeness", "The report names the method, the versions, the design, the thresholds, the counts of tested and significant genes, and the caveats of the design."],
] as const;

export const JudgeVerdictSchema = z.object({
    scores: z.object(Object.fromEntries(CRITERIA.map(([key]) => [key, z.number().min(0).max(10)])) as Record<(typeof CRITERIA)[number][0], z.ZodNumber>),
    rationale: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The plan as the judge reads it: the step fields only, no grounding and no ids that could reveal the arm. */
function planForJudge(plan: PlanLike | undefined): string {
    if (!plan) return "(no plan was submitted)";
    const steps = (plan.steps ?? []).map((step, index) => {
        const lines = [`Step ${index + 1}: ${step.name ?? ""} [agent: ${step.agent ?? ""}]`, `Question: ${step.question ?? ""}`];
        if (step.description) lines.push(`Produces: ${step.description}`);
        if (step.context) lines.push(`Context: ${step.context}`);
        if (step.constraints?.length) lines.push(`Constraints: ${step.constraints.join(" | ")}`);
        if (step.acceptance_criteria?.length) lines.push(`Acceptance: ${step.acceptance_criteria.join(" | ")}`);
        if (step.caveats?.length) lines.push(`Caveats: ${step.caveats.join(" | ")}`);
        if (step.packages?.length) lines.push(`Packages: ${step.packages.join(", ")}`);
        return lines.join("\n");
    });
    return [`Title: ${plan.title ?? ""}`, `Narrative: ${plan.analytical_narrative ?? ""}`, ...steps].join("\n\n");
}

export function judgePrompt(task: Task, record: RunRecord): { system: string; user: string } {
    const system =
        "You are a senior bioinformatics statistician who reviews analysis plans for bulk RNA-seq. " +
        "You score one plan against a reference on eight criteria, each from 0 (absent or wrong) to 10 (correct and complete). " +
        "Judge the plan only on what it states. A plan that does the right thing but does not say so scores low on that criterion. " +
        "A plan that could apply to any dataset scores low on the design criteria. Do not reward length. " +
        "Answer with one JSON object only, of the form " +
        `{"scores": {${CRITERIA.map(([key]) => `"${key}": <0-10>`).join(", ")}}, "rationale": "<two to five sentences>"}.`;
    const criteria = CRITERIA.map(([key, text]) => `- ${key}: ${text}`).join("\n");
    const outcome = record.outcome === "plan_submitted" ? "The planner submitted the plan below." : `The planner ended with: ${record.outcome}${record.question ? ` (question to the user: ${record.question})` : ""}${record.error ? ` (${record.error})` : ""}.`;
    const user =
        `## The task\n${task.question}\n\n## The dataset\n${task.experimental_design}\nTissue: ${task.tissue}. Condition: ${task.condition}.` +
        (task.concerns.length ? `\nConcerns: ${task.concerns.join("; ")}` : "") +
        `\n\n## The reference (what a correct plan does)\n${task.reference}\n\n## The criteria\n${criteria}\n\n## The outcome\n${outcome}\n\n## The plan\n${planForJudge(record.plan as PlanLike | undefined)}`;
    return { system, user };
}

export async function judgeRun(connection: ModelConnection, task: Task, record: RunRecord): Promise<JudgeVerdict> {
    const provider = await buildProvider(connection);
    const { system, user } = judgePrompt(task, record);
    const session = { identity: { user: "eval-judge" }, scope: { kind: "analysis" as const, analysisId: "eval-judge" }, provenance: { agentId: "judge", callPath: ["judge"] } };
    const result = await provider.chat({ system, messages: [{ role: "user", content: user }], tools: {} }, session as never);
    if (result.isErr()) throw new Error(`the judge call failed: ${JSON.stringify(result.error)}`);
    const text = replyText(result.value.message.content);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`the judge answered without JSON: ${text.slice(0, 200)}`);
    return JudgeVerdictSchema.parse(JSON.parse(match[0]));
}

if (import.meta.main) {
    const campaign = argument("--campaign") ?? "phase0";
    const connection: ModelConnection = {
        provider: (argument("--provider") ?? "cliproxy") as ModelConnection["provider"],
        model: argument("--judge-model") ?? "claude-opus-5",
        ...(argument("--base-url") ? { baseUrl: argument("--base-url") } : {}),
        ...(argument("--api-key-env") ? { apiKeyEnv: argument("--api-key-env") } : {}),
    };
    const tasks = new Map((await loadTasks()).map((task) => [task.id, task]));
    const root = join(argument("--out") ?? join(EVAL_ROOT, "results"), campaign);
    // A second judge writes beside the first under a tag, thus two judges of one
    // campaign can be compared without one overwriting the other.
    const tag = argument("--judge-tag");
    const judgeSuffix = tag ? `.judge-${tag}.json` : ".judge.json";
    for (const arm of await readdir(root, { withFileTypes: true })) {
        if (!arm.isDirectory()) continue;
        const dir = join(root, arm.name);
        for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json") && !/\.judge(-[a-z0-9]+)?\.json$/.test(name))) {
            const judgePath = join(dir, file.replace(/\.json$/, judgeSuffix));
            if (await Bun.file(judgePath).exists()) continue;
            const record = (await Bun.file(join(dir, file)).json()) as RunRecord;
            const task = tasks.get(record.task);
            if (!task) continue;
            process.stdout.write(`judge ${arm.name}/${file} ... `);
            try {
                const verdict = await judgeRun(connection, task, record);
                await Bun.write(judgePath, `${JSON.stringify({ judge: connection.model, ...verdict }, null, 2)}\n`);
                const total = Object.values(verdict.scores).reduce((sum, value) => sum + value, 0) * 1.25;
                console.log(`${total.toFixed(0)}/100`);
            } catch (error) {
                console.log(`failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
