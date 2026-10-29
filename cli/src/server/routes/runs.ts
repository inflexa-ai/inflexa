import { existsSync } from "node:fs";
import { join } from "node:path";

import { Hono, type Context } from "hono";
import { err, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import PQueue from "p-queue";
import { z } from "zod";
import {
    countArtifactsByRuns,
    countStepsByRuns,
    countRunsByAnalysis,
    createRunEventStream,
    FARM_LOCK_FILE,
    loadDataProfileStatus,
    loadPlan,
    loadPlanRecord,
    makeLocalAuth,
    planGraphOf,
    planPartOf,
    queryActiveRunsByAnalysis,
    queryRun,
    queryRunIdsByPlan,
    queryRunsByAnalysis,
    queryStepsByRun,
    readRunSynthesis,
    UnknownRunError,
    type AgentSession,
    type ApprovePlanInput,
    type ApprovePlanRefusal,
    type CortexRunRow,
    type DataProfileStatus,
    type DbError,
    type Pool,
    type PlanApproval,
    type PlanRecord,
    type RunArtifactCount,
    type RunStepCounts,
    type RunEventSubscribeOptions,
    type StepExecutionRow,
} from "@inflexa-ai/harness";
import type { RunSynthesisPart } from "@inflexa-ai/harness/contracts/index.js";
import { CONVERSATION_AGENT_ID } from "@inflexa-ai/harness/agents/conversation-agent.js";
import { queryRunsByThread } from "@inflexa-ai/harness/state/runs.js";

import { describeBusyReason, type BusyReason } from "../../api/analyses.ts";
import type { PageQuery } from "../../api/common.ts";
import type {
    ApprovePlanBody,
    CancelRunResult,
    ChatContext,
    DataProfileView,
    FarmHealOutcome,
    FarmHealResult,
    PlanApprovalConflict,
    PlanApprovalResult,
    PlanView,
    ProfileOutcome,
    ProfileRerunResult,
    RunDetail,
    RunPlan,
    RunSeenResponse,
    RunStatus,
    RunStepSummary,
    RunSummary,
    RunSynthesisView,
    SandboxReadiness,
    TerminalRunStatus,
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
import { recordRunSeen } from "../../db/primary_mutation.ts";
import { env } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";
import { noteAnalysisActivity } from "../../modules/analysis/activity.ts";
import { noteDataProfileState } from "../../modules/harness/agent_switch.ts";
import { ensureProfileAtParity, forceReprofile, type ProfileParityOutcome } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { buildChatSession } from "../../modules/harness/turn.ts";
import { analysisFarmPath, catalogFarmPath, composeFullFarm, describeFarmCompositionError } from "../../modules/libs/composition.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ServerBoot } from "../boot.ts";
import {
    apiError,
    filterValue,
    holdConnection,
    internalError,
    listEnvelope,
    parsePage,
    readBody,
    requireRuntime,
    sseResponse,
    type ServerEnv,
} from "../http.ts";
import { profileWorkPending, serializeProfileWork } from "../profile_queue.ts";
import { readSandboxReadiness, sandboxRefusal } from "../sandbox_gate.ts";
import { newTurnsRefused, runningTurnsByThread } from "../turns.ts";
import { workspaceRoot } from "./conversation.ts";

/**
 * How many plans one runs page loads at the same time. A page holds up to 200 runs, and each distinct plan is
 * one Postgres read, thus the width bounds the pool connections that one request takes.
 */
const PLAN_LOAD_CONCURRENCY = 4;

/** The most run ids that `GET {A}/plans/:planId` gives. The route reads one more, to tell if the plan has more. */
const PLAN_RUN_IDS_LIMIT = 100;

/** The harness reads and the machine probes that the routes call. Tests replace each one, because each needs Postgres, DBOS, or the container engine. */
export type RunRoutesOpts = {
    /** One page of the runs of an analysis that the text `q` selects, newest first, and the count of all the runs that it selects. */
    readonly listRuns: (
        pool: Pool,
        analysisId: string,
        query: { q?: string; limit: number; offset: number },
    ) => ResultAsync<{ rows: CortexRunRow[]; total: number }, DbError>;
    /** One page of the runs that the turns of one thread launched and that the text `q` selects, newest first. */
    readonly listThreadRuns: (
        pool: Pool,
        analysisId: string,
        threadId: string,
        query: { q?: string; limit: number; offset: number },
    ) => ResultAsync<CortexRunRow[], DbError>;
    /** Each run of the analysis that is not terminal and that the text `q` selects. The set is bounded by the live concurrency, not by the history. */
    readonly listActiveRuns: (pool: Pool, analysisId: string, filter: { q?: string }) => ResultAsync<CortexRunRow[], DbError>;
    readonly getRun: (pool: Pool, runId: string) => ResultAsync<CortexRunRow | null, DbError>;
    /** The step-output count of each run of the list, in one read. A run with no step output has no entry. */
    readonly countArtifacts: (pool: Pool, analysisId: string, runIds: readonly string[]) => ResultAsync<RunArtifactCount[], DbError>;
    /** The step counts of each run of the list, in one read. A run with no step has no entry. */
    readonly countSteps: (pool: Pool, analysisId: string, runIds: readonly string[]) => ResultAsync<RunStepCounts[], DbError>;
    /** The flat synthesis part of the record on disk, or `null` when the record cannot be read. The route asks only for a run whose outcome is `produced`. */
    readonly readSynthesis: (analysisId: string, runId: string) => Promise<RunSynthesisPart | null>;
    readonly listSteps: (pool: Pool, runId: string) => ResultAsync<StepExecutionRow[], DbError>;
    /** The stored plan document, or `null` when it is gone. */
    readonly loadPlan: (pool: Pool, planId: string, analysisId: string) => ResultAsync<unknown, DbError>;
    /** The stored plan with its parent and the plan that replaced it, or `null` when the plan is gone or belongs to another analysis. */
    readonly loadPlanRecord: (pool: Pool, planId: string, analysisId: string) => ResultAsync<PlanRecord | null, DbError>;
    /** The ids of the runs of one plan, newest first, at most `limit`. */
    readonly listPlanRunIds: (pool: Pool, analysisId: string, planId: string, limit: number) => ResultAsync<string[], DbError>;
    readonly loadProfile: (pool: Pool, analysisId: string) => ResultAsync<DataProfileStatus | null, DbError>;
    /** Deliver each part of the run, and of its children, until the run is terminal or the signal aborts. */
    readonly subscribeRun: (pool: Pool, options: RunEventSubscribeOptions) => Promise<void>;
    /** Cancel the run and its children, and converge the ledgers. Rejects with {@link UnknownRunError} for an unknown run. */
    readonly cancelRun: (runtime: HarnessRuntime, runId: string, session: AgentSession) => Promise<CancelRunResult>;
    /** The parity drive of a chat open. */
    readonly ensureParity: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** The deliberate re-profile. */
    readonly forceReprofile: (runtime: HarnessRuntime, analysis: Analysis) => Promise<ProfileParityOutcome>;
    /** Approve a stored plan and start its run with no model call. Each outcome rides the `Result`. */
    readonly approvePlan: (runtime: HarnessRuntime, input: ApprovePlanInput) => ResultAsync<PlanApproval, ApprovePlanRefusal>;
    /** The image, the store, and the farm verdict for a sandbox of the analysis. */
    readonly readiness: (analysisId: string) => Promise<Omit<SandboxReadiness, "inputCount">>;
    /** Why a profile drive cannot start a sandbox now, or `null` when it can. Each profile route asks it before its drive. */
    readonly sandboxRefusal: (analysisId: string) => Promise<string | null>;
    /** Compose the farm of the analysis from the catalog closure, when the farm is missing. */
    readonly healFarm: (analysisId: string) => Promise<FarmHealOutcome>;
};

/** The production {@link RunRoutesOpts}. */
export const DEFAULT_RUN_ROUTES_OPTS: RunRoutesOpts = {
    listRuns: (pool, analysisId, query) =>
        ResultAsync.combine([
            queryRunsByAnalysis(pool, analysisId, query),
            countRunsByAnalysis(pool, analysisId, query.q === undefined ? {} : { q: query.q }),
        ]).map(([rows, total]) => ({ rows, total })),
    listThreadRuns: queryRunsByThread,
    listActiveRuns: queryActiveRunsByAnalysis,
    getRun: queryRun,
    countArtifacts: countArtifactsByRuns,
    countSteps: countStepsByRuns,
    readSynthesis: readSynthesisOf,
    listSteps: queryStepsByRun,
    loadPlan: (pool, planId, analysisId) => loadPlan(pool, planId, { analysisId }),
    loadPlanRecord: (pool, planId, analysisId) => loadPlanRecord(pool, planId, { analysisId }),
    listPlanRunIds: (pool, analysisId, planId, limit) => queryRunIdsByPlan(pool, { analysisId, planId, limit }),
    loadProfile: loadDataProfileStatus,
    subscribeRun: (pool, options) => createRunEventStream({ pool }).subscribe(options),
    cancelRun: (runtime, runId, session) => runtime.runCanceler.cancel(runId, session),
    ensureParity: ensureProfileAtParity,
    forceReprofile,
    readiness: readSandboxReadiness,
    sandboxRefusal,
    healFarm: healAnalysisFarm,
    approvePlan: (runtime, input) => runtime.approvePlan(input),
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
        const q = filterValue(c.req.query("q"));
        const listed = await listRunPage(pool, analysisId, { active: c.req.query("active") === "true", threadId: c.req.query("threadId"), q }, page, opts);
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

        const [artifactCounts, stepCounts] = await Promise.all([
            readArtifactCounts(pool, analysisId, [runId], opts),
            readStepCounts(pool, analysisId, [runId], opts),
        ]);
        const stepUsage = listRunUsageByStep(analysisId, runId).unwrapOr([]);
        const usageByStep = new Map(stepUsage.flatMap((group) => (group.stepId === null ? [] : [[group.stepId, group.totals] as const])));
        const runUsage = getRunUsageTotals(analysisId, runId).unwrapOr(null);

        const detail: RunDetail = {
            ...toRunSummary(run, planTitleOf(planDoc), runUsage, artifactCountOf(artifactCounts, runId), stepCountsOf(stepCounts, runId)),
            steps: steps.value.map((step) => toStepSummary(step, stepNames.get(step.stepId), usageByStep.get(step.stepId))),
            plan: planOf(run.planId, planDoc),
            // SQLite groups the NULL step ids as one group: the calls of the run outside each step.
            unattributedUsage: stepUsage.find((group) => group.stepId === null)?.totals ?? null,
        };
        return c.json(detail);
    });

    routes.get("/plans/:planId", runtimeGate, async (c) => {
        const analysisId = analysisParam(c);
        const planId = c.req.param("planId");
        const pool = c.get("runtime").pool;
        // Both reads start before either is awaited, thus the route costs one round trip of latency.
        const read = await ResultAsync.combine([
            opts.loadPlanRecord(pool, planId, analysisId),
            opts.listPlanRunIds(pool, analysisId, planId, PLAN_RUN_IDS_LIMIT + 1),
        ]);
        if (read.isErr()) return internalError(c, read.error, "read the plan");
        const [record, runIds] = read.value;
        if (record === null) return apiError(c, "not_found", `This analysis has no plan ${planId}.`);

        // The plan row exists, thus a document that gives no part degrades the body and never the status.
        const plan = planPartOf(record);
        if (plan === null) getLogger("server").warn({ analysisId, planId }, "the stored plan does not give a data-plan part");
        return c.json<PlanView>({
            plan,
            parentPlanId: record.parentPlanId,
            supersededBy: record.supersededBy,
            runIds: runIds.slice(0, PLAN_RUN_IDS_LIMIT),
            hasMoreRuns: runIds.length > PLAN_RUN_IDS_LIMIT,
        });
    });

    routes.post("/plans/:planId/approve", runtimeGate, async (c) => {
        // The stop refuses new work before the body is read.
        if (newTurnsRefused())
            return apiError(c, "draining", "The Inflexa server is stopping and approves no plan. Approve the plan again after the server starts again.");
        const analysisId = analysisParam(c);
        const planId = c.req.param("planId");
        const body = await readBody<ApprovePlanBody>(c, z.object({ threadId: z.string().min(1), newestRunId: z.string().min(1).nullable() }));
        if (body.isErr()) return body.error;
        const { threadId, newestRunId } = body.value;
        // The record of the approval lands in the thread between two rounds of a running turn, at the earliest. The
        // approval waits for the turn instead. The check is not a lock: a turn that starts after it still sees a
        // valid sequence of messages.
        if (runningTurnsByThread().has(threadId)) {
            const busy: BusyReason[] = ["chat_turn"];
            return apiError(c, "busy", `Cannot approve a plan while ${describeBusyReason("chat_turn")}.`, { reasons: busy });
        }

        const { identity, auth } = buildChatSession(analysisId, threadId);
        const approval = await opts.approvePlan(c.get("runtime"), { analysisId, threadId, planId, newestRunId, identity, auth });
        return approval.match(
            (result) => {
                // An approval that found the run active, or a stale view, changed nothing, thus it is no activity.
                if (result.started) noteAnalysisActivity(analysisId, Date.now());
                return c.json<PlanApprovalResult>(result, 201);
            },
            (refusal) => approvalRefusal(c, planId, refusal),
        );
    });

    routes.get("/run/:runId/synthesis", runtimeGate, async (c) => {
        // A folder on a hung mount can stop the record read for more than 10 s.
        holdConnection(c);
        const analysisId = analysisParam(c);
        const runId = c.req.param("runId");
        const row = await opts.getRun(c.get("runtime").pool, runId);
        if (row.isErr()) return internalError(c, row.error, "read the run");
        if (row.value === null || row.value.analysisId !== analysisId) return runNotFound(c, runId);

        // The run row is the authority on whether a synthesis exists. A record on disk from a synthesis that
        // later failed, or from a run with no recorded outcome, must not show as one.
        const { synthesisStatus: status, synthesisReason: reason } = row.value;
        const synthesis = status === "produced" ? await opts.readSynthesis(analysisId, runId) : null;
        if (status === "produced" && synthesis === null) {
            getLogger("server").warn({ analysisId, runId }, "the run recorded a produced synthesis, but its record could not be read");
        }
        return c.json<RunSynthesisView>({ status, reason, synthesis });
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
        const canceled = await ResultAsync.fromPromise(opts.cancelRun(c.get("runtime"), runId, session), (cause) => cause);
        return canceled.match(
            (result) => c.json(result),
            (cause) => (cause instanceof UnknownRunError ? runNotFound(c, runId) : internalError(c, cause, "cancel the run")),
        );
    });

    routes.post("/run/:runId/seen", runtimeGate, async (c) => {
        const analysisId = analysisParam(c);
        const runId = c.req.param("runId");
        const row = await opts.getRun(c.get("runtime").pool, runId);
        if (row.isErr()) return internalError(c, row.error, "read the run");
        if (row.value === null || row.value.analysisId !== analysisId) return runNotFound(c, runId);
        if (!isTerminalRunStatus(row.value.status)) return apiError(c, "conflict", "The run has not ended.");
        // A mark is not an activity, thus the activity time of the analysis stays as it is.
        return recordRunSeen(runId, analysisId, Date.now()).match(
            () => c.json<RunSeenResponse>({ seen: true }),
            (e) => internalError(c, e, "mark the run as seen"),
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

        // A refusal is the outcome of the drive, not an error of the route: the chat opens, and the client shows the reason.
        const refusal = await opts.sandboxRefusal(analysisId);
        const parity: Result<ProfileOutcome, unknown> =
            refusal === null
                ? await queuedDrive(analysisId, () => opts.ensureParity(runtime, target))
                : ok({ kind: "failed", reason: refusal, materialized: false });
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

        const refusal = await opts.sandboxRefusal(analysisId);
        if (refusal !== null) return apiError(c, "conflict", refusal);
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

/** True for a status that a run keeps once it ended. */
export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
    // The switch lists each status, so the predicate holds for exactly the members of `TerminalRunStatus`.
    switch (status) {
        case "completed":
        case "partial":
        case "failed":
        case "canceled":
            return true;
        case "running":
            return false;
        default: {
            const exhaustive: never = status;
            throw new Error(`unhandled run status: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The `analysisId` of the mount path. A route outside that mount reads an empty id, which matches no row. */
function analysisParam(c: Context<ServerEnv>): string {
    return c.req.param("analysisId") ?? "";
}

/** The response for a refusal of the approval of a plan. The refusals of the plan and of the launch are 409; the failures of the store and of the start are 500. */
function approvalRefusal(c: Context<ServerEnv>, planId: string, refusal: ApprovePlanRefusal): Response {
    const conflict = (message: string, details: PlanApprovalConflict): Response => apiError(c, "conflict", message, details);
    switch (refusal.type) {
        case "thread_not_found":
            return apiError(c, "not_found", "Thread not found.");
        case "plan_not_found":
            return apiError(c, "not_found", `This analysis has no plan ${planId}.`);
        case "run_not_found":
            return apiError(c, "not_found", `Plan ${planId} has no run ${refusal.runId}.`);
        case "superseded":
            return conflict(`Plan ${planId} was replaced by plan ${refusal.supersededBy}.`, { reason: "superseded", supersededBy: refusal.supersededBy });
        case "plan_invalid":
            return conflict(`Plan ${planId} is not valid.`, { reason: "plan_invalid", errors: refusal.errors });
        case "packages_missing":
            return conflict(`The packages of plan ${planId} cannot link.`, {
                reason: "packages_missing",
                missing: refusal.missing,
                collisions: refusal.collisions,
                ...(refusal.unavailable === undefined ? {} : { unavailable: refusal.unavailable }),
            });
        // The harness names the datasets and no command: the remedy is this host's to give. The
        // command goes in the MESSAGE, because that is what a caller shows a user and what the
        // conversation agent reads before it offers the download it can already run.
        case "references_missing":
            return conflict(
                refusal.missing.length > 0
                    ? `The reference data of plan ${planId} is not installed. Install it with: inflexa refs download ${refusal.missing.join(" ")}`
                    : `The reference data of plan ${planId} could not be confirmed: ${refusal.unavailable ?? "the store did not answer"}.`,
                {
                    reason: "references_missing",
                    missing: refusal.missing,
                    ...(refusal.unavailable === undefined ? {} : { unavailable: refusal.unavailable }),
                },
            );
        case "not_authorized":
            return conflict(`The run was not authorized: ${refusal.reason}`, { reason: "not_authorized" });
        case "suspended":
            return conflict(`The analysis is suspended: ${refusal.reason}`, { reason: "suspended" });
        case "store_failed":
            return internalError(c, refusal.cause, "approve the plan");
        case "launch_failed":
            return internalError(c, refusal.cause, "start the run of the plan");
        default: {
            const exhaustive: never = refusal;
            throw new Error(`unhandled approval refusal: ${JSON.stringify(exhaustive)}`);
        }
    }
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
        const work = profileWorkPending(analysisId) ? { workPending: true as const } : {};
        if (row === null) {
            noteDataProfileState(analysisId, false);
            return { status: null, ...work };
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
            ...work,
        };
    });
}

/**
 * One page of the runs that the text `q` selects. `q` narrows each branch, and the harness does the filter before
 * the page. `active` comes first and ignores `threadId`: it gives each run that is not terminal, paged in
 * memory, because the set is bounded by the live concurrency. `threadId` reads one row past the page to tell if
 * a later page has runs, and with no count of a thread, `total` is a lower bound (the RunList contract).
 */
function listRunPage(
    pool: Pool,
    analysisId: string,
    filter: { active: boolean; threadId: string | undefined; q: string | undefined },
    page: PageQuery,
    opts: RunRoutesOpts,
): ResultAsync<{ rows: CortexRunRow[]; total: number }, DbError> {
    const offset = page.page * page.perPage;
    // The harness reads take an absent `q` as no filter, and `exactOptionalPropertyTypes` bars an explicit `undefined`.
    const text = filter.q === undefined ? {} : { q: filter.q };
    if (filter.active)
        return opts.listActiveRuns(pool, analysisId, text).map((rows) => ({ rows: rows.slice(offset, offset + page.perPage), total: rows.length }));
    if (filter.threadId !== undefined) {
        return opts
            .listThreadRuns(pool, analysisId, filter.threadId, { ...text, limit: page.perPage + 1, offset })
            .map((rows) => ({ rows: rows.slice(0, page.perPage), total: offset + rows.length }));
    }
    return opts.listRuns(pool, analysisId, { ...text, limit: page.perPage, offset });
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
    const runIds = rows.map((row) => row.runId);
    const [artifactCounts, stepCounts] = await Promise.all([
        readArtifactCounts(pool, analysisId, runIds, opts),
        readStepCounts(pool, analysisId, runIds, opts),
    ]);
    return rows.map((row) =>
        toRunSummary(
            row,
            row.planId === null ? null : (titles.get(row.planId) ?? null),
            usageByRun.get(row.runId) ?? null,
            artifactCountOf(artifactCounts, row.runId),
            stepCountsOf(stepCounts, row.runId),
        ),
    );
}

/**
 * The step-output count of each run of the list, from one grouped read. A failed read gives `null` and a log
 * line: the runs then carry no count, because a false 0 would state that a run has no files.
 */
async function readArtifactCounts(pool: Pool, analysisId: string, runIds: readonly string[], opts: RunRoutesOpts): Promise<ReadonlyMap<string, number> | null> {
    return opts.countArtifacts(pool, analysisId, runIds).match(
        (counts) => new Map(counts.map((entry) => [entry.runId, entry.count] as const)),
        (error) => {
            getLogger("server").warn({ err: error, analysisId }, "could not count the artifacts of the runs");
            return null;
        },
    );
}

/** The count of one run, 0 for a run with no entry, and `null` when the read failed. */
function artifactCountOf(counts: ReadonlyMap<string, number> | null, runId: string): number | null {
    return counts === null ? null : (counts.get(runId) ?? 0);
}

type StepCounts = Omit<RunStepCounts, "runId">;

const NO_STEPS: StepCounts = { doneSteps: 0, runningSteps: 0, totalSteps: 0 };

/**
 * The step counts of each run of the list, from one grouped read. A failed read gives `null` and a log line: the
 * runs then carry no counts, because a false 0 would state that a run has no steps.
 */
async function readStepCounts(pool: Pool, analysisId: string, runIds: readonly string[], opts: RunRoutesOpts): Promise<ReadonlyMap<string, StepCounts> | null> {
    return opts.countSteps(pool, analysisId, runIds).match(
        (counts) => new Map(counts.map(({ runId, ...entry }) => [runId, entry] as const)),
        (error) => {
            getLogger("server").warn({ err: error, analysisId }, "could not count the steps of the runs");
            return null;
        },
    );
}

/** The counts of one run, 0 for each count of a run with no entry, and `null` when the read failed. */
function stepCountsOf(counts: ReadonlyMap<string, StepCounts> | null, runId: string): StepCounts | null {
    return counts === null ? null : (counts.get(runId) ?? NO_STEPS);
}

function toRunSummary(
    row: CortexRunRow,
    planTitle: string | null,
    usage: UsageTotals | null,
    artifactCount: number | null,
    stepCounts: StepCounts | null,
): RunSummary {
    return {
        runId: row.runId,
        threadId: row.threadId,
        planId: row.planId,
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
        ...(artifactCount === null ? {} : { artifactCount }),
        ...(stepCounts === null ? {} : stepCounts),
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

/** The plan graph of a run, or `null` when the run has no plan, the document is gone, or it gives no valid graph. */
function planOf(planId: string | null, document: unknown): RunPlan | null {
    if (planId === null || document === null) return null;
    const steps = planGraphOf(document);
    return steps === null ? null : { planId, steps };
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

/** The synthesis record of a run on disk. The folder is located for a read, thus a folder that became read-only still gives its record. */
async function readSynthesisOf(analysisId: string, runId: string): Promise<RunSynthesisPart | null> {
    const lookup = await workspaceRoot(analysisId);
    return lookup.kind === "root" ? readRunSynthesis({ workspaceRoot: lookup.root, runId }) : null;
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
