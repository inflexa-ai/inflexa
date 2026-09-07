/**
 * The Phase 0 runner: the real planner of the harness, on each task, with and
 * without the knowledge tools, N runs each. Every run records the outcome,
 * the plan, the tokens, the wall-clock, every tool call with its input and
 * its outcome, and every call to the knowledge service with its request and
 * its trimmed response, thus the report can measure the call rate, the
 * situation fill, the grounding against the exact snapshot, and the cost.
 *
 *   bun eval/src/run.ts --campaign c1 --condition with --model claude-opus-5 --provider cliproxy --runs 3
 *   bun eval/src/run.ts --campaign c1 --condition without --model claude-opus-5 --provider cliproxy --runs 3
 *   bun eval/src/run.ts --campaign c1 --condition with --model glm-5.3-flash --provider openai-compatible \
 *       --base-url https://... --api-key-env GLM_API_KEY --runs 3
 *   bun eval/src/run.ts --campaign c1 --condition with --model z-ai/glm-5.3-flash --provider openai-compatible \
 *       --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --provider-order z-ai/fp8,baseten/fp8
 *
 * Options: --tasks <id,id>, --seed <n> (default 1: the simulation seed of the dataset
 * behind the profile), --pg-url, --service-url (default http://127.0.0.1:8790),
 * --service-key-env (default INFLEXA_KNOWLEDGE_SERVICE_KEY), --out (default eval/results),
 * --refs-dir (default ~/.local/share/inflexa/refs) and --farm-lock (default the catalog
 * farm of ~/.local/share/inflexa/package-store): the reference store and the package
 * inventory that the planner reads, the same two the CLI binds, so a campaign run sees
 * what a real run sees. Pass --no-stores to run the planner with neither bound.
 *
 * The lane runs under the frozen manifest of the campaign (--manifest, default
 * results/<campaign>/manifest.json). A lane whose arm, seed, served snapshot, or
 * task set is outside the manifest is refused, unless --exploratory is passed,
 * which marks every record of the lane `exploratory`.
 *
 * The condition `with` binds the knowledge client to the planner, and nothing
 * else changes: the same prompt, the same seed, the same search tools. Thus the
 * comparison isolates the three tools.
 */

import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { createHttpKnowledgeClient, initCortexState, loadPlan, makeLocalAuth, passthroughStep, UnavailableAsk, type KnowledgeClient, type Pool } from "@inflexa-ai/harness";
import { createGeneratePlanTool } from "@inflexa-ai/harness/tools/research/generate-plan.js";

import { readManifest, TASKS_PATH, tasksDigest, type Manifest } from "./freeze.js";
import { buildProvider, type ModelConnection } from "./provider.js";
import { recordingKnowledgeClient } from "./record-client.js";
import { laneDifferences, splitOf, type KnowledgeCall, type RunConnection, type RunRecord, type ToolCallOutcome, type ToolCallRecord } from "./record.js";
import { buildProfile, datasetDir, EVAL_ROOT, loadTasks, type Task } from "./tasks.js";

export type { RunRecord } from "./record.js";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function schemaPool(pgUrl: string, schema: string): Promise<Pool> {
    const admin = new pg.Pool({ connectionString: pgUrl });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await admin.end();
    // The harness types its pool from its own copy of `@types/pg`; the runtime object is the same
    // `pg` module, thus the cast bridges two identical declarations, not two behaviors.
    const pool = new pg.Pool({ connectionString: pgUrl, options: `-c search_path=${schema},public` }) as unknown as Pool;
    await initCortexState(pool);
    return pool;
}

async function seedAnalysis(pool: Pool, analysisId: string, profile: unknown): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, data_profile_result, seed_input_file_ids, created_at, updated_at)
           VALUES ($1, 'active', NULL, 'completed', $2::jsonb, $3::jsonb, $4, $5)
           ON CONFLICT (analysis_id) DO UPDATE SET data_profile_result = EXCLUDED.data_profile_result, data_profile_status = 'completed'`,
        values: [analysisId, JSON.stringify(profile), JSON.stringify(["counts", "metadata"]), now, now],
    });
}

/** The tool-call entry as the emit handler fills it: started with `incomplete`, finished with the outcome of the loop. */
interface MutableToolCall {
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
    outcome: ToolCallOutcome;
    durationMs?: number;
}

/** The digest of one file, byte for byte, in the form the manifest uses. */
async function fileDigest(path: string): Promise<string> {
    return `sha256:${createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex")}`;
}

async function runOne(options: {
    readonly campaign: string;
    readonly condition: "with" | "without";
    readonly connection: ModelConnection;
    readonly task: Task;
    readonly run: number;
    readonly seed: number;
    readonly pool: Pool;
    readonly knowledge: KnowledgeClient | undefined;
    readonly snapshot: { date: string; digest: string } | undefined;
    readonly stores: { readonly refStorePath: string; readonly farmLockFile: string } | undefined;
    readonly manifest: Manifest | undefined;
    readonly manifestRef: { readonly path: string; readonly digest: string } | undefined;
    readonly exploratory: boolean;
}): Promise<RunRecord> {
    const { task, run, seed, pool, connection } = options;
    const analysisId = `eval-${options.campaign}-${options.condition}-${task.id}-s${seed}-${run}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    await seedAnalysis(pool, analysisId, await buildProfile(task, seed));
    const provider = await buildProvider(connection);
    // The recording client is per run: its sink is the `knowledgeCalls` list of this record.
    const knowledgeCalls: KnowledgeCall[] = [];
    const knowledge = options.knowledge ? recordingKnowledgeClient(options.knowledge, knowledgeCalls) : undefined;
    const tool = createGeneratePlanTool({
        conversation: { provider, model: connection.model },
        pool,
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        ...(knowledge ? { knowledge } : {}),
        ...(options.stores ?? {}),
    });
    const usage: Record<string, number> = {};
    const toolCalls: MutableToolCall[] = [];
    const session = {
        identity: { user: "eval" },
        scope: { kind: "analysis" as const, analysisId },
        provenance: { agentId: "conversation-agent", callPath: ["conversation-agent"] },
        auth: makeLocalAuth(),
    };
    const deny = new UnavailableAsk();
    const startedAt = new Date();
    let outcome = "loop_error";
    let planId: string | undefined;
    let question: string | undefined;
    let error: string | undefined;
    try {
        const result = await tool.execute(
            { researchQuestion: task.question, ...(task.constraints ? { userConstraints: task.constraints } : {}) },
            {
                invocationId: `eval-${analysisId}`,
                session,
                signal: AbortSignal.timeout(Math.max(20 * 60_000, (connection.requestTimeoutMs ?? 0) + 60_000)),
                emit: async (event: unknown) => {
                    const e = event as { type?: string; toolUseId?: string; name?: string; input?: unknown; outcome?: ToolCallOutcome; durationMs?: number };
                    if (e.type === "tool-started" && e.name) {
                        toolCalls.push({ toolUseId: e.toolUseId ?? "", name: e.name, input: e.input, outcome: "incomplete" });
                    } else if (e.type === "tool-finished" && e.toolUseId) {
                        // The loop emits every start of a round before any finish, thus the first
                        // incomplete entry with this id is the call that finished.
                        const entry = toolCalls.find((call) => call.toolUseId === e.toolUseId && call.outcome === "incomplete");
                        if (entry) {
                            entry.outcome = e.outcome ?? "ok";
                            if (e.durationMs !== undefined) entry.durationMs = e.durationMs;
                        }
                    }
                },
                runStep: passthroughStep,
                ask: (request: Parameters<UnavailableAsk["ask"]>[0]) => deny.ask(request),
                turnUsage: usage,
            },
        );
        if (result.isErr()) {
            outcome = "tool_error";
            error = result.error.error;
        } else {
            // The planner tool is typed as a bare `Tool`; its ok value is the planning agent output.
            const value = result.value as { event: string; planId?: string; question?: string; error?: string };
            outcome = value.event === "plan_complete" ? "plan_submitted" : value.event;
            planId = value.planId;
            question = value.question;
            error = value.error;
        }
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    const elapsedMs = Date.now() - startedAt.getTime();
    let plan: unknown;
    if (planId) {
        const loaded = await loadPlan(pool, planId, { analysisId });
        if (loaded.isOk()) plan = loaded.value;
    }
    const recordedConnection: RunConnection = {
        provider: connection.provider,
        ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
        ...(connection.providerOrder ? { providerOrder: connection.providerOrder } : {}),
        ...(connection.requestTimeoutMs ? { requestTimeoutMs: connection.requestTimeoutMs } : {}),
    };
    return {
        campaign: options.campaign,
        condition: options.condition,
        model: connection.model,
        task: task.id,
        run,
        seed,
        split: splitOf(options.manifest, task.id, seed),
        startedAt: startedAt.toISOString(),
        elapsedMs,
        outcome,
        ...(planId ? { planId } : {}),
        ...(plan !== undefined ? { plan } : {}),
        ...(question ? { question } : {}),
        ...(error ? { error } : {}),
        usage,
        toolCalls: toolCalls as ToolCallRecord[],
        knowledgeCalls,
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
        connection: recordedConnection,
        ...(options.manifestRef ? { manifest: options.manifestRef } : {}),
        ...(options.exploratory ? { exploratory: true as const } : {}),
    };
}

if (import.meta.main) {
    const campaign = argument("--campaign") ?? "phase0";
    const condition = (argument("--condition") ?? "with") as "with" | "without";
    const runs = Number(argument("--runs") ?? "1");
    const seed = Number(argument("--seed") ?? "1");
    if (!Number.isInteger(seed) || seed < 1) {
        console.error(`--seed holds ${argument("--seed")}, not a positive integer`);
        process.exit(1);
    }
    const only = argument("--tasks")?.split(",");
    const pgUrl = argument("--pg-url") ?? Bun.env.INFLEXA_EVAL_PG_URL ?? "postgres://inflexa:inflexa@127.0.0.1:8432/inflexa";
    const serviceUrl = argument("--service-url") ?? "http://127.0.0.1:8790";
    const serviceKey = Bun.env[argument("--service-key-env") ?? "INFLEXA_KNOWLEDGE_SERVICE_KEY"] ?? "";
    const out = argument("--out") ?? join(EVAL_ROOT, "results");
    const manifestPath = argument("--manifest") ?? join(out, campaign, "manifest.json");
    const exploratory = process.argv.includes("--exploratory");
    const dataDir = join(homedir(), ".local", "share", "inflexa");
    const stores = process.argv.includes("--no-stores")
        ? undefined
        : {
              refStorePath: argument("--refs-dir") ?? join(dataDir, "refs"),
              farmLockFile: argument("--farm-lock") ?? join(dataDir, "package-store", "farms", "catalog", "inflexa.lock"),
          };
    if (stores) {
        for (const [name, path] of Object.entries(stores)) {
            if (!(await Bun.file(path).exists()) && !(await stat(path).then((s) => s.isDirectory()).catch(() => false))) {
                console.error(`the ${name} ${path} does not exist; pass --refs-dir / --farm-lock, or --no-stores`);
                process.exit(1);
            }
        }
        console.log(`stores: refs ${stores.refStorePath}, farm lock ${stores.farmLockFile}`);
    } else {
        console.log("stores: none bound (--no-stores)");
    }
    const connection: ModelConnection = {
        provider: (argument("--provider") ?? "cliproxy") as ModelConnection["provider"],
        model: argument("--model") ?? "claude-opus-5",
        ...(argument("--base-url") ? { baseUrl: argument("--base-url") } : {}),
        ...(argument("--api-key-env") ? { apiKeyEnv: argument("--api-key-env") } : {}),
        ...(argument("--provider-name") ? { name: argument("--provider-name") } : {}),
        ...(argument("--provider-order") ? { providerOrder: argument("--provider-order")?.split(",") } : {}),
        ...(argument("--request-timeout-ms") ? { requestTimeoutMs: Number(argument("--request-timeout-ms")) } : {}),
    };

    let knowledge: KnowledgeClient | undefined;
    let snapshot: { date: string; digest: string } | undefined;
    if (condition === "with") {
        const health = await fetch(`${serviceUrl}/v1/snapshot`).catch(() => undefined);
        if (!health?.ok) {
            console.error(`the knowledge service at ${serviceUrl} does not answer; start it with \`bun run serve\``);
            process.exit(1);
        }
        const meta = (await health.json()) as { date: string; digest: string };
        snapshot = { date: meta.date, digest: meta.digest };
        knowledge = createHttpKnowledgeClient({ baseUrl: serviceUrl, apiKey: serviceKey });
        console.log(`knowledge service ${serviceUrl} snapshot ${meta.date} ${meta.digest}`);
    }

    const tasks = (await loadTasks()).filter((task) => !only || only.includes(task.id));

    // The manifest gate: a confirmatory lane is inside the frozen identity, or it does not run.
    const manifest = (await Bun.file(manifestPath).exists()) ? await readManifest(manifestPath) : undefined;
    const manifestRef = manifest ? { path: manifestPath, digest: await fileDigest(manifestPath) } : undefined;
    const differences = laneDifferences(manifest, {
        condition,
        connection,
        seed,
        ...(snapshot ? { snapshotDigest: snapshot.digest } : {}),
        taskIds: tasks.map((task) => task.id),
        tasksDigest: await tasksDigest(TASKS_PATH),
    });
    if (differences.length > 0) {
        if (!exploratory) {
            console.error(`${differences.join("; ")}. Pass --exploratory to run outside the manifest ${manifestPath}.`);
            process.exit(1);
        }
        console.warn(`exploratory lane: ${differences.join("; ")}`);
    }

    for (const task of tasks) {
        const dir = datasetDir(task, seed);
        if (!(await stat(dir).then((s) => s.isDirectory()).catch(() => false))) {
            console.error(`the dataset ${dir} of task ${task.id} does not exist; simulate seed ${seed} first with eval:simulate`);
            process.exit(1);
        }
    }

    const schema = `eval_${campaign.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
    const pool = await schemaPool(pgUrl, schema);
    const modelSlug = connection.model.replace(/[^a-z0-9.-]/gi, "_");
    const dir = join(out, campaign, `${condition}--${modelSlug}`);
    await mkdir(dir, { recursive: true });
    console.log(`campaign ${campaign} condition ${condition} model ${connection.model} seed ${seed}: ${tasks.length} task(s) x ${runs} run(s) -> ${dir}`);

    for (const task of tasks) {
        for (let run = 1; run <= runs; run += 1) {
            const path = join(dir, `${task.id}.seed-${seed}.run-${run}.json`);
            if (await Bun.file(path).exists()) {
                console.log(`skip ${task.id} seed ${seed} run ${run} (exists)`);
                continue;
            }
            process.stdout.write(`${task.id} seed ${seed} run ${run} ... `);
            const record = await runOne({ campaign, condition, connection, task, run, seed, pool, knowledge, snapshot, stores, manifest, manifestRef, exploratory: differences.length > 0 });
            await Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
            const failed = record.toolCalls.filter((call) => call.outcome !== "ok").length;
            console.log(
                `${record.outcome} in ${(record.elapsedMs / 1000).toFixed(0)}s, ${record.toolCalls.length} tool calls (${record.knowledgeCalls.length} knowledge, ${failed} not ok), out ${record.usage.outputTokens ?? 0} tok`,
            );
        }
    }
    await pool.end();
}
