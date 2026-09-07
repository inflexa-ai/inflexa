/**
 * The headless end-to-end runner of the Phase 0 evaluation: one attempt is
 * the whole product path on one task, with no CLI and no chat turn. The
 * attempt stages the inputs of the task into a fresh workspace, runs the real
 * data profiler, drives the planner tool of the harness under the shared
 * clarification policy, launches the analysis run through the same seams the
 * `execute_analysis` tool uses, observes the run to its terminal status, and
 * collects the outputs, the transcripts, the usage per role, and the
 * environment identity into one `record.json`.
 *
 *   bun eval/src/run-full.ts --campaign e2e-smoke --condition with --model claude-sonnet-5 --provider cliproxy \
 *       --tasks two-group-n6-enrich --runs 1 --pg-url postgres://inflexa:inflexa@127.0.0.1:8432/eval_e2e_smoke \
 *       --embedding http://127.0.0.1:8899/v1 --embedding-dimensions 384
 *
 * Options: --sandbox-model and --utility-model (default --model), --provider
 * (cliproxy | anthropic | openai-compatible) with --base-url, --api-key-env,
 * --provider-name, --provider-order, --request-timeout-ms as run.ts takes them,
 * --tasks <id,id>, --runs <n>, --seed <n>, --pg-url (default the campaign
 * database eval_<campaign> on the local Postgres), --engine-socket <path>,
 * --engine-bind-ownership host-preserved (podman), --store-dir (default
 * ~/.local/share/inflexa/package-store), --refs-dir (default
 * ~/.local/share/inflexa/refs), --image (default the sandbox-base tag),
 * --embedding <base url> with --embedding-key-env, --embedding-model, and
 * --embedding-dimensions, --run-timeout-min (default 120), --service-url,
 * --service-key-env, --out (default eval/results), --manifest, --exploratory,
 * --skills-dir.
 *
 * The attempt directory is eval/results/<campaign>/<condition>--<model>/<task>.seed-<s>.run-<n>/
 * with record.json, calls.jsonl, usage.jsonl, events.jsonl, profile.json,
 * plan.json, transcript.jsonl (the parent workflow), steps/<stepId>/transcript.jsonl,
 * steps/<stepId>/files/, synthesis.json, files.json, and workspace/. One
 * Postgres database serves one campaign, because DBOS owns the `dbos` schema
 * of the database it launches in. The attempts run one at a time.
 *
 * The `with` arm binds one recording knowledge client to the planner and to
 * every sandbox agent. Nothing else differs between the arms.
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { $ } from "bun";

import {
    AnalysisPlanSchema,
    createConsoleLogger,
    createHttpKnowledgeClient,
    createNoopRunCharge,
    createRunCanceler,
    createRunEventStream,
    insertRun,
    loadDataProfileStatus,
    loadPlan,
    makeLocalAuth,
    parseReferenceInstallReceipt,
    passthroughStep,
    queryRun,
    queryStepsByRun,
    readFarmLockFile,
    StatusString,
    triggerDataProfile,
    UnavailableAsk,
    updateRunStatus,
    upsertAnalysis,
    validatePlan,
    type AgentSession,
    type AnalysisPlan,
    type CortexRunRow,
    type ExecuteAnalysisInput,
    type KnowledgeClient,
    type Logger,
    type Pool,
    type ResourcePolicy,
    type StagedInput,
    type StepExecutionRow,
} from "@inflexa-ai/harness";
import { createGeneratePlanTool } from "@inflexa-ai/harness/tools/research/generate-plan.js";

import { runWithClarifications, type PlannerOutputLike } from "./clarification.js";
import { composeEvalRuntime, defaultResourcePolicy, type EvalRuntime } from "./compose.js";
import { readManifest, TASKS_PATH, tasksDigest, type Manifest } from "./freeze.js";
import type { ModelConnection } from "./provider.js";
import { recordingKnowledgeClient, type KnowledgeCallSink } from "./record-client.js";
import { laneDifferences, splitOf, type FullRunRecord, type FullRunStep, type KnowledgeCall, type RunConnection, type ToolCallOutcome, type ToolCallRecord } from "./record.js";
import { DE_TABLE_COLUMNS } from "./score-outputs.js";
import { stageTaskInputs, writeWorkspaceMap } from "./stage.js";
import { datasetDir, EVAL_ROOT, loadTasks, type Task } from "./tasks.js";
import { createJsonlSink, foldUsage, readUsageFile } from "./usage-sink.js";

// ── Constants ───────────────────────────────────────────────────────

/** The profiler's own deadline; the poll gives up at the same bound. */
const PROFILE_DEADLINE_MS = 20 * 60_000;
const POLL_MS = 2_000;
/** How long the event stream gets to drain the children after the ledger is terminal. */
const STREAM_DRAIN_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MIN = 120;
const DEFAULT_IMAGE = "ghcr.io/inflexa-ai/sandbox-base:latest";
const DEFAULT_SERVICE_URL = "http://127.0.0.1:8790";
const TRANSCRIPT_SOURCE = "dbos.operation_outputs";

/** The eval holds no bio key, the same as run.ts. */
const NO_BIO_KEYS = { drugbank: "", disgenet: "", epaCcte: "" };

/** The synthetic origin of a run the runner launches; read-only metadata, as the CLI's `cli-run-launch`. */
const RUN_LAUNCH_PROVENANCE = { agentId: "eval-run-launch", callPath: ["eval-run-launch"] };

/** The terminal statuses of a DBOS workflow: the wedge rule of the CLI (`cli/src/modules/harness/dev/run.ts`). */
const DBOS_TERMINAL_STATUSES: ReadonlySet<string> = new Set([StatusString.SUCCESS, StatusString.ERROR, StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED, StatusString.CANCELLED]);

/** The header names an enrichment table carries: one set column and one adjusted-p column, in lower case. */
const ENRICHMENT_SET_COLUMNS = new Set(["pathway", "term", "gene_set", "geneset", "pathway_id", "term_id", "id", "description", "name"]);
const ENRICHMENT_PADJ_COLUMNS = new Set(["padj", "adjusted_pvalue", "p.adjust", "p_adjust", "padjust", "fdr", "qvalue", "q_value", "qval", "adj_p", "adj_pvalue", "p_adj", "adjusted_p"]);
const FIGURE_EXTENSIONS = /\.(png|pdf|svg|jpe?g)$/i;
const TABLE_EXTENSIONS = /\.(csv|tsv)$/i;

// ── Options ─────────────────────────────────────────────────────────

type Condition = "with" | "without";

interface RunFullOptions {
    readonly campaign: string;
    readonly condition: Condition;
    readonly connections: { readonly planner: ModelConnection; readonly sandbox: ModelConnection; readonly utility: ModelConnection };
    readonly tasks: readonly Task[];
    readonly runs: number;
    readonly seed: number;
    readonly pgUrl: string;
    readonly out: string;
    readonly sandbox: {
        readonly image: string;
        readonly storeDir: string;
        readonly refsDir: string;
        readonly engineSocketPath?: string;
        readonly engineBindOwnership?: "host-preserved";
    };
    readonly embedding: { readonly baseUrl: string; readonly apiKey: string; readonly model?: string; readonly dimensions?: number };
    readonly runTimeoutMs: number;
    readonly skillsDir?: string;
    readonly knowledge?: KnowledgeClient;
    readonly snapshot?: { readonly date: string; readonly digest: string };
    readonly manifest?: Manifest;
    readonly manifestRef?: { readonly path: string; readonly digest: string };
    readonly exploratory: boolean;
}

// ── Small helpers ───────────────────────────────────────────────────

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function describeCause(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === "object" && cause !== null && "type" in cause) return JSON.stringify(cause);
    return String(cause);
}

/** The neverthrow surface the harness state functions answer with. */
interface ResultLike<T, E> {
    isErr(): boolean;
    readonly value?: T;
    readonly error?: E;
}

/** The value of a harness `Result`, or a throw that names the call. */
function unwrap<T, E>(result: ResultLike<T, E>, what: string): T {
    if (result.isErr()) throw new Error(`${what} failed: ${describeCause(result.error)}`);
    return result.value as T;
}

async function isDirectory(path: string): Promise<boolean> {
    return stat(path).then(
        (info) => info.isDirectory(),
        () => false,
    );
}

async function isFile(path: string): Promise<boolean> {
    return stat(path).then(
        (info) => info.isFile(),
        () => false,
    );
}

async function sha256File(path: string): Promise<string> {
    return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every file under `dir`, as posix paths relative to `dir`, in a stable order. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const files: string[] = [];
    for (const entry of entries) {
        const key = posix.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), key)));
        else if (entry.isFile()) files.push(key);
    }
    return files;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The commit of one subsystem, `-dirty` when its tree has changes; the same form as the manifest. */
async function gitIdentity(subdir: string): Promise<string> {
    const root = join(EVAL_ROOT, "..", "..");
    try {
        const sha = (await $`git -C ${root} log -1 --format=%H -- ${subdir}`.text()).trim();
        const dirty = (await $`git -C ${root} status --porcelain -- ${subdir}`.text()).trim().length > 0;
        return dirty ? `${sha}-dirty` : sha;
    } catch {
        return "unknown";
    }
}

// ── The knowledge sink of the process ───────────────────────────────

/**
 * One recording client serves every attempt of the process, because the
 * runtime binds it at boot. The sink behind it moves per attempt: `reset`
 * gives the list of the next attempt and the wrapper keeps pushing into it.
 */
interface AttemptKnowledgeSink extends KnowledgeCallSink {
    reset(): KnowledgeCall[];
}

function createAttemptKnowledgeSink(): AttemptKnowledgeSink {
    let current: KnowledgeCall[] = [];
    return {
        get length() {
            return current.length;
        },
        push(call: KnowledgeCall) {
            current.push(call);
        },
        reset() {
            current = [];
            return current;
        },
    };
}

// ── The attempt ─────────────────────────────────────────────────────

type Stage = "stage" | "profile" | "plan" | "execute" | "observe" | "collect";

/** A stage that ends the attempt with a named outcome. The sections written before it stay in the record. */
class AttemptStop extends Error {
    constructor(
        readonly stage: Stage,
        readonly outcome: string,
        message: string,
    ) {
        super(message);
        this.name = "AttemptStop";
    }
}

/** The tool-call entry as the emit handler fills it: started with `incomplete`, finished with the outcome of the loop. */
interface MutableToolCall {
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
    outcome: ToolCallOutcome;
    durationMs?: number;
}

/** The record under construction; every stage writes its section and a stop leaves the rest at its default. */
interface Draft {
    profile: FullRunRecord["profile"];
    plan: { planId: string | null; outcome: string; clarifications: FullRunRecord["plan"]["clarifications"]; plan: unknown };
    run: { runId: string | null; status: string; error: string | null; synthesis_status: string; steps: FullRunStep[]; artifacts: unknown[]; environment_missing: string[] };
    toolCalls: MutableToolCall[];
    toolCallsByStep: Record<string, ToolCallRecord[]>;
    outputs: FullRunRecord["outputs"];
    failures: { stage: string; message: string }[];
    timings: Record<string, number>;
    question?: string;
    error?: string;
}

interface AttemptContext {
    readonly options: RunFullOptions;
    readonly runtime: EvalRuntime;
    readonly resourcePolicy: ResourcePolicy;
    readonly logger: Logger;
    readonly task: Task;
    readonly run: number;
    readonly analysisId: string;
    readonly attemptDir: string;
    readonly campaignDir: string;
    readonly workspaceRoot: string;
    readonly session: AgentSession;
    readonly farmLockFile: string;
    readonly draft: Draft;
}

/** Run one stage under its timer; a throw is recorded as a failure of the stage and thrown again. */
async function timed<T>(ctx: AttemptContext, stage: Stage, body: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
        return await body();
    } catch (caught) {
        ctx.draft.failures.push({ stage, message: caught instanceof Error ? caught.message : String(caught) });
        throw caught;
    } finally {
        ctx.draft.timings[stage] = Date.now() - started;
    }
}

// ── Stage: inputs ───────────────────────────────────────────────────

async function stageStage(ctx: AttemptContext): Promise<StagedInput[]> {
    const staged = await stageTaskInputs(ctx.task, datasetDir(ctx.task, ctx.options.seed), ctx.workspaceRoot);
    writeWorkspaceMap(ctx.campaignDir, ctx.analysisId, ctx.workspaceRoot);
    return staged;
}

// ── Stage: profile ──────────────────────────────────────────────────

/**
 * Seed the ledger with the staged file ids, trigger the data profile under
 * the eval auth, and poll the ledger to `completed` or `failed`. The profiler
 * is the real sandbox agent of the harness; its usage lands in usage.jsonl
 * under the role `data-profiler` through the recorder of the runtime.
 */
async function profileStage(ctx: AttemptContext, staged: readonly StagedInput[]): Promise<void> {
    const { pool } = ctx.runtime;
    const started = Date.now();
    unwrap(
        await upsertAnalysis(
            pool,
            ctx.analysisId,
            null,
            staged.map((file) => file.fileId),
        ),
        "upsertAnalysis",
    );
    const trigger = await triggerDataProfile(
        { pool, runAuthorizer: ctx.runtime.runAuthorizer, workflow: ctx.runtime.runtime.workflows.dataProfile, logger: ctx.logger },
        { auth: makeLocalAuth(), analysisId: ctx.analysisId, stagedInputs: staged },
    );
    if (trigger === "failed") {
        ctx.draft.profile = { status: "failed", durationMs: Date.now() - started, result: null };
        throw new AttemptStop("profile", "profile_failed", "the data profile trigger reported failed");
    }
    for (;;) {
        const status = unwrap(await loadDataProfileStatus(pool, ctx.analysisId), "loadDataProfileStatus");
        if (status?.status === "completed" || status?.status === "failed") {
            const durationMs = Date.now() - started;
            await writeJson(join(ctx.attemptDir, "profile.json"), status);
            ctx.draft.profile = { status: status.status, durationMs, result: status.result };
            if (status.status === "failed") throw new AttemptStop("profile", "profile_failed", status.error ?? "the data profile failed");
            return;
        }
        if (Date.now() - started > PROFILE_DEADLINE_MS) {
            ctx.draft.profile = { status: "timed_out", durationMs: Date.now() - started, result: null };
            throw new AttemptStop("profile", "profile_failed", `the data profile did not end within ${PROFILE_DEADLINE_MS / 60_000} min`);
        }
        await Bun.sleep(POLL_MS);
    }
}

// ── Stage: plan ─────────────────────────────────────────────────────

type PlannerOutput = PlannerOutputLike & { readonly planId?: string; readonly error?: string };

/**
 * Drive the planner tool of the harness over the real ledger profile, the
 * fixed catalog farm lock, the refs dir, and the recording providers; in the
 * `with` arm the recording knowledge client rides too. The clarification
 * policy answers one question and re-invokes once.
 */
async function planStage(ctx: AttemptContext): Promise<{ planId: string; plan: AnalysisPlan; raw: unknown }> {
    const { runtime, task, options } = ctx;
    const tool = createGeneratePlanTool({
        conversation: { provider: runtime.providers.planner, model: runtime.models.planner },
        pool: runtime.pool,
        resourcePolicy: ctx.resourcePolicy,
        logger: ctx.logger,
        usageRecorder: runtime.recorder,
        bioKeys: NO_BIO_KEYS,
        ...(runtime.knowledge ? { knowledge: runtime.knowledge } : {}),
        refStorePath: options.sandbox.refsDir,
        farmLockFile: ctx.farmLockFile,
    });
    const deny = new UnavailableAsk();
    const toolCalls = ctx.draft.toolCalls;
    const planTimeoutMs = Math.max(20 * 60_000, (options.connections.planner.requestTimeoutMs ?? 0) + 60_000);
    let invocation = 0;
    const invoke = async (analystNotes: string | undefined) => {
        invocation += 1;
        const usage: Record<string, number> = {};
        const result = await tool.execute(
            {
                researchQuestion: task.question,
                ...(task.constraints ? { userConstraints: task.constraints } : {}),
                ...(analystNotes ? { analystNotes } : {}),
            },
            {
                invocationId: `eval-${ctx.analysisId}-${invocation}`,
                session: ctx.session,
                signal: AbortSignal.timeout(planTimeoutMs),
                emit: async (event: unknown) => {
                    const e = event as { type?: string; toolUseId?: string; name?: string; input?: unknown; outcome?: ToolCallOutcome; durationMs?: number };
                    if (e.type === "tool-started" && e.name) {
                        toolCalls.push({ toolUseId: e.toolUseId ?? "", name: e.name, input: e.input, outcome: "incomplete" });
                    } else if (e.type === "tool-finished" && e.toolUseId) {
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
        if (result.isErr()) return { output: { event: "error", error: result.error.error } as PlannerOutput, usage };
        return { output: result.value as PlannerOutput, usage };
    };
    const driven = await runWithClarifications(invoke);
    ctx.draft.plan.clarifications = driven.clarifications;
    const output = driven.output;
    if (output.event === "plan_complete" && output.planId) {
        const raw = unwrap(await loadPlan(runtime.pool, output.planId, { analysisId: ctx.analysisId }), "loadPlan");
        if (raw === null) throw new AttemptStop("plan", "plan_error", `the plan ${output.planId} is not in the ledger`);
        await writeJson(join(ctx.attemptDir, "plan.json"), raw);
        ctx.draft.plan = { ...ctx.draft.plan, planId: output.planId, outcome: "plan_submitted", plan: raw };
        const parsed = AnalysisPlanSchema.safeParse(raw);
        if (!parsed.success) throw new AttemptStop("plan", "plan_invalid", `the stored plan does not parse: ${parsed.error.message}`);
        const validation = validatePlan(parsed.data);
        if (!validation.valid) throw new AttemptStop("plan", "plan_invalid", validation.errors.join("; "));
        return { planId: output.planId, plan: parsed.data, raw };
    }
    if (output.event === "clarification_needed") {
        ctx.draft.plan = { ...ctx.draft.plan, outcome: "clarification_needed" };
        ctx.draft.question = output.question;
        throw new AttemptStop("plan", "clarification_needed", output.question ?? "the planner asked a second clarification");
    }
    const outcome = output.event === "error" && output.error?.startsWith("Plan generation") ? "plan_error" : "tool_error";
    ctx.draft.plan = { ...ctx.draft.plan, outcome };
    throw new AttemptStop("plan", outcome, output.error ?? "the planner ended with no plan");
}

// ── Stage: execute ──────────────────────────────────────────────────

/** The plan packages the catalog lock does not hold: an environment fact of the record, never a link. */
function environmentMissing(plan: AnalysisPlan, farmLockFile: string): string[] {
    const lock = readFarmLockFile(farmLockFile);
    const held = new Set<string>();
    if (lock.isOk()) for (const entry of lock.value.packages) held.add(entry.name.toLowerCase());
    const missing = new Set<string>();
    for (const step of plan.steps) {
        for (const entry of step.packages ?? []) {
            const split = entry.indexOf("==");
            const name = (split < 0 ? entry : entry.slice(0, split)).trim();
            if (name.length > 0 && !held.has(name.toLowerCase())) missing.add(entry.trim());
        }
    }
    return [...missing].sort();
}

/**
 * Reserve the run row, authorize the run, build the workflow input as the
 * `execute_analysis` tool does, and launch the parent workflow under the run
 * id. A failure after the reservation marks the row failed, as the tool does.
 */
async function executeStage(ctx: AttemptContext, planId: string, plan: AnalysisPlan): Promise<string> {
    const { pool, runAuthorizer, runLauncher } = ctx.runtime;
    ctx.draft.run.environment_missing = environmentMissing(plan, ctx.farmLockFile);
    const runId = randomUUID();
    ctx.draft.run.runId = runId;
    unwrap(await insertRun(pool, { runId, analysisId: ctx.analysisId, threadId: null, workflowName: "executeAnalysis", planId }), "insertRun");
    let authorization: Awaited<ReturnType<typeof runAuthorizer.authorize>>;
    try {
        authorization = await runAuthorizer.authorize({
            auth: makeLocalAuth(),
            scope: { kind: "analysis", analysisId: ctx.analysisId },
            provenance: RUN_LAUNCH_PROVENANCE,
            frame: { runId },
        });
    } catch (cause) {
        await updateRunStatus(pool, runId, "failed", "run authorization failed");
        ctx.draft.run.status = "failed";
        ctx.draft.run.error = "run authorization failed";
        throw new AttemptStop("execute", "launch_failed", `run authorization failed: ${describeCause(cause)}`);
    }
    try {
        const input: ExecuteAnalysisInput = {
            analysisId: ctx.analysisId,
            planId,
            planSummary: plan.title?.trim() || plan.analytical_narrative.trim().slice(0, 280),
            threadId: null,
            steps: plan.steps.map((step) => ({ id: step.id, depends_on: step.depends_on ?? [] })),
            planStepById: Object.fromEntries(plan.steps.map((step) => [step.id, step])),
            agentByStepId: Object.fromEntries(plan.steps.map((step) => [step.id, step.agent ?? "unknown"])),
            resourcesByStepId: Object.fromEntries(
                plan.steps.map((step) => {
                    if (!step.resources) throw new Error(`the step ${step.id} has no resources`);
                    return [step.id, step.resources];
                }),
            ),
            timeoutByStepId: Object.fromEntries(plan.steps.filter((step) => step.timeout !== undefined).map((step) => [step.id, step.timeout as number])),
            budget: ctx.resourcePolicy.budget,
            runSession: authorization.runSession,
            ownsMandate: authorization.ownsMandate,
            synthesisEnabled: true,
        };
        await runLauncher.launch(ctx.runtime.runtime.workflows.executeAnalysis, { workflowId: runId }, input);
    } catch (cause) {
        await runAuthorizer.revoke(authorization, "workflow-start-failed").catch(() => {});
        await updateRunStatus(pool, runId, "failed", "workflow start failed");
        ctx.draft.run.status = "failed";
        ctx.draft.run.error = "workflow start failed";
        throw new AttemptStop("execute", "launch_failed", `the run workflow did not start: ${describeCause(cause)}`);
    }
    return runId;
}

// ── Stage: observe ──────────────────────────────────────────────────

async function readParentWorkflowDbosStatus(pool: Pool, runId: string): Promise<string | null> {
    try {
        const result = await pool.query<{ status: string }>({ text: "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1", values: [runId] });
        return result.rows[0]?.status ?? null;
    } catch {
        return null;
    }
}

interface ObservedRun {
    readonly row: CortexRunRow | null;
    /** The ledger status, or `timed_out`, `wedged`, or `vanished` when the runner ended the wait. */
    readonly status: string;
    readonly error: string | null;
}

/**
 * Subscribe to the run event stream into events.jsonl and poll the ledger to
 * a terminal status, with the wedge rule of the CLI and the run timeout of
 * the campaign. On the timeout the runner cancels the run through the
 * harness canceler and records `timed_out`.
 */
async function observeRun(ctx: AttemptContext, runId: string): Promise<ObservedRun> {
    const { pool, runAuthorizer } = ctx.runtime;
    const events = createJsonlSink(join(ctx.attemptDir, "events.jsonl"));
    const controller = new AbortController();
    const stream = createRunEventStream({ pool, logger: ctx.logger }).subscribe({
        runId,
        onPart: (part) => {
            events.append({ at: new Date().toISOString(), part });
        },
        signal: controller.signal,
    });
    const started = Date.now();
    let observed: ObservedRun | undefined;
    try {
        while (observed === undefined) {
            const run = unwrap(await queryRun(pool, runId), "queryRun");
            if (run === null) {
                observed = { row: null, status: "vanished", error: "the run row disappeared from the ledger" };
                break;
            }
            if (run.status !== "running") {
                observed = { row: run, status: run.status, error: run.error };
                break;
            }
            const dbosStatus = await readParentWorkflowDbosStatus(pool, runId);
            if (dbosStatus !== null && DBOS_TERMINAL_STATUSES.has(dbosStatus)) {
                const settled = unwrap(await queryRun(pool, runId), "queryRun");
                if (settled !== null && settled.status !== "running") {
                    observed = { row: settled, status: settled.status, error: settled.error };
                    break;
                }
                observed = { row: settled, status: "wedged", error: `the workflow reached DBOS status ${dbosStatus} while the ledger still reads running` };
                break;
            }
            if (Date.now() - started > ctx.options.runTimeoutMs) {
                const canceler = createRunCanceler({ pool, runCharge: createNoopRunCharge(), runAuthorizer, logger: ctx.logger });
                let cancelNote = "";
                try {
                    const cancel = await canceler.cancel(runId, ctx.session);
                    cancelNote = ` (cancel: ${cancel.outcome}, final ${cancel.finalStatus})`;
                } catch (cause) {
                    cancelNote = ` (cancel failed: ${describeCause(cause)})`;
                }
                const after = unwrap(await queryRun(pool, runId), "queryRun");
                observed = { row: after, status: "timed_out", error: `the run did not end within ${ctx.options.runTimeoutMs / 60_000} min${cancelNote}` };
                break;
            }
            await Bun.sleep(POLL_MS);
        }
    } finally {
        // The parent stream drains when the parent is terminal; the children get a bounded grace.
        await Promise.race([stream, Bun.sleep(STREAM_DRAIN_MS)]);
        controller.abort();
        await stream;
    }
    return observed;
}

// ── Transcripts from the durable step cache ─────────────────────────

interface OperationRow {
    readonly workflow_uuid: string;
    readonly function_id: number;
    readonly function_name: string;
    readonly output: string | null;
    readonly error: string | null;
    readonly started_at_epoch_ms: string | null;
    readonly completed_at_epoch_ms: string | null;
}

interface TranscriptLine {
    readonly function_id: number;
    readonly function_name: string;
    readonly output: unknown;
    readonly error: unknown;
    readonly started_at_epoch_ms: number | null;
    readonly completed_at_epoch_ms: number | null;
}

/** A stored step value: plain JSON, or the branded superjson envelope of the engine, whose `json` is the plain value. */
function decodeStored(text: string | null): unknown {
    if (text === null) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed) && parsed.__dbos_serializer === "superjson" && "json" in parsed) return parsed.json;
        return parsed;
    } catch {
        return text;
    }
}

function epoch(value: string | null): number | null {
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** A tool result whose output is the error text of the loop. */
function isErrorResult(output: unknown): boolean {
    if (!isObject(output)) return false;
    const result = isObject(output.result) ? output.result : output;
    return isObject(result.output) && result.output.type === "error-text";
}

/** The reply step of a loop: `llm:<i>` in a sandbox step, `llm-<i>` under the default formatter of the loop. */
const LLM_STEP_NAME = /^llm[:-]\d+$/;

/** The two spellings of the step of one tool call: the sandbox-step formatter and the default formatter of the loop. */
function toolStepNames(name: string, toolUseId: string): [string, string] {
    return [`tool:${name}:${toolUseId}`, `tool-${name}-${toolUseId}`];
}

/**
 * The tool calls of one step from its transcript: the reply steps name each
 * call with its input, and the tool steps give the outcome and the time. A
 * call with no step of its own (an inline tool, or a call the loop never
 * dispatched) stays `incomplete`. A nested sub-step of a tool carries a
 * further suffix and matches no call.
 */
function foldToolCalls(lines: readonly TranscriptLine[]): ToolCallRecord[] {
    const calls = new Map<string, MutableToolCall>();
    const byStepName = new Map<string, MutableToolCall>();
    for (const line of lines) {
        if (!LLM_STEP_NAME.test(line.function_name)) continue;
        const message = isObject(line.output) && isObject(line.output.message) ? line.output.message : undefined;
        const content = message && Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            if (!isObject(part) || part.type !== "tool-call" || typeof part.toolCallId !== "string") continue;
            const entry: MutableToolCall = { toolUseId: part.toolCallId, name: String(part.toolName ?? ""), input: part.input, outcome: "incomplete" };
            calls.set(part.toolCallId, entry);
            for (const stepName of toolStepNames(entry.name, entry.toolUseId)) byStepName.set(stepName, entry);
        }
    }
    for (const line of lines) {
        const entry = byStepName.get(line.function_name);
        if (!entry) continue;
        entry.outcome = line.error !== null || isErrorResult(line.output) ? "error" : "ok";
        if (line.started_at_epoch_ms !== null && line.completed_at_epoch_ms !== null) entry.durationMs = line.completed_at_epoch_ms - line.started_at_epoch_ms;
    }
    return [...calls.values()];
}

interface StreamRow {
    readonly workflow_uuid: string;
    readonly value: string;
}

/**
 * The tool calls of every step from the durable event streams of the run:
 * each loop forwards its raw `tool-started` and `tool-finished` events under
 * the `data-loop-event` envelope, keyed by step id, and the parent does the
 * same for the synthesis loop. The harness stream reader drops that envelope
 * (it is outside the part registry), thus the runner reads the stream table
 * of the engine, the same class of read as the step cache. An inline tool
 * and a workflow-mode tool have no step of their own in the cache, and this
 * source is the only one that carries their outcome.
 */
async function loopToolCallsByStep(pool: Pool, runId: string): Promise<Record<string, ToolCallRecord[]>> {
    const rows = await pool.query<StreamRow>({
        text: `SELECT workflow_uuid, value FROM dbos.streams WHERE key = 'events' AND (workflow_uuid = $1 OR workflow_uuid LIKE $2) ORDER BY workflow_uuid, "offset"`,
        values: [runId, `${runId}-%`],
    });
    const byStep = new Map<string, MutableToolCall[]>();
    for (const row of rows.rows) {
        const part = decodeStored(row.value);
        if (!isObject(part) || part.type !== "data-loop-event" || !isObject(part.data)) continue;
        const stepId = typeof part.data.stepId === "string" ? part.data.stepId : undefined;
        const event = isObject(part.data.event) ? part.data.event : undefined;
        if (stepId === undefined || event === undefined || typeof event.toolUseId !== "string") continue;
        const calls = byStep.get(stepId) ?? [];
        byStep.set(stepId, calls);
        if (event.type === "tool-started") {
            calls.push({ toolUseId: event.toolUseId, name: String(event.name ?? ""), input: event.input, outcome: "incomplete" });
        } else if (event.type === "tool-finished") {
            // The loop emits every start of a round before any finish, thus the first
            // incomplete entry with this id is the call that finished.
            const entry = calls.find((call) => call.toolUseId === event.toolUseId && call.outcome === "incomplete");
            if (entry) {
                entry.outcome = (event.outcome as ToolCallOutcome | undefined) ?? "ok";
                if (typeof event.durationMs === "number") entry.durationMs = event.durationMs;
            }
        }
    }
    return Object.fromEntries([...byStep].map(([stepId, calls]) => [stepId, calls as ToolCallRecord[]]));
}

/**
 * Export the durable step outputs of the parent workflow and of every child
 * into transcript files, and fold the tool calls of each step: from the loop
 * events of the run, or from the step cache of a step whose loop events are
 * absent. The child workflow ids come from the step ledger; the
 * `<runId>-<idx>` pattern is the fallback for a child whose row never
 * recorded its id.
 */
async function exportTranscripts(ctx: AttemptContext, runId: string, steps: readonly StepExecutionRow[]): Promise<Record<string, ToolCallRecord[]>> {
    const rows = await ctx.runtime.pool.query<OperationRow>({
        text: `SELECT workflow_uuid, function_id, function_name, output, error, started_at_epoch_ms, completed_at_epoch_ms
               FROM dbos.operation_outputs
               WHERE workflow_uuid = $1 OR workflow_uuid LIKE $2
               ORDER BY workflow_uuid, function_id`,
        values: [runId, `${runId}-%`],
    });
    const stepByWorkflow = new Map<string, string>();
    for (const step of steps) if (step.childWorkflowId !== null) stepByWorkflow.set(step.childWorkflowId, step.stepId);
    const byWorkflow = new Map<string, TranscriptLine[]>();
    for (const row of rows.rows) {
        const list = byWorkflow.get(row.workflow_uuid) ?? [];
        list.push({
            function_id: row.function_id,
            function_name: row.function_name,
            output: decodeStored(row.output),
            error: decodeStored(row.error),
            started_at_epoch_ms: epoch(row.started_at_epoch_ms),
            completed_at_epoch_ms: epoch(row.completed_at_epoch_ms),
        });
        byWorkflow.set(row.workflow_uuid, list);
    }
    const toolCallsByStep = await loopToolCallsByStep(ctx.runtime.pool, runId);
    for (const [workflowId, lines] of byWorkflow) {
        const stepId = workflowId === runId ? undefined : (stepByWorkflow.get(workflowId) ?? workflowId);
        const path = stepId === undefined ? join(ctx.attemptDir, "transcript.jsonl") : join(ctx.attemptDir, "steps", stepId, "transcript.jsonl");
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
        if (stepId !== undefined && toolCallsByStep[stepId] === undefined) toolCallsByStep[stepId] = foldToolCalls(lines);
    }
    return toolCallsByStep;
}

// ── Stage: collect ──────────────────────────────────────────────────

interface CopiedFile {
    /** The workspace-relative source, the same key as `cortex_artifacts.path`. */
    readonly source: string;
    /** The attempt-relative copy. */
    readonly copy: string;
    readonly sha256: string;
    readonly size: number;
}

/**
 * Copy `runs/<runId>/` of the workspace into the attempt: a step directory
 * into `steps/<stepId>/files/`, `synthesis.json` to the root, and the rest
 * under `run/`. Each copy is hashed.
 */
async function copyRunFiles(ctx: AttemptContext, runId: string, stepIds: ReadonlySet<string>): Promise<CopiedFile[]> {
    const runRoot = join(ctx.workspaceRoot, "runs", runId);
    if (!(await isDirectory(runRoot))) return [];
    const copied: CopiedFile[] = [];
    for (const key of await walk(runRoot)) {
        const [head, ...rest] = key.split("/");
        let copy: string;
        if (head !== undefined && rest.length > 0 && stepIds.has(head)) copy = posix.join("steps", head, "files", ...rest);
        else if (key === "synthesis.json") copy = "synthesis.json";
        else copy = posix.join("run", key);
        const source = join(runRoot, key);
        const dest = join(ctx.attemptDir, copy);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(source, dest);
        const info = await stat(dest);
        copied.push({ source: posix.join("runs", runId, key), copy, sha256: await sha256File(dest), size: info.size });
    }
    return copied;
}

interface TableFacts {
    readonly copy: string;
    readonly header: string[];
    readonly rows: number;
}

async function tableFacts(attemptDir: string, copy: string): Promise<TableFacts | undefined> {
    let text: string;
    try {
        text = await readFile(join(attemptDir, copy), "utf8");
    } catch {
        return undefined;
    }
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return undefined;
    const separator = /\.tsv$/i.test(copy) ? "\t" : ",";
    const header = lines[0]!.split(separator).map((cell) => cell.replace(/^"|"$/g, "").trim());
    return { copy, header, rows: lines.length - 1 };
}

function isDeTable(facts: TableFacts): boolean {
    return DE_TABLE_COLUMNS.every((name) => facts.header.includes(name));
}

function isEnrichmentTable(facts: TableFacts): boolean {
    const lower = facts.header.map((name) => name.toLowerCase());
    return lower.some((name) => ENRICHMENT_SET_COLUMNS.has(name)) && lower.some((name) => ENRICHMENT_PADJ_COLUMNS.has(name));
}

/** The largest table of a kind: the complete result holds every tested gene or set, a filtered copy holds fewer rows. */
function largest(tables: readonly TableFacts[]): string | null {
    let best: TableFacts | undefined;
    for (const table of tables) if (best === undefined || table.rows > best.rows) best = table;
    return best?.copy ?? null;
}

/**
 * Locate the outputs among the copied files: the DE table by its column
 * signature, the enrichment table by a set column and an adjusted-p column,
 * the figures by extension, the synthesis by name, and the summary of the
 * report step of the plan. Paths are relative to the attempt directory.
 */
async function locateOutputs(ctx: AttemptContext, copied: readonly CopiedFile[], plan: AnalysisPlan | undefined, steps: readonly StepExecutionRow[]): Promise<FullRunRecord["outputs"]> {
    const tables: TableFacts[] = [];
    for (const file of copied) {
        if (!TABLE_EXTENSIONS.test(file.copy)) continue;
        const facts = await tableFacts(ctx.attemptDir, file.copy);
        if (facts) tables.push(facts);
    }
    const deTables = tables.filter(isDeTable);
    const enrichmentTables = tables.filter((table) => !isDeTable(table) && isEnrichmentTable(table));
    const reportStepId = plan?.steps.find((step) => step.step_type === "report")?.id ?? [...steps].sort((a, b) => b.wave - a.wave)[0]?.stepId;
    const summary = reportStepId === undefined ? undefined : posix.join("steps", reportStepId, "files", "output", "summary.md");
    return {
        de_table: largest(deTables),
        enrichment_table: largest(enrichmentTables),
        figures: copied.filter((file) => FIGURE_EXTENSIONS.test(file.copy)).map((file) => file.copy),
        synthesis: copied.some((file) => file.copy === "synthesis.json") ? "synthesis.json" : null,
        report_step_summary: summary !== undefined && (await isFile(join(ctx.attemptDir, summary))) ? summary : null,
    };
}

interface ArtifactRow {
    readonly path: string;
    readonly hash: string;
    readonly size: string | number;
    readonly role: string;
    readonly source_step: string | null;
}

/** The steps, the artifacts, the copied files, the transcripts, and the located outputs of the run. */
async function collectStage(ctx: AttemptContext, runId: string, plan: AnalysisPlan | undefined): Promise<void> {
    const { pool } = ctx.runtime;
    const steps = unwrap(await queryStepsByRun(pool, runId), "queryStepsByRun");
    ctx.draft.run.steps = steps.map((step) => ({
        stepId: step.stepId,
        agent: step.agentId,
        status: step.status,
        durationMs: step.durationMs,
        finishReason: step.finishReason,
        hitMaxSteps: step.hitMaxSteps,
        error: step.error,
        blockedReason: step.blockedReason,
    }));
    for (const step of steps) {
        if (step.status === "failed" || step.status === "blocked" || step.status === "canceled") {
            ctx.draft.failures.push({ stage: `step:${step.stepId}`, message: step.blockedReason ?? step.error ?? step.status });
        }
    }
    const copied = await copyRunFiles(ctx, runId, new Set(steps.map((step) => step.stepId)));
    await writeJson(join(ctx.attemptDir, "files.json"), copied);
    const copyBySource = new Map(copied.map((file) => [file.source, file]));
    const artifacts = await pool.query<ArtifactRow>({
        text: "SELECT path, hash, size, role, source_step FROM cortex_artifacts WHERE analysis_id = $1 AND source_run = $2 ORDER BY path",
        values: [ctx.analysisId, runId],
    });
    ctx.draft.run.artifacts = artifacts.rows.map((row) => {
        const copy = copyBySource.get(row.path);
        return { path: row.path, hash: row.hash, size: Number(row.size), role: row.role, source_step: row.source_step, copy: copy?.copy ?? null, copy_sha256: copy?.sha256 ?? null };
    });
    ctx.draft.toolCallsByStep = await exportTranscripts(ctx, runId, steps);
    ctx.draft.outputs = await locateOutputs(ctx, copied, plan, steps);
}

// ── The identity of the environment ─────────────────────────────────

interface EnvironmentIdentity {
    readonly image_digest: string | null;
    readonly farm_lock_sha256: string | null;
    readonly refs_receipt: unknown;
    readonly harness_commit: string;
}

async function imageDigest(image: string): Promise<string | null> {
    try {
        const repo = (await $`docker image inspect --format ${"{{index .RepoDigests 0}}"} ${image}`.quiet().nothrow().text()).trim();
        if (repo.length > 0 && !repo.startsWith("Error")) return repo;
        const id = (await $`docker image inspect --format ${"{{.Id}}"} ${image}`.quiet().nothrow().text()).trim();
        return id.length > 0 && !id.startsWith("Error") ? id : null;
    } catch {
        return null;
    }
}

/** The receipts of the reference store, one per dataset, as the installer left them under `.inflexa/receipts`. */
async function refsReceipt(refsDir: string): Promise<unknown> {
    const dir = join(refsDir, ".inflexa", "receipts");
    if (!(await isDirectory(dir))) return null;
    const receipts: { datasetId: string; datasetVersion: string; activatedAt: string }[] = [];
    for (const name of (await readdir(dir)).sort()) {
        if (!name.endsWith(".json")) continue;
        try {
            const receipt = parseReferenceInstallReceipt(JSON.parse(await readFile(join(dir, name), "utf8")));
            if (receipt) receipts.push({ datasetId: receipt.datasetId, datasetVersion: receipt.datasetVersion, activatedAt: receipt.activatedAt });
        } catch {
            // A receipt that does not parse is not part of the identity.
        }
    }
    return { receipts };
}

async function environmentIdentity(options: RunFullOptions, farmLockFile: string): Promise<EnvironmentIdentity> {
    return {
        image_digest: await imageDigest(options.sandbox.image),
        farm_lock_sha256: (await isFile(farmLockFile)) ? await sha256File(farmLockFile) : null,
        refs_receipt: await refsReceipt(options.sandbox.refsDir),
        harness_commit: await gitIdentity("harness"),
    };
}

// ── One attempt ─────────────────────────────────────────────────────

function emptyDraft(): Draft {
    return {
        profile: { status: "not_run", durationMs: 0, result: null },
        plan: { planId: null, outcome: "not_run", clarifications: [], plan: null },
        run: { runId: null, status: "not_run", error: null, synthesis_status: "unknown", steps: [], artifacts: [], environment_missing: [] },
        toolCalls: [],
        toolCallsByStep: {},
        outputs: { de_table: null, enrichment_table: null, figures: [], synthesis: null, report_step_summary: null },
        failures: [],
        timings: {},
    };
}

async function runAttempt(args: {
    readonly options: RunFullOptions;
    readonly runtime: EvalRuntime;
    readonly resourcePolicy: ResourcePolicy;
    readonly logger: Logger;
    readonly knowledgeSink: AttemptKnowledgeSink;
    readonly identity: EnvironmentIdentity;
    readonly farmLockFile: string;
    readonly task: Task;
    readonly run: number;
    readonly attemptDir: string;
    readonly campaignDir: string;
    readonly arm: string;
}): Promise<FullRunRecord> {
    const { options, runtime, task, run, attemptDir } = args;
    const { seed } = options;
    const analysisId = `eval-${options.campaign}-${options.condition}-${task.id}-s${seed}-${run}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const workspaceRoot = join(attemptDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    runtime.setAttemptDir(attemptDir);
    const knowledgeCalls = args.knowledgeSink.reset();
    const session: AgentSession = {
        identity: { user: "eval" },
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: "conversation-agent", callPath: ["conversation-agent"] },
        auth: makeLocalAuth(),
    };
    const ctx: AttemptContext = {
        options,
        runtime,
        resourcePolicy: args.resourcePolicy,
        logger: args.logger,
        task,
        run,
        analysisId,
        attemptDir,
        campaignDir: args.campaignDir,
        workspaceRoot,
        session,
        farmLockFile: args.farmLockFile,
        draft: emptyDraft(),
    };
    const { draft } = ctx;
    const startedAt = new Date();
    let outcome = "loop_error";
    let plan: AnalysisPlan | undefined;
    let runId: string | undefined;
    try {
        const staged = await timed(ctx, "stage", () => stageStage(ctx));
        await timed(ctx, "profile", () => profileStage(ctx, staged));
        const planned = await timed(ctx, "plan", () => planStage(ctx));
        plan = planned.plan;
        runId = await timed(ctx, "execute", () => executeStage(ctx, planned.planId, planned.plan));
        const observed = await timed(ctx, "observe", () => observeRun(ctx, runId!));
        draft.run.status = observed.status;
        draft.run.error = observed.error;
        draft.run.synthesis_status = observed.row?.synthesisStatus ?? "unknown";
        outcome = observed.status;
    } catch (caught) {
        if (caught instanceof AttemptStop) {
            outcome = caught.outcome;
            draft.error = caught.message;
        } else {
            outcome = "loop_error";
            draft.error = caught instanceof Error ? caught.message : String(caught);
            if (draft.failures.length === 0) draft.failures.push({ stage: "attempt", message: draft.error });
        }
    }
    if (runId !== undefined) {
        try {
            await timed(ctx, "collect", () => collectStage(ctx, runId!, plan));
        } catch (caught) {
            draft.error = draft.error ?? (caught instanceof Error ? caught.message : String(caught));
        }
    }
    const elapsedMs = Date.now() - startedAt.getTime();
    draft.timings.total = elapsedMs;
    const usage = foldUsage(readUsageFile(join(attemptDir, "usage.jsonl")));
    const connection = options.connections.planner;
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
        seed,
        split: splitOf(options.manifest, task.id, seed),
        startedAt: startedAt.toISOString(),
        elapsedMs,
        outcome,
        ...(draft.question ? { question: draft.question } : {}),
        ...(draft.error ? { error: draft.error } : {}),
        toolCalls: draft.toolCalls as ToolCallRecord[],
        knowledgeCalls,
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
        connection: recordedConnection,
        ...(options.manifestRef ? { manifest: options.manifestRef } : {}),
        ...(options.exploratory ? { exploratory: true as const } : {}),
        identity: {
            campaign: options.campaign,
            arm: args.arm,
            task: task.id,
            run,
            seed,
            models_by_role: { ...runtime.models },
            snapshot_digest: options.snapshot?.digest ?? null,
            ...args.identity,
        },
        profile: draft.profile,
        plan: draft.plan,
        run: draft.run,
        usage: { byRole: usage.byRole, byStep: usage.byStep, total: usage.total },
        toolCallsByStep: draft.toolCallsByStep,
        knowledgeTemplateCalls: knowledgeCalls.filter((call) => call.op === "render"),
        failures: draft.failures,
        timings: draft.timings,
        outputs: draft.outputs,
        transcript_source: TRANSCRIPT_SOURCE,
    };
}

// ── The command ─────────────────────────────────────────────────────

function connectionFrom(model: string): ModelConnection {
    return {
        provider: (argument("--provider") ?? "cliproxy") as ModelConnection["provider"],
        model,
        ...(argument("--base-url") ? { baseUrl: argument("--base-url") } : {}),
        ...(argument("--api-key-env") ? { apiKeyEnv: argument("--api-key-env") } : {}),
        ...(argument("--provider-name") ? { name: argument("--provider-name") } : {}),
        ...(argument("--provider-order") ? { providerOrder: argument("--provider-order")?.split(",") } : {}),
        ...(argument("--request-timeout-ms") ? { requestTimeoutMs: Number(argument("--request-timeout-ms")) } : {}),
    };
}

async function fileDigest(path: string): Promise<string> {
    return `sha256:${await sha256File(path)}`;
}

async function main(): Promise<number> {
    const campaign = argument("--campaign");
    if (!campaign) {
        console.error("--campaign is required");
        return 1;
    }
    const campaignSlug = campaign.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    const condition = (argument("--condition") ?? "with") as Condition;
    if (condition !== "with" && condition !== "without") {
        console.error(`--condition holds ${condition}, not with or without`);
        return 1;
    }
    const runs = Number(argument("--runs") ?? "1");
    const seed = Number(argument("--seed") ?? "1");
    if (!Number.isInteger(seed) || seed < 1) {
        console.error(`--seed holds ${argument("--seed")}, not a positive integer`);
        return 1;
    }
    const model = argument("--model") ?? "claude-sonnet-5";
    const connections = {
        planner: connectionFrom(model),
        sandbox: connectionFrom(argument("--sandbox-model") ?? model),
        utility: connectionFrom(argument("--utility-model") ?? model),
    };
    const only = argument("--tasks")?.split(",");
    const pgUrl = argument("--pg-url") ?? Bun.env.INFLEXA_EVAL_PG_URL ?? `postgres://inflexa:inflexa@127.0.0.1:8432/eval_${campaignSlug}`;
    const out = argument("--out") ?? join(EVAL_ROOT, "results");
    const dataDir = join(homedir(), ".local", "share", "inflexa");
    const storeDir = argument("--store-dir") ?? join(dataDir, "package-store");
    const refsDir = argument("--refs-dir") ?? join(dataDir, "refs");
    const farmLockFile = join(storeDir, "farms", "catalog", "inflexa.lock");
    for (const [name, path, kind] of [
        ["store", farmLockFile, "file"],
        ["refs", refsDir, "directory"],
    ] as const) {
        const present = kind === "file" ? await isFile(path) : await isDirectory(path);
        if (!present) {
            console.error(`the ${name} ${path} does not exist; pass --store-dir / --refs-dir`);
            return 1;
        }
    }
    const embeddingUrl = argument("--embedding");
    if (!embeddingUrl) {
        console.error("--embedding <base url> is required: an OpenAI-shaped embeddings endpoint, for example a local llama-server");
        return 1;
    }
    const embedding = {
        baseUrl: embeddingUrl,
        apiKey: Bun.env[argument("--embedding-key-env") ?? "INFLEXA_EVAL_EMBEDDING_KEY"] ?? "none",
        ...(argument("--embedding-model") ? { model: argument("--embedding-model") } : {}),
        ...(argument("--embedding-dimensions") ? { dimensions: Number(argument("--embedding-dimensions")) } : {}),
    };
    const runTimeoutMs = Number(argument("--run-timeout-min") ?? String(DEFAULT_RUN_TIMEOUT_MIN)) * 60_000;
    const serviceUrl = argument("--service-url") ?? DEFAULT_SERVICE_URL;
    const serviceKey = Bun.env[argument("--service-key-env") ?? "INFLEXA_KNOWLEDGE_SERVICE_KEY"] ?? "";
    const exploratory = process.argv.includes("--exploratory");
    const manifestPath = argument("--manifest") ?? join(out, campaign, "manifest.json");
    const engineBindOwnership = argument("--engine-bind-ownership");

    let knowledge: KnowledgeClient | undefined;
    let snapshot: { date: string; digest: string } | undefined;
    if (condition === "with") {
        const health = await fetch(`${serviceUrl}/v1/snapshot`).catch(() => undefined);
        if (!health?.ok) {
            console.error(`the knowledge service at ${serviceUrl} does not answer; start it with \`bun run serve\``);
            return 1;
        }
        const meta = (await health.json()) as { date: string; digest: string };
        snapshot = { date: meta.date, digest: meta.digest };
        knowledge = createHttpKnowledgeClient({ baseUrl: serviceUrl, apiKey: serviceKey });
        console.log(`knowledge service ${serviceUrl} snapshot ${meta.date} ${meta.digest}`);
    }

    const tasks = (await loadTasks()).filter((task) => !only || only.includes(task.id));
    if (tasks.length === 0) {
        console.error(`no task matches --tasks ${only?.join(",") ?? "(all)"}`);
        return 1;
    }
    for (const task of tasks) {
        const dir = datasetDir(task, seed);
        if (!(await isDirectory(dir))) {
            console.error(`the dataset ${dir} of task ${task.id} does not exist; simulate seed ${seed} first with eval:simulate`);
            return 1;
        }
    }

    // The manifest gate applies when the campaign is frozen. A campaign with no
    // manifest runs as it is, and its records carry no manifest.
    const manifest = (await isFile(manifestPath)) ? await readManifest(manifestPath) : undefined;
    const manifestRef = manifest ? { path: manifestPath, digest: await fileDigest(manifestPath) } : undefined;
    let insideManifest = true;
    if (manifest) {
        const differences = laneDifferences(manifest, {
            condition,
            connection: connections.planner,
            seed,
            ...(snapshot ? { snapshotDigest: snapshot.digest } : {}),
            taskIds: tasks.map((task) => task.id),
            tasksDigest: await tasksDigest(TASKS_PATH),
        });
        if (differences.length > 0) {
            if (!exploratory) {
                console.error(`${differences.join("; ")}. Pass --exploratory to run outside the manifest ${manifestPath}.`);
                return 1;
            }
            console.warn(`exploratory lane: ${differences.join("; ")}`);
            insideManifest = false;
        }
    }

    const options: RunFullOptions = {
        campaign,
        condition,
        connections,
        tasks,
        runs,
        seed,
        pgUrl,
        out,
        sandbox: {
            image: argument("--image") ?? DEFAULT_IMAGE,
            storeDir,
            refsDir,
            ...(argument("--engine-socket") ? { engineSocketPath: argument("--engine-socket") } : {}),
            ...(engineBindOwnership === "host-preserved" ? { engineBindOwnership: "host-preserved" as const } : {}),
        },
        embedding,
        runTimeoutMs,
        ...(argument("--skills-dir") ? { skillsDir: argument("--skills-dir") } : {}),
        ...(knowledge ? { knowledge } : {}),
        ...(snapshot ? { snapshot } : {}),
        ...(manifest ? { manifest } : {}),
        ...(manifestRef ? { manifestRef } : {}),
        exploratory: !insideManifest,
    };

    const modelSlug = model.replace(/[^a-z0-9.-]/gi, "_");
    const arm = `${condition}--${modelSlug}`;
    const campaignDir = join(out, campaign);
    const armDir = join(campaignDir, arm);
    await mkdir(armDir, { recursive: true });
    const attempts: { task: Task; run: number; dir: string }[] = [];
    for (const task of tasks) {
        for (let run = 1; run <= runs; run += 1) {
            const dir = join(armDir, `${task.id}.seed-${seed}.run-${run}`);
            if (await isFile(join(dir, "record.json"))) {
                console.log(`skip ${task.id} seed ${seed} run ${run} (record.json exists)`);
                continue;
            }
            attempts.push({ task, run, dir });
        }
    }
    if (attempts.length === 0) {
        console.log("nothing to run");
        return 0;
    }
    console.log(`campaign ${campaign} condition ${condition} model ${model} seed ${seed}: ${attempts.length} attempt(s), one at a time -> ${armDir}`);

    const knowledgeSink = createAttemptKnowledgeSink();
    const resourcePolicy = defaultResourcePolicy();
    const logger = createConsoleLogger();
    const identity = await environmentIdentity(options, farmLockFile);
    console.log(`image ${identity.image_digest ?? "(unknown)"}, farm lock sha256:${identity.farm_lock_sha256 ?? "(none)"}, harness ${identity.harness_commit}`);
    const runtime = await composeEvalRuntime({
        campaign,
        condition,
        campaignDir,
        attemptDir: attempts[0]!.dir,
        pgUrl,
        connections,
        embedding,
        sandbox: options.sandbox,
        ...(knowledge ? { knowledge: recordingKnowledgeClient(knowledge, knowledgeSink) } : {}),
        resourcePolicy,
        ...(options.skillsDir ? { skillsDir: options.skillsDir } : {}),
        logger,
    });
    let stopping = false;
    const stop = async (signal: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        console.error(`\n${signal}: the runtime shuts down; a run in flight resumes on the next boot of this campaign`);
        await runtime.shutdown(signal).catch(() => {});
        process.exit(130);
    };
    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));

    let failed = 0;
    try {
        for (const attempt of attempts) {
            process.stdout.write(`${attempt.task.id} seed ${seed} run ${attempt.run} ... `);
            const record = await runAttempt({
                options,
                runtime,
                resourcePolicy,
                logger,
                knowledgeSink,
                identity,
                farmLockFile,
                task: attempt.task,
                run: attempt.run,
                attemptDir: attempt.dir,
                campaignDir,
                arm,
            });
            await writeJson(join(attempt.dir, "record.json"), record);
            if (record.outcome !== "completed") failed += 1;
            const roles = Object.keys(record.usage.byRole).join(",");
            console.log(
                `${record.outcome} in ${(record.elapsedMs / 1000).toFixed(0)}s: profile ${record.profile.status}, plan ${record.plan.outcome}, run ${record.run.status} (synthesis ${record.run.synthesis_status}), ${record.run.steps.length} step(s), de ${record.outputs.de_table ?? "-"}, enrichment ${record.outputs.enrichment_table ?? "-"}, ${record.outputs.figures.length} figure(s), roles ${roles || "-"}`,
            );
        }
    } finally {
        await runtime.shutdown("eval-done").catch((cause: unknown) => console.error(`shutdown: ${describeCause(cause)}`));
    }
    return failed === 0 ? 0 : 2;
}

if (import.meta.main) {
    const code = await main();
    // The runtime's live handles keep the loop busy after the shutdown; exit as the CLI does.
    process.exit(code);
}
