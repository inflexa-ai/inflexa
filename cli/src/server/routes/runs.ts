import { existsSync } from "node:fs";
import { join } from "node:path";

import { Hono, type Context } from "hono";
import { err, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import PQueue from "p-queue";
import {
    createLocalRunAuthorizer,
    createNoopRunCharge,
    createRunCanceler,
    createRunEventStream,
    FARM_LOCK_FILE,
    loadDataProfileStatus,
    loadPlan,
    makeLocalAuth,
    queryActiveRunsByAnalysis,
    queryRun,
    queryRunsByAnalysis,
    queryStepsByRun,
    UnknownRunError,
    type AgentSession,
    type CortexRunRow,
    type DataProfileStatus,
    type DbError,
    type Pool,
    type RunCanceler,
    type RunEventSubscribeOptions,
    type StepExecutionRow,
} from "@inflexa-ai/harness";
import { CONVERSATION_AGENT_ID } from "@inflexa-ai/harness/agents/conversation-agent.js";
import { queryRunsByThread, queryRunsForInspection } from "@inflexa-ai/harness/state/runs.js";

import type { PageQuery } from "../../api/common.ts";
import type {
    CancelRunResult,
    ChatContext,
    DataProfileView,
    FarmHealOutcome,
    FarmHealResult,
    ProfileOutcome,
    ProfileRerunResult,
    RunDetail,
    RunStepSummary,
    RunSummary,
    SandboxImageReadiness,
    SandboxReadiness,
} from "../../api/runs.ts";
import type { UsageTotals } from "../../api/usage.ts";
// The SQLite error of the cli, aliased: `DbError` above is the Postgres error of the harness ledger.
import type { DbError as LocalDbError } from "../../db/errors.ts";
import {
    findAnalysesByRef,
    getAnalysisDataProfileUsageTotals,
    getRunUsageTotals,
    listAnalysisInputs,
    listAnalysisUsageByRun,
    listRunUsageByStep,
} from "../../db/primary_query.ts";
import { ensureRuntime } from "../../lib/config.ts";
import { capture } from "../../lib/container.ts";
import { describeCause } from "../../lib/cause.ts";
import { env } from "../../lib/env.ts";
import { noteDataProfileState } from "../../modules/harness/agent_switch.ts";
import { ensureProfileAtParity, forceReprofile, type ProfileParityOutcome } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { isPublishedSandboxImage } from "../../modules/libs/images.ts";
import {
    analysisFarmPath,
    catalogFarmPath,
    composeFullFarm,
    describeFarmCompositionError,
    takeFarmCompositionFailure,
} from "../../modules/libs/composition.ts";
import { configuredSandboxImage } from "../../modules/libs/pull.ts";
import { inspectStoreContent } from "../../modules/libs/store_download.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ServerBoot } from "../boot.ts";
import { apiError, holdConnection, internalError, listEnvelope, parsePage, requireRuntime, sseResponse, type ServerEnv } from "../http.ts";
import { serializeProfileWork } from "../profile_queue.ts";

/**
 * How many plans one runs page loads at the same time. A page holds up to 200 runs, and each distinct plan is
 * one Postgres read, thus the width bounds the pool connections that one request takes.
 */
const PLAN_LOAD_CONCURRENCY = 4;

/** The harness reads and the machine probes that the routes call. Tests replace each one, because each needs Postgres, DBOS, or the container engine. */
export type RunRoutesOpts = {
    /** One page of the runs of an analysis, newest first, and the count of all its runs. */
    readonly listRuns: (
        pool: Pool,
        analysisId: string,
        page: { limit: number; offset: number },
    ) => ResultAsync<{ rows: CortexRunRow[]; total: number }, DbError>;
    /** One page of the runs that the turns of one thread launched, newest first. */
    readonly listThreadRuns: (
        pool: Pool,
        analysisId: string,
        threadId: string,
        page: { limit: number; offset: number },
    ) => ResultAsync<CortexRunRow[], DbError>;
    /** Each run of the analysis that is not terminal. The set is bounded by the live concurrency, not by the history. */
    readonly listActiveRuns: (pool: Pool, analysisId: string) => ResultAsync<CortexRunRow[], DbError>;
    readonly getRun: (pool: Pool, runId: string) => ResultAsync<CortexRunRow | null, DbError>;
    readonly listSteps: (pool: Pool, runId: string) => ResultAsync<StepExecutionRow[], DbError>;
    /** The stored plan document, or `null` when it is gone. */
    readonly loadPlan: (pool: Pool, planId: string, analysisId: string) => ResultAsync<unknown, DbError>;
    readonly loadProfile: (pool: Pool, analysisId: string) => ResultAsync<DataProfileStatus | null, DbError>;
    /** Deliver each part of the run, and of its children, until the run is terminal or the signal aborts. */
    readonly subscribeRun: (pool: Pool, options: RunEventSubscribeOptions) => Promise<void>;
    /** Cancel the run and its children, and converge the ledgers. Rejects with {@link UnknownRunError} for an unknown run. */
    readonly cancelRun: (pool: Pool, runId: string, session: AgentSession) => Promise<CancelRunResult>;
    /** The parity drive of a chat open. */
    readonly ensureParity: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** The deliberate re-profile. */
    readonly forceReprofile: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** The image, the store, and the farm verdict for a sandbox of the analysis. */
    readonly readiness: (analysisId: string) => Promise<Omit<SandboxReadiness, "inputCount">>;
    /** Compose the farm of the analysis from the catalog closure, when the farm is missing. */
    readonly healFarm: (analysisId: string) => Promise<FarmHealOutcome>;
};

/** One canceler for each pool: a canceler makes its engine client at the first cancel, and the client registers handlers on the pool. */
const cancelers = new WeakMap<Pool, RunCanceler>();

/** The production {@link RunRoutesOpts}. */
export const DEFAULT_RUN_ROUTES_OPTS: RunRoutesOpts = {
    listRuns: (pool, analysisId, page) =>
        // The harness has no count of the runs in the newest-first order. The inspection read with no rows is
        // its count of all the runs of the analysis.
        ResultAsync.combine([queryRunsByAnalysis(pool, analysisId, page), queryRunsForInspection(pool, analysisId, { limit: 0 })]).map(([rows, counted]) => ({
            rows,
            total: counted.total,
        })),
    listThreadRuns: queryRunsByThread,
    listActiveRuns: queryActiveRunsByAnalysis,
    getRun: queryRun,
    listSteps: queryStepsByRun,
    loadPlan: (pool, planId, analysisId) => loadPlan(pool, planId, { analysisId }),
    loadProfile: loadDataProfileStatus,
    subscribeRun: (pool, options) => createRunEventStream({ pool }).subscribe(options),
    cancelRun: (pool, runId, session) => {
        const canceler = cancelers.get(pool) ?? createRunCanceler({ pool, runCharge: createNoopRunCharge(), runAuthorizer: createLocalRunAuthorizer() });
        cancelers.set(pool, canceler);
        return canceler.cancel(runId, session);
    },
    ensureParity: ensureProfileAtParity,
    forceReprofile,
    readiness: readSandboxReadiness,
    healFarm: healAnalysisFarm,
};

/**
 * The routes of draft 2.4 under `/api/v1/analyses/:analysisId`: the runs, the run stream and the cancel, the
 * data profile, the sandbox readiness, and the farm heal. Each run route gives 404 `not_found` for a run of a
 * different analysis. The sandbox readiness and the farm heal need no runtime.
 */
export function runRoutes(boot: ServerBoot, opts: RunRoutesOpts = DEFAULT_RUN_ROUTES_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    const runtimeGate = requireRuntime(boot);

    routes.get("/runs", runtimeGate, async (c) => {
        const analysisId = analysisParam(c);
        const pool = c.get("runtime").pool;
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const listed = await listRunPage(pool, analysisId, { active: c.req.query("active") === "true", threadId: c.req.query("threadId") }, page, opts);
        if (listed.isErr()) return internalError(c, listed.error, "list the runs");

        const runs = await summarizeRuns(pool, analysisId, listed.value.rows, opts);
        return c.json(listEnvelope("runs", runs, listed.value.total, page));
    });

    routes.get("/run/:runId", runtimeGate, async (c) => {
        const analysisId = analysisParam(c);
        const runId = c.req.param("runId");
        const pool = c.get("runtime").pool;
        const row = await opts.getRun(pool, runId);
        if (row.isErr()) return internalError(c, row.error, "read the run");
        if (row.value === null || row.value.analysisId !== analysisId) return runNotFound(c, runId);
        const run = row.value;

        const stepsRead = opts.listSteps(pool, runId);
        // A plan that cannot be read costs the title and the step names, never the run.
        const planDoc = run.planId === null ? null : (await opts.loadPlan(pool, run.planId, analysisId)).unwrapOr(null);
        const steps = await stepsRead;
        if (steps.isErr()) return internalError(c, steps.error, "read the steps of the run");
        const stepNames = planStepNames(planDoc);

        const stepUsage = listRunUsageByStep(analysisId, runId).unwrapOr([]);
        const usageByStep = new Map(stepUsage.flatMap((group) => (group.stepId === null ? [] : [[group.stepId, group.totals] as const])));
        const runUsage = getRunUsageTotals(analysisId, runId).unwrapOr(null);

        const detail: RunDetail = {
            ...toRunSummary(run, planTitleOf(planDoc), runUsage),
            steps: steps.value.map((step) => toStepSummary(step, stepNames.get(step.stepId), usageByStep.get(step.stepId))),
            // SQLite groups the NULL step ids as one group: the calls of the run outside each step.
            unattributedUsage: stepUsage.find((group) => group.stepId === null)?.totals ?? null,
        };
        return c.json(detail);
    });

    routes.get("/run/:runId/stream", runtimeGate, async (c) => {
        const analysisId = analysisParam(c);
        const runId = c.req.param("runId");
        const pool = c.get("runtime").pool;
        const owned = await streamBelongsTo(pool, analysisId, runId, opts);
        if (owned.isErr()) return internalError(c, owned.error, "read the run");
        if (!owned.value) return runNotFound(c, runId);
        return sseResponse((writer) =>
            opts.subscribeRun(pool, {
                runId,
                onPart: (part) => writer.send(part),
                signal: writer.signal,
            }),
        );
    });

    routes.post("/run/:runId/cancel", runtimeGate, async (c) => {
        const analysisId = analysisParam(c);
        const runId = c.req.param("runId");
        const pool = c.get("runtime").pool;
        const row = await opts.getRun(pool, runId);
        if (row.isErr()) return internalError(c, row.error, "read the run");
        if (row.value === null || row.value.analysisId !== analysisId) return runNotFound(c, runId);

        // The Cortex cancel session: the local identity, the scope of the analysis, and the `run-cancel`
        // provenance. The noop run charge and the local run authorizer close and revoke nothing.
        const session: AgentSession = {
            identity: { user: "local" },
            scope: { kind: "analysis", analysisId },
            provenance: { agentId: "run-cancel", callPath: ["run-cancel"] },
            auth: makeLocalAuth(),
        };
        // `cancel` rejects: on an unknown run, and when the engine cancel fails, which is safe to retry.
        const canceled = await ResultAsync.fromPromise(opts.cancelRun(pool, runId, session), (cause) => cause);
        return canceled.match(
            (result) => c.json(result),
            (cause) => (cause instanceof UnknownRunError ? runNotFound(c, runId) : internalError(c, cause, "cancel the run")),
        );
    });

    routes.get("/chat-context", runtimeGate, async (c) => {
        holdConnection(c);
        const analysisId = analysisParam(c);
        const runtime = c.get("runtime");
        const analysis = loadAnalysis(analysisId);
        if (analysis.isErr()) return internalError(c, analysis.error, "read the analysis");
        if (analysis.value === null) return analysisNotFound(c, analysisId);
        const target = analysis.value;

        const parity = await queuedDrive(analysisId, () => opts.ensureParity(runtime, target));
        if (parity.isErr()) return internalError(c, parity.error, "drive the profile parity");
        const view = await loadProfileView(runtime.pool, analysisId, opts);
        if (view.isErr()) return internalError(c, view.error, "read the data profile");
        const body: ChatContext = { analysisId, agentId: CONVERSATION_AGENT_ID, dataProfile: view.value, parity: parity.value };
        return c.json(body);
    });

    routes.get("/data-profile", runtimeGate, async (c) => {
        const view = await loadProfileView(c.get("runtime").pool, analysisParam(c), opts);
        return view.match(
            (body) => c.json(body),
            (e) => internalError(c, e, "read the data profile"),
        );
    });

    routes.post("/data-profile/rerun", runtimeGate, async (c) => {
        holdConnection(c);
        const analysisId = analysisParam(c);
        const runtime = c.get("runtime");
        const analysis = loadAnalysis(analysisId);
        if (analysis.isErr()) return internalError(c, analysis.error, "read the analysis");
        if (analysis.value === null) return analysisNotFound(c, analysisId);
        const target = analysis.value;

        const outcome = await queuedDrive(analysisId, () => opts.forceReprofile(runtime, target));
        if (outcome.isErr()) return internalError(c, outcome.error, "re-profile the analysis");
        const body: ProfileRerunResult = { outcome: outcome.value };
        return c.json(body, 202);
    });

    routes.get("/sandbox-readiness", async (c) => {
        holdConnection(c);
        const analysisId = analysisParam(c);
        const inputs = listAnalysisInputs(analysisId);
        if (inputs.isErr()) return internalError(c, inputs.error, "read the inputs of the analysis");
        const body: SandboxReadiness = { ...(await opts.readiness(analysisId)), inputCount: inputs.value.length };
        return c.json(body);
    });

    routes.post("/farm/heal", async (c) => {
        holdConnection(c);
        const body: FarmHealResult = { outcome: await opts.healFarm(analysisParam(c)) };
        return c.json(body, 202);
    });

    return routes;
}

/** The `analysisId` of the mount path. A route outside that mount reads an empty id, which matches no row. */
function analysisParam(c: Context<ServerEnv>): string {
    return c.req.param("analysisId") ?? "";
}

function runNotFound(c: Context<ServerEnv>, runId: string): Response {
    return apiError(c, "not_found", `This analysis has no run ${runId}.`);
}

function analysisNotFound(c: Context<ServerEnv>, analysisId: string): Response {
    return apiError(c, "not_found", `No analysis ${analysisId}.`);
}

/** The analysis row, or `null` when it is gone. */
function loadAnalysis(analysisId: string): Result<Analysis | null, LocalDbError> {
    return findAnalysesByRef(analysisId).map((candidates) => candidates.find((candidate) => candidate.id === analysisId) ?? null);
}

/** Run one profile drive behind the profile work of the analysis, and give its outcome. A drive that throws is the error. */
async function queuedDrive(analysisId: string, drive: () => Promise<ProfileParityOutcome>): Promise<Result<ProfileOutcome, unknown>> {
    const holder: { outcome?: ProfileParityOutcome } = {};
    const ran = await ResultAsync.fromPromise(
        serializeProfileWork(analysisId, async () => {
            holder.outcome = await drive();
        }),
        (cause) => cause,
    );
    if (ran.isErr()) return err(ran.error);
    // `serializeProfileWork` resolves only after the work resolved, thus the holder is set here.
    return holder.outcome === undefined ? err(new Error("the profile drive gave no outcome")) : ok(holder.outcome);
}

/**
 * The body of `GET {A}/data-profile`. The read also feeds the agent-switch gauge: a profile that is pending or
 * running holds the sandbox agent busy, and any other state releases it.
 */
function loadProfileView(pool: Pool, analysisId: string, opts: RunRoutesOpts): ResultAsync<DataProfileView, DbError> {
    return opts.loadProfile(pool, analysisId).map((row): DataProfileView => {
        if (row === null) {
            noteDataProfileState(analysisId, false);
            return { status: null };
        }
        noteDataProfileState(analysisId, row.status === "pending" || row.status === "running");
        const usage = getAnalysisDataProfileUsageTotals(analysisId).unwrapOr(null);
        return {
            status: row.status,
            error: row.error,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
            result: row.result,
            workflowId: row.workflowId,
            seedInputFileIds: row.seedInputFileIds,
            ...(usage === null ? {} : { usage }),
        };
    });
}

/**
 * One page of the runs. `active` gives each run that is not terminal, paged in memory: the set is bounded by
 * the live concurrency. `threadId` reads one row past the page to tell if a later page has runs, and with no
 * count of a thread, `total` is a lower bound (the RunList contract).
 */
function listRunPage(
    pool: Pool,
    analysisId: string,
    filter: { active: boolean; threadId: string | undefined },
    page: PageQuery,
    opts: RunRoutesOpts,
): ResultAsync<{ rows: CortexRunRow[]; total: number }, DbError> {
    const offset = page.page * page.perPage;
    if (filter.active) return opts.listActiveRuns(pool, analysisId).map((rows) => ({ rows: rows.slice(offset, offset + page.perPage), total: rows.length }));
    if (filter.threadId !== undefined) {
        return opts
            .listThreadRuns(pool, analysisId, filter.threadId, { limit: page.perPage + 1, offset })
            .map((rows) => ({ rows: rows.slice(0, page.perPage), total: offset + rows.length }));
    }
    return opts.listRuns(pool, analysisId, { limit: page.perPage, offset });
}

/** True when `runId` is a run of the analysis, or the workflow of its data profile. */
function streamBelongsTo(pool: Pool, analysisId: string, runId: string, opts: RunRoutesOpts): ResultAsync<boolean, DbError> {
    return opts.getRun(pool, runId).andThen((row) => {
        if (row !== null) return okAsync(row.analysisId === analysisId);
        return opts.loadProfile(pool, analysisId).map((profile) => profile !== null && profile.workflowId === runId);
    });
}

/**
 * Map a page of run rows to their summaries: the plan title of each distinct plan, read through a queue of
 * fixed width, and the usage of each run from one grouped read of the local ledger. A failed plan read or
 * usage read costs that figure, never the row.
 */
async function summarizeRuns(pool: Pool, analysisId: string, rows: readonly CortexRunRow[], opts: RunRoutesOpts): Promise<RunSummary[]> {
    const planIds = [...new Set(rows.flatMap((row) => (row.planId === null ? [] : [row.planId])))];
    const queue = new PQueue({ concurrency: PLAN_LOAD_CONCURRENCY });
    const titles = new Map<string, string>();
    await Promise.all(
        planIds.map((planId) =>
            queue.add(() =>
                opts.loadPlan(pool, planId, analysisId).match(
                    (plan) => {
                        const title = planTitleOf(plan);
                        if (title !== null) titles.set(planId, title);
                    },
                    () => undefined,
                ),
            ),
        ),
    );
    const usageByRun = new Map(
        listAnalysisUsageByRun(analysisId)
            .unwrapOr([])
            .map((group) => [group.runId, group.totals] as const),
    );
    return rows.map((row) => toRunSummary(row, row.planId === null ? null : (titles.get(row.planId) ?? null), usageByRun.get(row.runId) ?? null));
}

function toRunSummary(row: CortexRunRow, planTitle: string | null, usage: UsageTotals | null): RunSummary {
    return {
        runId: row.runId,
        threadId: row.threadId,
        workflowName: row.workflowName,
        // The launch contract: `execute_analysis` starts the workflow with `workflowId: runId`.
        workflowId: row.runId,
        status: row.status,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        error: row.error,
        ...(planTitle === null ? {} : { planTitle }),
        // A run with no ledger call has a zero count: no figure, the same as a run with no ledger row.
        ...(usage === null || usage.calls === 0 ? {} : { usage }),
    };
}

function toStepSummary(step: StepExecutionRow, name: string | undefined, usage: UsageTotals | undefined): RunStepSummary {
    return {
        stepId: step.stepId,
        ...(name === undefined ? {} : { name }),
        agentId: step.agentId,
        status: step.status,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        durationMs: step.durationMs,
        error: step.error,
        attempts: step.attempts,
        blockedReason: step.blockedReason,
        ...(usage === undefined ? {} : { usage }),
    };
}

/**
 * The human title of a plan, or `null` when the plan is absent, unreadable, or has no title. The stored plan
 * is a JSON document whose schema types `title` as optional, thus each hop is tested.
 */
export function planTitleOf(plan: unknown): string | null {
    if (typeof plan !== "object" || plan === null || !("title" in plan)) return null;
    const title = plan.title;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

/**
 * The human name of each step of a plan, keyed by the step id of the ledger rows. A plan that is missing or
 * malformed, or whose steps have no names, gives an empty map, and each step keeps its id.
 */
export function planStepNames(plan: unknown): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    if (typeof plan !== "object" || plan === null || !("steps" in plan)) return names;
    const steps = plan.steps;
    if (!Array.isArray(steps)) return names;
    for (const step of steps) {
        if (typeof step !== "object" || step === null) continue;
        const id = "id" in step ? step.id : undefined;
        const name = "name" in step ? step.name : undefined;
        if (typeof id === "string" && typeof name === "string" && name.trim().length > 0) names.set(id, name.trim());
    }
    return names;
}

/** The first line of a multi-line message, so a hint with its remedy stays one line. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? text;
}

/** The state of the configured sandbox image in the container engine, with no pull. */
async function imageReadiness(image: string): Promise<SandboxImageReadiness> {
    const engine = await ensureRuntime();
    if (engine.isErr()) return { state: "engine_error", image, message: firstLine(engine.error.message) };
    const inspected = await ResultAsync.fromPromise(capture(engine.value, ["image", "inspect", image]), (cause) => cause);
    if (inspected.isErr()) return { state: "engine_error", image, message: `The container engine is not reachable (${describeCause(inspected.error)}).` };
    if (inspected.value.code === 0) return { state: "present", image };
    return isPublishedSandboxImage(image) ? { state: "absent", image } : { state: "custom", image };
}

/** The production readiness: the engine inspect of the image, the store content, and the farm of the analysis. */
async function readSandboxReadiness(analysisId: string): Promise<Omit<SandboxReadiness, "inputCount">> {
    const storeRoot = env.packageStoreDir;
    const [image, store] = await Promise.all([imageReadiness(configuredSandboxImage()), inspectStoreContent(storeRoot)]);
    return {
        image,
        store,
        farm: {
            present: existsSync(join(analysisFarmPath(storeRoot, analysisId), FARM_LOCK_FILE)),
            catalogPresent: existsSync(join(catalogFarmPath(storeRoot), FARM_LOCK_FILE)),
            failure: takeFarmCompositionFailure(analysisId)?.reason ?? null,
        },
    };
}

/** The production heal: compose the full farm from the catalog closure, when the farm is missing and the catalog is present. */
async function healAnalysisFarm(analysisId: string): Promise<FarmHealOutcome> {
    const storeRoot = env.packageStoreDir;
    if (existsSync(join(analysisFarmPath(storeRoot, analysisId), FARM_LOCK_FILE))) return { kind: "already_present" };
    if (!existsSync(join(catalogFarmPath(storeRoot), FARM_LOCK_FILE))) return { kind: "no_catalog" };
    return (await composeFullFarm({ storeRoot, analysisId })).match(
        (farm): FarmHealOutcome => ({ kind: "composed", packages: farm.storeDirs.length }),
        (error): FarmHealOutcome => ({ kind: "failed", reason: describeFarmCompositionError(error) }),
    );
}
