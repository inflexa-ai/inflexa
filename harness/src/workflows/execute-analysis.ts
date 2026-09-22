/**
 * `executeAnalysis` — the parent DBOS workflow.
 *
 * Shape (every external interaction is a `DBOS.runStep` so a crashed parent
 * replays from the cache instead of repeating side effects):
 *
 *  1. `validateAndInit`
 *     - validate the plan DAG (cycle / missing-dep / dup-id)
 *     - create the run dir
 *     - open the running charge
 *     - emit `data-run-started`
 *     Inputs are NOT materialized here: the workspace tree's `data/` inputs must
 *     already be populated by the embedder before the run is triggered — the
 *     workflow neither downloads nor stages input data.
 *     The run authorization is minted at the async edge (`executePlan` / TA
 *     trigger / `runDataProfile`) and rides in `input.runSession` — the
 *     workflow body never mints, never reads the JWT back from `cortex_runs`.
 *  2. Scheduler loop
 *     - maintain `completedSet` + `inFlightHandles`
 *     - dispatch every `scheduleReady(plan, completedSet, startedSet)` via
 *       `DBOS.startWorkflow` with deterministic child id
 *       `"${parent.workflowID}-${N}"` (N is the step's stable index)
 *     - compose each child's seed prompt HERE, at dispatch (`composeStepSeed`,
 *       inside a durable step): the moment a step is dispatched is the first
 *       moment its dependencies' results exist, so this is the only place the
 *       seed can name them
 *     - each child input is `forStep(input.runSession, stepId)` for the
 *       session field
 *     - emit `data-dag-state` (reconciling by id) on every dispatch +
 *       completion
 *     - await child results via `getResult` (these are themselves cached
 *       in DBOS, so parent recovery does NOT re-run completed children)
 *  3. Failure isolation
 *     - a child settling `failed`/`blocked` (or throwing for a cause that is
 *       not a suspension) dooms only its transitive dependents: they can never
 *       become dependency-satisfied, are marked `skipped` on the dag-state
 *       part, and are never dispatched. In-flight siblings and independent
 *       ready steps continue; the loop drains and the run finalises (typically
 *       `partial`).
 *     - the halt cascade (cancel in-flight via
 *       `Promise.allSettled(handles.map(h => DBOS.cancelWorkflow(h.workflowID)))`,
 *       stop scheduling) survives only for a suspension of a child and the
 *       `neverFits` plan-validation guard.
 *  4. Suspension cascade (workflow-suspension spec)
 *     - a child that suspends sends a typed message on `CHILD_SUSPENDED_TOPIC`
 *       and cancels itself. The parent reads the kind of the message, never a
 *       reason string: it cancels the siblings, then self-cancels to
 *       `CANCELLED` (NOT `ERROR` — ERROR isn't resumable; NOTES #3)
 *     - a refusal of the `RunCharge.open` gate with the suspend flag suspends
 *       the run before any step starts
 *     - a `suspend` error of a synthesis model request suspends the run in
 *       place of the synthesis failure
 *     - the analysis flips to `suspended_insufficient_funds` in
 *       `collectAndComplete`. The paused parent lands in `CANCELLED`, a
 *       durably reschedulable state; re-driving it is a future enhancement,
 *       not yet wired here. The reason of the host rides to the run row, the
 *       charge close, the metric, and the terminal part, unread.
 *  5. `synthesizeFindings` (single sequential block, no sandbox)
 *  6. `collectAndComplete` (terminal — runs on ALL paths)
 *     - determine final status from completed/cancelled/failed counts
 *     - update `cortex_runs.status` + `error`, and inside that same step record
 *       the run outcome metric plus the outcome of every settled step whose
 *       child never wrote its own terminal row (a cancelled child, or one that
 *       died before `failStep`)
 *     - close running charge with matching reason
 *     - revoke run authorization via the injected `runAuthorizer` seam
 *     - emit terminal stream part
 *     - WRITES NOTHING to the conversation thread (results are pull-only
 *       via `inspectRun`)
 */

import { DBOS, Error as DBOSErrors, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import { ResultAsync, err, ok, type Result } from "neverthrow";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

import type { MachineBudget, ResourceSpec } from "../config/resource-limits.js";
import { forStep } from "../auth/types.js";
import type { RunSession } from "../auth/types.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { deliverNotice, passGate, type GateRefusal } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { ATTR_INFLEXA_STEP_ID, stableSpan } from "../lib/otel-spans.js";
import { recordRunCompleted, recordStepCompleted, stepOutcomeOf } from "../lib/metrics.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { CitationResolver } from "../citations/types.js";
import { describeDbError, type DbError } from "../lib/db-result.js";
import { unwrapOrThrow } from "../lib/result.js";
import {
    countArtifactsForRun,
    insertStepExecution,
    loadDataProfileStatus,
    queryActiveRun,
    queryStepArtifactPaths,
    queryStepsByRun,
    seedStepExecutions,
    setRunSynthesisOutcome,
    suspendAnalysis as suspendAnalysisQuery,
    sweepPendingStepExecutions,
    updateRunStatus,
    updateStepExecution,
} from "../state/index.js";
import type { SynthesisStatus, UpdateStepExecutionInput } from "../state/index.js";
import { addChatUsage, hasReportedUsage, type AgentRunUsage } from "../loop/metrics.js";
import type { TokenUsageRollup } from "../contracts/usage.js";
import { SYNTHESIS_AGENT_ID, loadStepSummariesFromDisk } from "../execution/run-synthesis.js";
import { MAX_UPSTREAM_ARTIFACTS, composeStepBriefing, type UpstreamHandoff } from "../prompts/briefing.js";
import type { AnalysisStep } from "../schemas/workflow-state.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { BioToolKeys } from "../tools/bio/keys.js";
import type { ProvenanceSeam, RunProvenanceEvent } from "../provenance/seam.js";
import type { EmitFn } from "../loop/types.js";
import type { RunCharge, RunChargeOutcome } from "../billing/run-charge.js";
import { SYNTHESIS_STEP_ID, runDir, runStepDir, stepSubdir, stepWritePrefix, toSandboxPath, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { isChatDataPart } from "../sandbox/sandbox-step-translate.js";
import { synthesizeRun } from "../app/synthesize-run.js";
import { type PlanStep, computeTopologicalLevels, scheduleReady, validatePlanDag } from "./execute-analysis-scheduler.js";
import { recordCancelledChild } from "./metrics.js";
import { CHILD_SUSPENDED_TOPIC, type ChildSuspended, type SandboxStepInput, type SandboxStepResult } from "./sandbox-step.js";
import { cancelSelf, suspensionOfFailure, suspensionOfRefusal, type Suspension } from "./suspension.js";

/** Registered child sandbox-step callable the parent's child-dispatch closes over. */
type SandboxStepCallable = (input: SandboxStepInput) => Promise<SandboxStepResult>;

// ── Workflow input/output shapes ─────────────────────────────────────

/** Quick-display finding on the run-completed card. Mirrors the wire schema's RunCompletedFinding. */
export interface RunFinding {
    readonly title: string;
    readonly confidence: "high" | "medium" | "low";
}

export interface ExecuteAnalysisInput {
    readonly analysisId: string;
    /** Plan id — the dedup key for the partial-unique index on cortex_runs. */
    readonly planId: string;
    /** Human-readable plan summary for the run-started card (title or narrative). */
    readonly planSummary: string;
    /** Plan steps with `id` and `depends_on`. Validated before any side effect. */
    readonly steps: readonly PlanStep[];
    /** Optional thread id for cortex_runs.thread_id (UI breadcrumb only). */
    readonly threadId?: string | null;
    /**
     * The plan's steps, keyed by id — the instruction DATA each step's seed is
     * composed FROM, not a pre-rendered prompt string. The seed itself is
     * composed per step at dispatch (`composeStepSeed`), because that is the
     * first moment a step's dependencies have produced anything to tell it
     * about. Snapshotted here at the async edge so the body never re-reads the
     * plan row (a mid-run plan edit cannot change a running run's instructions).
     */
    readonly planStepById: Readonly<Record<string, AnalysisStep>>;
    /** Per-step agent id (sandbox catalog entry). */
    readonly agentByStepId: Readonly<Record<string, string>>;
    /** Per-step planner-estimated sandbox resource request. */
    readonly resourcesByStepId: Readonly<Record<string, ResourceSpec>>;
    /**
     * Per-step execution timeout in seconds, from the plan's `step.timeout`.
     * Only present for steps that declared one; the child falls back to
     * `DEFAULT_STEP_TIMEOUT_SECONDS` when a step is absent here.
     */
    readonly timeoutByStepId?: Readonly<Record<string, number>>;
    /**
     * Machine resource budget snapshotted by `executePlan` at the async edge.
     * The scheduler admits dependency-satisfied steps only while the declared
     * resources of concurrently running steps fit within it. Absent (no policy
     * configured, or a workflow persisted before this field existed), every
     * dependency-satisfied step starts immediately — the legacy fan-out.
     */
    readonly budget?: MachineBudget;
    /**
     * Replay-stable run-level synthesis decision. Absent preserves the legacy
     * behavior for workflows persisted before this field existed.
     */
    readonly synthesisEnabled?: boolean;
    /**
     * Durable `RunSession` minted at the async edge by `executePlan`.
     * Carries the run-authorization credential, identity, scope, and `runFrame.runId`.
     * DBOS replay reconstructs it from the serialized workflow input on
     * resume — no DB read, no in-process cache.
     */
    readonly runSession: RunSession;
    /**
     * True when Cortex owns the run-authorization lifecycle and therefore must
     * revoke it on the terminal path. The ownership decision is made by the
     * `RunAuthorizer` seam at the async edge (`executePlan`).
     *
     * Optional because a workflow persisted before this field existed (recovered
     * across the deploy that added it) deserializes without it; the body defaults
     * absent → true, matching the prior Cortex-owned behavior.
     */
    readonly ownsMandate?: boolean; // oss-core-managed-ok
}

/**
 * Outcome of the trigger. `running` is what the dedup-collision recovery
 * path returns — the caller joined an in-flight run, no new workflow was
 * started. Every other variant is a terminal status the parent reached.
 */
export type ExecuteAnalysisFinalStatus = "running" | "completed" | "partial" | "failed" | "canceled";

export interface ExecuteAnalysisResult {
    readonly runId: string;
    readonly workflowId: string;
    readonly status: ExecuteAnalysisFinalStatus;
    readonly completedSteps: readonly string[];
    readonly failedSteps: readonly string[];
    readonly canceledSteps: readonly string[];
}

// ── Dep injection ─────────────────────────────────────────────────────

/**
 * A step's in-run display state. Wider than the ledger's `StepExecutionStatus`: `queued` is a
 * scheduler-only condition (dependency-satisfied but held for budget capacity) that never reaches a
 * database row, and `skipped` is asserted mid-run for a doomed dependent whose ledger row stays
 * `pending` until the terminal sweep.
 */
export type StepRuntimeStatus = "pending" | "queued" | "running" | "completed" | "failed" | "skipped";

/**
 * One step's state inside a {@link RunObservation}. `id` is the plan slug the ledger and the
 * dependency edges use; `name` is the human phrase the plan author wrote, which is the only field
 * that says what the step is FOR. `durationMs` and `error` appear only once the step has settled
 * in a way that produced them.
 */
export interface RunStepObservation {
    readonly id: string;
    readonly name: string;
    readonly agent: string;
    readonly status: StepRuntimeStatus;
    readonly durationMs?: number;
    readonly error?: string;
}

/**
 * A whole-run snapshot handed to {@link ExecuteAnalysisDeps.observeRun}.
 *
 * Deliberately a SNAPSHOT rather than a transition event. The observer is invoked from the
 * workflow body, so DBOS re-execution on recovery re-fires the whole sequence; a re-fired snapshot
 * is idempotent for any consumer that renders from the newest one it has seen, whereas re-fired
 * granular events would force every consumer to rebuild ordering and dedupe by identity. A
 * consumer that misses an invocation loses nothing permanent — the next transition restates the
 * full truth.
 *
 * Derived aggregates (completion counts, run duration) are deliberately ABSENT. They are
 * computable from `steps` and recorded authoritatively on the run's ledger row; carrying them here
 * would mint a second source that can disagree with the ledger a host also reads.
 */
export interface RunObservation {
    readonly runId: string;
    readonly analysisId: string;
    /** `running` for every mid-flight snapshot; the derived terminal status on the last one. */
    readonly status: ExecuteAnalysisFinalStatus;
    /** Every plan step, including ones that have not started — never a delta. */
    readonly steps: readonly RunStepObservation[];
}

/**
 * Construction-time deps for the parent workflow. The order-of-operations is
 * the body's own: it brackets the run, dispatches children, and synthesizes
 * directly via `DBOS.*` + the harness's helpers. Only the genuinely host-specific seams
 * stay injected — the run-charge bracket, run-authorization revoke, and the
 * registered sandbox-step callable — plus the construction inputs (provider,
 * embedder, model, keys, roots) the in-body synthesis needs.
 */
export interface ExecuteAnalysisDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Pool;
    /** Chat provider for the in-body literature-grounded synthesis. */
    readonly provider: ChatProvider;
    /** Write-side embedder for indexing the run synthesis. */
    readonly embedding: EmbeddingProvider;
    /** Registered child sandbox-step callable the body dispatches per step. */
    readonly sandboxStepCallable: SandboxStepCallable;
    /** Workspace-root resolution seam — run dir creation + synthesis disk reads. */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Model id for the synthesizer agent loop. */
    readonly synthesisModel: string;
    /** API keys for the bio/chem tools the embedded literature reviewer uses. */
    readonly bioKeys: BioToolKeys;
    /** Shared resolver for the literature reviewer used during synthesis. */
    readonly citationResolver: CitationResolver;
    /** Run-level billing-bracket seam (managed: external bracket; OSS: no-op). */
    readonly runCharge: RunCharge;
    /** Run-authorization seam — the terminal path revokes through `revoke`. */
    readonly runAuthorizer: RunAuthorizer;
    /**
     * LLM usage-accounting seam for the in-body synthesizer loop (and the
     * literature reviewer it delegates to); omitted falls back to the no-op
     * recorder.
     */
    readonly usageRecorder?: UsageRecorder;

    /**
     * The provenance seam of the composition. The body reads its run emit member,
     * and it reads no other member.
     *
     * The emit is deliberately invoked directly in the workflow body (NOT wrapped
     * in `DBOS.runStep`) so that body re-execution on DBOS recovery re-fires it —
     * a cached step would suppress the recovery re-emission, defeating the
     * point. Idempotency is the consumer's job, achieved via the deterministic
     * identifiers the events carry, not via step caching. Every call site is
     * guarded so a throwing observer never fails the run.
     *
     * Events arrive with the run's `RunSession` from durable workflow input — a
     * persisting realization needs its credential, scope, and identity.
     * Implementations may ignore the parameter.
     */
    readonly provenance?: ProvenanceSeam;

    /**
     * Optional, fire-and-forget observation of the run's live shape, for a host driving a UI.
     *
     * Independent of the run emit of {@link provenance} in every direction: neither is implemented
     * in terms of the other, they share no payload, and supplying one does not imply the other.
     * They exist separately because provenance closes a signed, hash-chained record under a
     * single-writer lock, while this is a lossy-tolerant display channel — coupling them would put
     * a UI repaint behind the chain's write discipline and force provenance to carry step names and
     * agent ids it has no reason to record.
     *
     * Invoked directly in the workflow body (NOT wrapped in `DBOS.runStep`) for the same reason the
     * run emit is: body re-execution on recovery must re-fire it, and a cached step would
     * suppress that. Idempotency comes free for rendering because the payload is a whole-run
     * snapshot; a host taking a DURABLE side effect on one must key it by run id and status itself.
     *
     * Synchronous by signature (`void`, never a promise) so a host needing I/O has to dispatch it
     * rather than await it inside the body's critical path. Every call site is guarded, so a
     * throwing observer never fails the run.
     */
    readonly observeRun?: (observation: RunObservation) => void;
}

// ── In-body orchestration helpers ────────────────────────────────────

/** Emit a chat data part on the parent's DBOS stream. */
function emitStreamPart(part: unknown): Promise<void> {
    return DBOS.writeStream("events", part);
}

/**
 * Run one ledger write of the run as a named step. The write gives a failure as
 * an `err`: the step logs it with its cause and checkpoints the failure as a
 * value, thus a failed write rolls back no side effect that succeeded and
 * never fails the run. A DBOS exception passes through with no change.
 */
async function ledgerStep(log: Logger, name: string, write: () => ResultAsync<unknown, DbError> | Promise<Result<unknown, DbError>>): Promise<void> {
    await DBOS.runStep(
        async (): Promise<Result<void, string>> => {
            const written = await write();
            if (written.isOk()) return ok(undefined);
            log.named(name).error("ledger write failed", { error: describeDbError(written.error), ...log.errorFields(written.error.cause) });
            return err(describeDbError(written.error));
        },
        { name },
    );
}

/**
 * Fire the optional run-lifecycle provenance observer, isolating a throwing
 * host observer from the workflow. The harness is host-agnostic and cannot
 * assume the callback is total; a defect in it must log loudly and be
 * swallowed, never corrupt run state — integrity enforcement lives at the
 * host's own ledger, not here.
 */
function emitProvenanceGuarded(deps: ExecuteAnalysisDeps, event: RunProvenanceEvent, session: RunSession): void {
    const emit = deps.provenance?.emitRunEvent;
    if (!emit) return;
    const logger = (deps.logger ?? createNoopLogger()).named("executeAnalysis");
    try {
        emit(event, session);
    } catch (err) {
        logger.error("the run emit of the provenance seam threw", { runId: event.runId, event: event.type, ...logger.errorFields(err) });
    }
}

/**
 * The scheduler's live per-step state, keyed by step id. Named so the observation builder and the
 * scheduler loop share one shape rather than restating the inline literal at each site.
 */
type StepRuntimeMap = Map<string, { status: StepRuntimeStatus; durationMs?: number; error?: string }>;

/**
 * Build the whole-run snapshot from the workflow input and the scheduler's live step state.
 *
 * Pure, so every emission point produces an identically-shaped payload from one place — a second
 * construction path is exactly how "a transition happened" acquires two definitions that drift.
 * The human `name` joins through `input.planStepById` because `input.steps` is the scheduler's
 * narrow `{id, depends_on}` projection and carries no plan vocabulary.
 */
function buildRunObservation(args: {
    input: ExecuteAnalysisInput;
    runId: string;
    status: ExecuteAnalysisFinalStatus;
    stepStates: StepRuntimeMap;
}): RunObservation {
    const { input, runId, status, stepStates } = args;
    return {
        runId,
        analysisId: input.analysisId,
        status,
        steps: input.steps.map((s) => {
            const rt = stepStates.get(s.id);
            return {
                id: s.id,
                name: input.planStepById[s.id]?.name ?? s.id,
                agent: input.agentByStepId[s.id] ?? "unknown",
                // A step absent from the map has not been reached yet; `pending` is its honest state.
                status: rt?.status ?? "pending",
                ...(rt?.durationMs !== undefined ? { durationMs: rt.durationMs } : {}),
                ...(rt?.error !== undefined ? { error: rt.error } : {}),
            };
        }),
    };
}

/**
 * Fire the optional run observer, isolating a throwing host callback from the workflow.
 *
 * Deliberately a sibling of {@link emitProvenanceGuarded} rather than a shared helper: the two
 * seams carry unrelated payloads and must stay independently removable, and one shared guard would
 * have to pick a single logger namespace, making it lie about whichever seam it is not named for.
 */
function observeRunGuarded(deps: ExecuteAnalysisDeps, observation: RunObservation): void {
    if (!deps.observeRun) return;
    const logger = (deps.logger ?? createNoopLogger()).named("executeAnalysis.observe");
    try {
        deps.observeRun(observation);
    } catch (err) {
        logger.error("observeRun threw", { runId: observation.runId, status: observation.status, ...logger.errorFields(err) });
    }
}

/**
 * Project the sandbox-step input handed to each child. The parent owns the
 * level computation and the seed (`prompt`, composed by `composeStepSeed` at
 * dispatch); the rest comes from `ExecuteAnalysisInput`. The body fills in
 * `runSession` via `forStep` after this returns. Exported for the
 * projection/timeout-propagation tests.
 */
export function buildChildInput(args: {
    input: ExecuteAnalysisInput;
    stepId: string;
    level: number;
    runId: string;
    workflowId: string;
    prompt: string;
}): Omit<SandboxStepInput, "runSession"> {
    const { input, stepId, level, runId, workflowId, prompt } = args;
    const resources = input.resourcesByStepId[stepId];
    if (!resources) {
        throw new Error(`executeAnalysis: step "${stepId}" missing from resourcesByStepId — every step must declare resources`);
    }
    const planStep = input.planStepById[stepId];
    if (!planStep) {
        throw new Error(`executeAnalysis: step "${stepId}" missing from planStepById — every step must carry its plan data`);
    }
    return {
        analysisId: input.analysisId,
        runId,
        stepId,
        agentId: input.agentByStepId[stepId] ?? "scientific-executor",
        // Carried into the child because lineage classification admits a same-run
        // sibling edge only when the sibling was declared here — the scheduler's
        // ordering guarantee attaches to this list and nothing else. Read from the
        // keyed plan snapshot rather than scanning `steps`, and thrown for rather
        // than defaulted: an empty list is indistinguishable from a step that
        // genuinely declared nothing, and it silently deletes every same-run edge
        // the step was entitled to.
        dependsOn: planStep.depends_on,
        level,
        prompt,
        parentWorkflowId: workflowId,
        resources,
        timeoutSeconds: input.timeoutByStepId?.[stepId],
    };
}

// ── Seed composition (at dispatch, not at plan submission) ────────────

/**
 * Compose one step's seed — the user-content message its agent opens on.
 *
 * The composition point is the design: the scheduler calls this at the instant
 * it dispatches a step, which is the first instant at which every one of that
 * step's dependencies has *finished* and written its results down. A seed
 * rendered any earlier (at plan submission, say) cannot mention them, and the
 * agent is left to rediscover its own upstream.
 *
 * Everything read here is durable state written by an already-settled child
 * (`output/summary.md`, `cortex_artifacts`) or by the profiler
 * (`cortex_analysis_state`) — never live in-flight state, which would not
 * reproduce.
 *
 * REPLAY: the caller wraps this in a `DBOS.runStep`, so the composed string is
 * checkpointed and a replay returns it verbatim — the DB and disk are not read
 * again and cannot drift the seed under a recovered run. Never call it
 * unwrapped from the workflow body.
 */
export async function composeStepSeed(args: { input: ExecuteAnalysisInput; stepId: string; runId: string; deps: ExecuteAnalysisDeps }): Promise<string> {
    const { input, stepId, runId, deps } = args;

    const step = input.planStepById[stepId];
    if (!step) {
        throw new Error(`executeAnalysis: step "${stepId}" missing from planStepById — every step must carry its plan data`);
    }

    const analysisId = input.analysisId;
    const workspaceRoot = deps.resolveWorkspaceRoot(analysisId);
    // The paths the agent actually sees: the tree is bind-mounted at
    // `/{analysisId}`, and the step's writable directory is its cwd. Derived
    // through the same helpers the sandbox mount and the mutate tools use, so
    // the seed cannot disagree with the container about where anything is.
    const workspace = {
        analysisId,
        workingDir: toSandboxPath(workspaceRoot, analysisId, stepWritePrefix({ workspaceRoot, runId, stepId })),
    };

    // A DB failure here throws (house rules): a swallowed error would be frozen
    // into the checkpointed seed and served to every replay of this step.
    const profile = unwrapOrThrow(await loadDataProfileStatus(deps.pool, analysisId));

    const upstream = await collectUpstreamHandoffs({
        analysisId,
        runId,
        workspaceRoot,
        dependsOn: step.depends_on,
        agentByStepId: input.agentByStepId,
        pool: deps.pool,
    });

    return composeStepBriefing({
        step,
        workspace,
        profile: profile?.result ?? null,
        upstream,
    });
}

/**
 * Gather what each completed dependency produced. Dependency order is the
 * plan's declared `depends_on` order — deterministic, so the seed is stable.
 *
 * A dependency that wrote no summary is omitted rather than blocking the
 * dispatch (`loadStepSummariesFromDisk` skips a missing file): a step that
 * completed without a summary has nothing to hand off, and waiting for one that
 * will never arrive would deadlock the run.
 */
async function collectUpstreamHandoffs(args: {
    analysisId: string;
    runId: string;
    workspaceRoot: string;
    dependsOn: readonly string[];
    agentByStepId: Readonly<Record<string, string>>;
    pool: Pool;
}): Promise<UpstreamHandoff[]> {
    const { analysisId, runId, workspaceRoot, dependsOn, agentByStepId, pool } = args;
    if (dependsOn.length === 0) return [];

    const summaries = await loadStepSummariesFromDisk({
        workspaceRoot,
        runId,
        completedSteps: dependsOn,
        agentByStepId,
    });

    const handoffs: UpstreamHandoff[] = [];
    for (const summary of summaries) {
        const outputDir = stepSubdir(runStepDir(runId, summary.stepId), "output");
        const artifacts = await queryStepArtifactPaths(pool, analysisId, runId, summary.stepId, MAX_UPSTREAM_ARTIFACTS);
        handoffs.push({
            stepId: summary.stepId,
            agentId: summary.agentId,
            summaryMarkdown: summary.markdown,
            summaryPath: `/${analysisId}/${outputDir}/summary.md`,
            outputDir: `/${analysisId}/${outputDir}`,
            artifacts: artifacts.map((a) => `/${analysisId}/${a.path}`),
        });
    }
    return handoffs;
}

/**
 * Project a classified synthesis outcome onto the run-phase `synthesis` ledger
 * row's terminal update (see the run-synthesis-outcome spec). The blocker keeps
 * its reason in `blockedReason` — an honest agent-declared blocker, not an
 * error — and a failure carries the same reason string
 * `persist-synthesis-outcome` writes to `cortex_runs.synthesis_reason`, so the
 * two ledgers cannot disagree about why synthesis died. A suspension is not an
 * outcome: the row is canceled with the reason of the host, as the row of a
 * suspended step. Exported for the projection tests (the `buildChildInput`
 * pattern).
 */
export function synthesisRowUpdate(outcome: { status: SynthesisStatus; reason: string | null } | Suspension, durationMs: number): UpdateStepExecutionInput {
    if ("kind" in outcome) return { status: "canceled", durationMs, error: outcome.reason };
    switch (outcome.status) {
        case "produced":
            return { status: "completed", durationMs };
        case "skipped_no_summaries":
            return { status: "skipped", durationMs };
        case "skipped_blocker":
            return { status: "blocked", durationMs, blockedReason: outcome.reason };
        case "failed":
            return { status: "failed", durationMs, error: outcome.reason };
        default: {
            const _exhaustive: never = outcome.status;
            throw new Error(`unhandled synthesis status: ${String(_exhaustive)}`);
        }
    }
}

/**
 * Run-level literature-grounded synthesis (no sandbox). Returns the
 * quick-display findings for the run-completed card; empty when synthesis is
 * skipped or produced no synthesizable content. A genuine failure re-throws
 * inside the caller's `DBOS.runStep`, failing the run (D10). Exported so
 * integration tests can drive the wired synthesis without a full parent body.
 */
export function synthesizeFindings(args: {
    analysisId: string;
    runId: string;
    completedSteps: readonly string[];
    session: RunSession;
    deps: ExecuteAnalysisDeps;
}): Promise<{ findings: readonly RunFinding[]; synthesisStatus: Exclude<SynthesisStatus, "failed">; synthesisReason: string | null }> {
    const { analysisId, runId, completedSteps, session, deps } = args;
    const emit: EmitFn = (event) => {
        const part = isChatDataPart(event)
            ? event
            : {
                  type: "data-loop-event" as const,
                  data: { stepId: "synthesis", event },
              };
        return DBOS.writeStream("events", part);
    };
    return synthesizeRun(
        {
            logger: deps.logger,
            pool: deps.pool,
            provider: deps.provider,
            embedding: deps.embedding,
            resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
            synthesisModel: deps.synthesisModel,
            bioKeys: deps.bioKeys,
            citationResolver: deps.citationResolver,
            usageRecorder: deps.usageRecorder,
        },
        {
            analysisId,
            runId,
            completedSteps,
            // Stepped, exactly as a sandbox step's child input is. Synthesis owns a real row in the
            // step-execution ledger (seeded and updated under `SYNTHESIS_STEP_ID` in the body below),
            // so it lists as a step everywhere a run's steps are shown. Handing it the bare run session
            // left every call it makes — the synthesizer loop and each sub-agent it dispatches —
            // recorded against the run carrying no `stepId`, which made the one step in the list unable
            // to report a figure the one that had just spent the most.
            //
            // It also puts the step id into the replay-stable `recordKey`, which is what it is for:
            // synthesis and a plan step of the same run can no longer mint the same key from the same
            // call path.
            session: forStep(session, SYNTHESIS_STEP_ID),
            emit,
            onProgress: (phase, activity, extra = {}) =>
                DBOS.writeStream("events", {
                    type: "data-synthesis-progress",
                    id: `synthesis-progress-${runId}`,
                    runId,
                    phase,
                    activity,
                    ...extra,
                }),
        },
    );
}

// ── Workflow registration ────────────────────────────────────────────

/**
 * Register the executeAnalysis parent workflow with DBOS. Caller is
 * responsible for setting `workflowID = runId` via
 * `DBOS.startWorkflow(_, { workflowID })` — the body assumes that contract
 * and uses `DBOS.workflowID` as the source of truth.
 */
export function registerExecuteAnalysis(deps: ExecuteAnalysisDeps): (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult> {
    return DBOS.registerWorkflow(
        async (input: ExecuteAnalysisInput): Promise<ExecuteAnalysisResult> => {
            return runExecuteAnalysisBody(input, deps);
        },
        { name: "executeAnalysis" },
    );
}

/**
 * Body extracted so tests can drive it without registering a workflow
 * (the DBOS calls inside still rely on a workflow context being present).
 */
export async function runExecuteAnalysisBody(input: ExecuteAnalysisInput, deps: ExecuteAnalysisDeps): Promise<ExecuteAnalysisResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("executeAnalysis").with({ analysisId: input.analysisId });
    // (0) Validate up-front — no side effects yet, so a malformed plan does
    // NOT leak a runId, run authorization, or running charge.
    validatePlanDag(input.steps);
    const levels = computeTopologicalLevels(input.steps);

    // (1) validateAndInit — create the run dir + open the charge. Inputs are
    // NOT materialized here: the embedder must have populated the workspace tree's
    // `data/` before triggering (the workflow neither downloads nor stages). The
    // `cortex_runs` row was inserted by `executePlan` at the async edge;
    // the run authorization is already minted and rides in `input.runSession`.
    const runId = input.runSession.runFrame.runId;
    const workflowId = runId;
    const init = await validateAndInit(input, runId, deps);
    if (init.kind === "joined-existing") {
        return {
            runId: init.runId,
            workflowId: init.runId,
            status: "running",
            completedSteps: [],
            failedSteps: [],
            canceledSteps: [],
        };
    }
    if (init.kind === "charge-refused") {
        // The charge gate refused the run, thus no step starts. The terminal block
        // still writes the terminal state, with the reason of the host: a failed
        // run, or a suspended one when the host set the suspend flag.
        const suspension = suspensionOfRefusal(init.refusal) ?? null;
        const refusedAtMs = await DBOS.now();
        const refused = await collectAndComplete({
            input,
            runId,
            workflowId,
            startedAtMs: refusedAtMs,
            completed: new Set(),
            failed: new Set(),
            canceled: new Set(),
            suspension,
            failureReason: init.refusal.reason,
            forceFailed: suspension === null,
            findings: [],
            synthesisOutcome: null,
            deps,
        });
        observeRunGuarded(deps, buildRunObservation({ input, runId, status: refused.status, stepStates: new Map() }));
        if (suspension !== null) return cancelSelf("self-cancel-suspended");
        return refused;
    }

    // Seed the full DAG as `pending` rows so ledger readers see every step from
    // run start (honest done/total), not just the ones that began executing.
    // The seed's DO NOTHING conflict action makes this replay-safe; the agent
    // fallback mirrors `buildChildInput` so seed and mark-running agree on the
    // row a step's child later upserts.
    //
    // The run-phase `synthesis` row is seeded alongside the DAG — gated on
    // enablement ONLY, because the other half of the run gate for actually
    // executing synthesis (`final.completed.size > 0`) is unknowable until the
    // scheduler returns. A seeded row whose gate later fails simply stays
    // `pending` and the terminal sweep finalizes it to `skipped` — honest
    // ("never ran, never will"), like any never-dispatched DAG step. Its wave
    // sits after every DAG level so ledger-ordered readers render it last.
    const synthesisEnabled = input.synthesisEnabled ?? true;
    const synthesisWave = Math.max(-1, ...levels.values()) + 1;
    await DBOS.runStep(
        async () => {
            const dagRows = input.steps.map((step) => ({
                runId,
                stepId: step.id,
                analysisId: input.analysisId,
                wave: levels.get(step.id) ?? 0,
                agentId: input.agentByStepId[step.id] ?? "scientific-executor",
            }));
            const synthesisRow = {
                runId,
                stepId: SYNTHESIS_STEP_ID,
                analysisId: input.analysisId,
                wave: synthesisWave,
                agentId: SYNTHESIS_AGENT_ID,
            };
            unwrapOrThrow(await seedStepExecutions(deps.pool, synthesisEnabled ? [...dagRows, synthesisRow] : dagRows));
        },
        { name: "seed-step-executions" },
    );

    // One checkpointed clock read stamps the run's start; the terminal read in
    // `collectAndComplete` subtracts it for the true run span. Checkpointed →
    // replay-stable (see `RunProvenanceEvent`).
    const startedAtMs = await DBOS.now();

    await emitStreamPart({
        type: "data-run-started",
        runId,
        planSummary: input.planSummary,
        stepCount: input.steps.length,
    });
    emitProvenanceGuarded(
        deps,
        {
            type: "run_started",
            analysisId: input.analysisId,
            runId,
            planSummary: input.planSummary,
            stepCount: input.steps.length,
            atMs: startedAtMs,
        },
        input.runSession,
    );
    // Opening snapshot: every step pending. The scheduler's own map does not exist yet, and an
    // empty one yields exactly that — so a host has the run's full shape before the first dispatch
    // rather than learning the step list from whichever transition happens to land first.
    observeRunGuarded(deps, buildRunObservation({ input, runId, status: "running", stepStates: new Map() }));

    // (2-4) Scheduler loop + failure isolation + pause cascade.
    const final = await runSchedulerLoop({
        input,
        runId,
        workflowId,
        levels,
        deps,
    });

    // (5) Run-level synthesis — a genuine failure must fail the run (D10). The
    // honest non-fatal outcomes (report_blocker / no-summaries) resolve normally
    // inside the dep; only real exceptions reach here. We capture the error,
    // still run the terminal block (close charge + revoke run authorization), and re-throw
    // after so the workflow record goes to ERROR.
    let synthesisError: unknown = null;
    // A `suspend` error of a synthesis model request. The run is a durable owner,
    // thus it suspends in place of a failure, the same as for a step.
    let synthesisSuspension: Suspension | null = null;
    let synthesisFindings: readonly RunFinding[] = [];
    // Null when synthesis never ran (disabled or no completed steps): the ledger
    // columns stay NULL — "unknown", not a recorded skip — and the seeded
    // `synthesis` row (if any) stays `pending` for the terminal sweep. Also null
    // when synthesis suspended: a resume of the run gives the outcome.
    let synthesisOutcome: { status: SynthesisStatus; reason: string | null } | null = null;
    if (synthesisEnabled && final.completed.size > 0) {
        // Bracketing clock reads for the row's duration_ms — checkpointed, so a
        // recovered replay reuses the original instants (same rule as `startedAtMs`).
        const synthStartedAtMs = await DBOS.now();
        // Mark the seeded `synthesis` row running. The same upsert the DAG children
        // use: it stamps started_at, and it creates the row outright if a legacy
        // persisted input did not seed it. Log-don't-fail: a progress row must never fail an
        // otherwise-healthy run.
        await ledgerStep(logger.with({ runId }), "mark-synthesis-running", () =>
            insertStepExecution(deps.pool, {
                runId,
                stepId: SYNTHESIS_STEP_ID,
                analysisId: input.analysisId,
                wave: synthesisWave,
                agentId: SYNTHESIS_AGENT_ID,
                childWorkflowId: null,
            }),
        );
        // The terminal state of the `synthesis` row: the outcome, or the suspension.
        let rowOutcome: { status: SynthesisStatus; reason: string | null } | Suspension;
        try {
            const synthOut = await DBOS.runStep(
                () =>
                    synthesizeFindings({
                        analysisId: input.analysisId,
                        runId,
                        completedSteps: [...final.completed],
                        session: input.runSession,
                        deps,
                    }),
                { name: "synthesize-findings" },
            );
            synthesisFindings = synthOut.findings;
            synthesisOutcome = { status: synthOut.synthesisStatus, reason: synthOut.synthesisReason };
            rowOutcome = synthesisOutcome;
        } catch (err) {
            // Cancellation is not a synthesis outcome: re-propagate unchanged (the
            // sandbox-step rule), so a cancelled workflow is never recorded as a
            // synthesis failure — neither on the row nor in cortex_runs. The row is
            // deliberately left `running`: `collectAndComplete` never executes on
            // this path either, so the run row is equally non-terminal and the pair
            // stays consistent — the pre-existing cancelled-mid-flight wedge shape
            // `inflexa run` already detects via its DBOS-status cross-check.
            if (err instanceof DBOSErrors.DBOSWorkflowCancelledError) throw err;
            const suspended = suspensionOfFailure(err);
            if (suspended !== undefined) {
                synthesisSuspension = suspended;
                rowOutcome = suspended;
                logger.warn("synthesizeFindings suspended — suspending the run", { runId, reason: suspended.reason });
            } else {
                synthesisError = err;
                synthesisOutcome = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
                rowOutcome = synthesisOutcome;
                logger.error("synthesizeFindings failed — failing the run", { runId, ...logger.errorFields(err) });
            }
        }
        // Terminal stamp for the `synthesis` row — deliberately BEFORE
        // `collectAndComplete` writes the run row's terminal status, so no reader
        // can observe a terminal run beside a still-`running` synthesis row.
        // Log-don't-fail, like the sibling finalisation writes.
        const synthEndedAtMs = await DBOS.now();
        const rowUpdate = synthesisRowUpdate(rowOutcome, synthEndedAtMs - synthStartedAtMs);
        await ledgerStep(logger.with({ runId }), "persist-synthesis-step", async () => {
            const written = await updateStepExecution(deps.pool, runId, SYNTHESIS_STEP_ID, rowUpdate);
            // Recorded inside the step that writes the row, so a replayed body records nothing again.
            const outcome = stepOutcomeOf(rowUpdate.status);
            if (written.isOk() && outcome !== undefined)
                recordStepCompleted({ agentId: SYNTHESIS_AGENT_ID, status: outcome, durationMs: synthEndedAtMs - synthStartedAtMs });
            return written;
        });
    }

    // (6) collectAndComplete — terminal block. Runs on EVERY path. When synthesis
    // failed, force a failed terminal status so the charge/run-authorization close correctly
    // and the run row + stream report the failure before we re-throw.
    // The first suspension of the run: of a step, or else of the synthesis.
    const suspension = final.suspension ?? synthesisSuspension;
    const result = await collectAndComplete({
        input,
        runId,
        workflowId,
        startedAtMs,
        completed: final.completed,
        failed: final.failed,
        canceled: final.canceled,
        suspension,
        ...(final.usage ? { usage: final.usage } : {}),
        failureReason: synthesisError
            ? synthesisError instanceof Error
                ? `synthesis-failed: ${synthesisError.message}`
                : "synthesis-failed"
            : final.suspension === null && synthesisSuspension !== null
              ? synthesisSuspension.reason
              : final.failureReason,
        forceFailed: synthesisError !== null,
        findings: synthesisFindings,
        synthesisOutcome,
        deps,
    });

    // Terminal snapshot, fired here rather than inside `collectAndComplete` because this is the
    // first point where BOTH the derived final status and the scheduler's final step map are in
    // hand. It precedes the suspension self-cancel below on purpose: that branch raises out of the
    // body, so an observer placed after it would never see a suspended run's last state.
    observeRunGuarded(deps, buildRunObservation({ input, runId, status: result.status, stepStates: final.stepStates }));

    // Synthesis failure takes priority over the suspension cascade: a run whose
    // synthesis threw is definitively failed (ERROR), not a resumable
    // suspension. Only self-cancel when synthesis did not throw a failure.
    if (suspension !== null && synthesisError === null) return cancelSelf("self-cancel-suspended");

    // Re-throw after the terminal block so the workflow record goes to ERROR.
    if (synthesisError !== null) throw synthesisError;

    return result;
}

// ── (1) validateAndInit ───────────────────────────────────────────────

interface ValidateAndInitFresh {
    readonly kind: "fresh";
}

interface ValidateAndInitJoinedExisting {
    readonly kind: "joined-existing";
    readonly runId: string;
}

/** The `RunCharge.open` gate refused the run. */
interface ValidateAndInitChargeRefused {
    readonly kind: "charge-refused";
    readonly refusal: GateRefusal;
}

type ValidateAndInitResult = ValidateAndInitFresh | ValidateAndInitJoinedExisting | ValidateAndInitChargeRefused;

async function validateAndInit(input: ExecuteAnalysisInput, runId: string, deps: ExecuteAnalysisDeps): Promise<ValidateAndInitResult> {
    // The cortex_runs row already exists (inserted by `executePlan`). Sanity-
    // check that no other active run for the same plan won the race — the
    // partial-unique index would have rejected the insert if so, so this is
    // defense-in-depth only.
    const existing = unwrapOrThrow(await queryActiveRun(deps.pool, input.analysisId, input.planId));
    if (existing && existing.runId !== runId) {
        return { kind: "joined-existing", runId: existing.runId };
    }

    await DBOS.runStep(
        async () => {
            // A resolver throw here (unknown analysis, unresolvable root) fails the
            // step durably — exactly the contract the workspace-root-resolution spec
            // requires of failures inside DBOS bodies.
            await mkdir(join(deps.resolveWorkspaceRoot(input.analysisId), runDir(runId)), {
                recursive: true,
            });
        },
        { name: "init-run-filesystem" },
    );

    // A gate: the checkpoint holds the `Result`, thus a replay reads the same refusal.
    const opened = await DBOS.runStep(
        async () =>
            await passGate(
                "RunCharge.open",
                deps.runCharge.open({
                    analysisId: input.analysisId,
                    runId,
                    session: input.runSession,
                }),
            ),
        { name: "open-running-charge" },
    );
    if (opened.isErr()) return { kind: "charge-refused", refusal: opened.error };

    return { kind: "fresh" };
}

// ── (2-4) Scheduler loop ──────────────────────────────────────────────

interface SchedulerLoopArgs {
    readonly input: ExecuteAnalysisInput;
    readonly runId: string;
    readonly workflowId: string;
    readonly levels: ReadonlyMap<string, number>;
    readonly deps: ExecuteAnalysisDeps;
}

interface SchedulerLoopOutcome {
    readonly completed: Set<string>;
    readonly failed: Set<string>;
    readonly canceled: Set<string>;
    /** The first suspension of a child, or null when no child suspended. */
    readonly suspension: Suspension | null;
    readonly failureReason: string | null;
    /**
     * The scheduler's final per-step state, handed back so the terminal run observation is built
     * from the same map every mid-run snapshot used. Reconstructing it from the completed/failed/
     * canceled sets would be a second definition of step state — the one thing the single builder
     * exists to prevent, and the one most likely to disagree about `skipped`.
     */
    readonly stepStates: StepRuntimeMap;
    /**
     * The run's aggregate token usage — the sum of every settled child's own
     * rollup. Absent when no step reported one.
     */
    readonly usage?: TokenUsageRollup;
}

async function runSchedulerLoop(args: SchedulerLoopArgs): Promise<SchedulerLoopOutcome> {
    const { input, runId, workflowId, levels, deps } = args;

    const completed = new Set<string>();
    const failed = new Set<string>();
    const canceled = new Set<string>();
    const inFlight = new Map<string, { stepId: string; handle: WorkflowHandle<SandboxStepResult> }>();

    // The typed suspension of each child that sent one, by child workflow id. The
    // parent reads the kind of the message; the reason rides unread.
    const childSuspensions = new Map<string, ChildSuspended>();

    // Run-level usage aggregate, folded from the children's own durable results.
    // `getResult` IS the replay-safe source: a recovered parent reads back the
    // identical value from each child's workflow record, so the sum reproduces
    // exactly without a second channel. A child that settled by throwing carries
    // no result and therefore contributes nothing — same rule as its duration.
    const runUsage: AgentRunUsage = {};

    // Child workflow ids the parent itself cancelled (suspension / neverFits halt cascade). Their `getResult`
    // rejects with a DBOS cancellation error and lands in the settlement error branch — but the step was
    // CANCELED by us, not failed on its own merits. Keyed here (deterministic: `cancelInFlight` runs the
    // same way on a replay) so that branch records it as canceled everywhere, matching how a child that
    // returns a graceful `{status:"canceled"}` is already handled.
    const canceledByParent = new Set<string>();

    const stepRuntime: StepRuntimeMap = new Map();
    for (const step of input.steps) {
        stepRuntime.set(step.id, { status: "pending" });
    }

    // Reverse adjacency over the static plan — who depends on whom.
    const dependentsByStepId = new Map<string, string[]>();
    for (const step of input.steps) {
        for (const dep of step.depends_on) {
            const list = dependentsByStepId.get(dep);
            if (list) list.push(step.id);
            else dependentsByStepId.set(dep, [step.id]);
        }
    }

    /**
     * Mark every transitive dependent of a failed/blocked step `skipped` in the
     * dag snapshot: a failed step never enters `completed`, so its dependents
     * can never become dependency-satisfied and will never be dispatched.
     * Stream-only — ledger rows stay `pending` until the terminal sweep flips
     * them to `skipped`. Dependents of an unfinished step are necessarily
     * `pending` (never queued/running); an already-`skipped` one is not
     * re-walked.
     */
    const markDependentsSkipped = (failedStepId: string): void => {
        const stack = [...(dependentsByStepId.get(failedStepId) ?? [])];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (stepRuntime.get(id)!.status === "pending") {
                stepRuntime.set(id, { status: "skipped" });
                stack.push(...(dependentsByStepId.get(id) ?? []));
            }
        }
    };

    // Halts scheduling entirely — reserved for a suspension of a child and the
    // `neverFits` guard. An ordinary step failure does NOT set it: it dooms
    // only that step's transitive dependents.
    let halted = false;
    let suspension: Suspension | null = null;
    let failureReason: string | null = null;

    /** The first suspension halts the run with its reason; each one cancels what is still in flight. */
    const haltForSuspension = async (child: ChildSuspended): Promise<void> => {
        if (suspension === null) {
            suspension = { kind: "suspended", reason: child.reason };
            halted = true;
            failureReason = child.reason;
        }
        await cancelInFlight(inFlight, child.reason, canceledByParent);
    };

    const stepIndexById = new Map(input.steps.map((s, i) => [s.id, i] as const));

    const emitDagSnapshot = async (): Promise<void> => {
        await emitStreamPart({
            type: "data-dag-state",
            id: `dag-${runId}`,
            runId,
            steps: input.steps.map((s) => {
                const rt = stepRuntime.get(s.id)!;
                const entry: Record<string, unknown> = {
                    id: s.id,
                    // `input.steps` is the SCHEDULER's projection — `{id, depends_on}` and nothing
                    // else — so the human name has to be joined from the snapshotted plan step. A
                    // consumer reading `name` is reading it to say what the step is FOR, which the
                    // id (a `T{track}S{step}` slug) cannot answer. Falling back to the id keeps the
                    // field populated for a step missing from the snapshot rather than emitting an
                    // empty label; `planStepById` is complete by contract (dispatch throws on a
                    // miss), so the fallback is unreachable in practice.
                    name: input.planStepById[s.id]?.name ?? s.id,
                    agent: input.agentByStepId[s.id] ?? "unknown",
                    status: rt.status,
                    level: levels.get(s.id) ?? 0,
                    dependsOn: [...s.depends_on],
                };
                if (rt.durationMs !== undefined) entry.durationMs = rt.durationMs;
                if (rt.error !== undefined) entry.error = rt.error;
                // `artifactCount` and `summary` are declared on `DagStepState` and deliberately not
                // set: the parent holds neither at snapshot time, and a placeholder would make a
                // consumer's rendering confidently wrong rather than honestly incomplete.
                return entry;
            }),
        });
        // The host observer rides the DAG emission rather than getting its own instrumentation
        // points: these call sites already ARE the complete set of run-state transitions, and a
        // second set would drift from this one. Status is `running` here by construction — the
        // scheduler loop only emits while it is still scheduling; the terminal snapshot is fired by
        // the body once `collectAndComplete` has derived the final status.
        observeRunGuarded(deps, buildRunObservation({ input, runId, status: "running", stepStates: stepRuntime }));
    };

    const dbosParentId = DBOS.workflowID ?? workflowId;
    const dispatchReady = async (): Promise<void> => {
        if (halted) return;
        const inFlightStepIds = new Set([...inFlight.values()].map((h) => h.stepId));
        // A settled-but-not-completed step (failed / blocked / canceled) is not
        // in `completed` and not in flight, so `scheduleReady` would offer it
        // again — filter it out of the candidate list. This also stops its
        // declared resources from weighing against the budget: settled steps
        // hold no capacity.
        const candidates = input.steps.filter((s) => !failed.has(s.id) && !canceled.has(s.id));
        let admit: readonly string[];
        let queuedChanged = false;
        if (input.budget) {
            const scheduled = scheduleReady(candidates, completed, inFlightStepIds, {
                budget: input.budget,
                resourcesByStepId: input.resourcesByStepId,
            });
            if (scheduled.neverFits.length > 0) {
                // An over-budget step can never be admitted — plan-time validation
                // makes this unreachable for new plans; stored plans fail loudly
                // instead of waiting forever. The stored plan is invalid against
                // this machine, so the run halts outright — unlike an ordinary
                // step failure, which dooms only its dependents.
                for (const stepId of scheduled.neverFits) {
                    const r = input.resourcesByStepId[stepId];
                    const declared = r ? `${r.cpu} CPU / ${r.memoryGb} GB` : "undeclared";
                    failed.add(stepId);
                    stepRuntime.set(stepId, {
                        status: "failed",
                        error: `step resources (${declared}) exceed the machine budget (${input.budget.cpu} CPU / ${input.budget.memoryGb} GB)`,
                    });
                }
                halted = true;
                failureReason = `step "${scheduled.neverFits[0]}" exceeds the machine resource budget`;
                await cancelInFlight(inFlight, "fail_fast", canceledByParent);
                await emitDagSnapshot();
                return;
            }
            for (const stepId of scheduled.heldForCapacity) {
                if (stepRuntime.get(stepId)!.status !== "queued") {
                    stepRuntime.set(stepId, { status: "queued" });
                    queuedChanged = true;
                }
            }
            admit = scheduled.admit;
        } else {
            admit = scheduleReady(candidates, completed, inFlightStepIds);
        }
        if (admit.length === 0) {
            if (queuedChanged) await emitDagSnapshot();
            return;
        }
        for (const stepId of admit) {
            const idx = stepIndexById.get(stepId)!;
            const childWorkflowId = `${workflowId}-${idx}`;
            // Compose the seed HERE — the dependencies of `stepId` are all in
            // `completed`, so this is the first (and only) moment their results
            // can be named. Checkpointed so a replay re-dispatches the child
            // with a byte-identical prompt instead of re-reading the DB/disk.
            const seedStepName = `compose-step-seed:${stepId}`;
            const prompt = await DBOS.runStep(
                () => {
                    stableSpan(seedStepName, "compose-step-seed", { [ATTR_INFLEXA_STEP_ID]: stepId });
                    return composeStepSeed({ input, stepId, runId, deps });
                },
                { name: seedStepName },
            );
            const baseChildInput = buildChildInput({
                input,
                stepId,
                level: levels.get(stepId) ?? 0,
                runId,
                workflowId,
                prompt,
            });
            const childInput: SandboxStepInput = {
                ...baseChildInput,
                parentWorkflowId: dbosParentId,
                runSession: forStep(input.runSession, stepId),
            };
            const handle = (await DBOS.startWorkflow(deps.sandboxStepCallable, {
                workflowID: childWorkflowId,
            })(childInput)) as WorkflowHandle<SandboxStepResult>;
            inFlight.set(childWorkflowId, { stepId, handle });
            stepRuntime.set(stepId, { status: "running" });
        }
        await emitDagSnapshot();
    };

    await dispatchReady();

    while (inFlight.size > 0) {
        // `waitFirst` checkpoints the "who finished first" decision (see the harness-durable-runtime spec), so
        // the winning workflow id replays identically — unlike `Promise.race` over
        // `getResult`, whose uncheckpointed winner would reorder the downstream
        // function-ID-consuming ops and diverge the counter on replay.
        const winner = await DBOS.waitFirst([...inFlight.values()].map((e) => e.handle));
        const childId = winner.workflowID;
        const entry = inFlight.get(childId)!;
        inFlight.delete(childId);

        let settled:
            { childId: string; stepId: string; kind: "result"; result: SandboxStepResult } | { childId: string; stepId: string; kind: "error"; err: unknown };
        try {
            const result = await entry.handle.getResult();
            settled = { childId, stepId: entry.stepId, kind: "result", result };
        } catch (err) {
            settled = { childId, stepId: entry.stepId, kind: "error", err };
        }

        await drainChildSuspensions(childSuspensions);

        const childSuspension = childSuspensions.get(settled.childId);

        // Terminal step status + duration for the provenance emission below. Every
        // settlement branch assigns both, so the emission fires exactly once per
        // settled child with the mapped status.
        let stepStatus: "completed" | "failed" | "canceled";
        let stepDurationMs: number | undefined;

        if (settled.kind === "result") {
            const r = settled.result;
            addChatUsage(runUsage, r.usage);
            if (r.status === "complete") {
                completed.add(settled.stepId);
                stepRuntime.set(settled.stepId, {
                    status: "completed",
                    durationMs: r.durationMs ?? undefined,
                });
                stepStatus = "completed";
                stepDurationMs = r.durationMs ?? undefined;
                await emitDagSnapshot();
                await dispatchReady();
            } else if (r.status === "canceled") {
                canceled.add(settled.stepId);
                if (childSuspension !== undefined) await haltForSuspension(childSuspension);
                stepRuntime.set(settled.stepId, {
                    status: "failed",
                    durationMs: r.durationMs ?? undefined,
                    error: r.error ?? "canceled",
                });
                stepStatus = "canceled";
                stepDurationMs = r.durationMs ?? undefined;
                await emitDagSnapshot();
            } else {
                // failed or blocked — a blocker (see the harness-sandbox-agents spec)
                // is treated exactly like a failure: the step declared it cannot
                // deliver, so only its transitive dependents can never run. In-flight
                // siblings and independent ready steps continue; the dispatch round
                // below also lets a budget-held step claim the freed capacity.
                failed.add(settled.stepId);
                failureReason ??= r.error ?? (r.status === "blocked" ? "step_blocked" : "step_failed");
                stepRuntime.set(settled.stepId, {
                    status: "failed",
                    durationMs: r.durationMs ?? undefined,
                    error: r.error ?? (r.status === "blocked" ? "step_blocked" : "step_failed"),
                });
                markDependentsSkipped(settled.stepId);
                stepStatus = "failed";
                stepDurationMs = r.durationMs ?? undefined;
                await emitDagSnapshot();
                await dispatchReady();
            }
        } else if (canceledByParent.has(settled.childId)) {
            // The child threw because the PARENT cancelled it (suspension / neverFits halt cascade), not
            // because it failed on its own — its `getResult` rejects with a DBOS cancellation error.
            // Record it as canceled, mirroring the graceful `{status:"canceled"}` branch above so the
            // `canceled` set, the terminal result, and the `step_completed` provenance all agree. No
            // halt / cancel cascade here: the run is already halted (that is why this child was cancelled).
            canceled.add(settled.stepId);
            stepRuntime.set(settled.stepId, {
                // `stepRuntime` (the DAG snapshot) has no canceled tier; the graceful-cancel branch above
                // likewise renders canceled steps as "failed", so this stays consistent with it.
                status: "failed",
                error: settled.err instanceof Error ? settled.err.message : String(settled.err),
            });
            stepStatus = "canceled";
            stepDurationMs = undefined;
            await emitDagSnapshot();
        } else if (childSuspension !== undefined) {
            // The child suspended: it sent its typed suspension, then cancelled
            // itself, thus `getResult` rejects with a DBOS cancellation. The
            // suspension halts the run — the cascade is a decision of the host,
            // not a DAG one — and it dooms no dependent: the resumed run needs them.
            canceled.add(settled.stepId);
            await haltForSuspension(childSuspension);
            stepRuntime.set(settled.stepId, { status: "failed", error: childSuspension.reason });
            stepStatus = "canceled";
            stepDurationMs = undefined;
            await emitDagSnapshot();
        } else {
            // The child threw on its own (not a parent-driven cancel, not a
            // suspension). A throw is treated exactly like a step failure:
            // dependents doomed, siblings continue.
            failed.add(settled.stepId);
            failureReason ??= settled.err instanceof Error ? settled.err.message : String(settled.err);
            markDependentsSkipped(settled.stepId);
            stepRuntime.set(settled.stepId, {
                status: "failed",
                error: settled.err instanceof Error ? settled.err.message : String(settled.err),
            });
            stepStatus = "failed";
            // A child that settled by throwing carries no durable duration.
            stepDurationMs = undefined;
            await emitDagSnapshot();
            await dispatchReady();
        }

        // One `step_completed` provenance emission per settled child — this
        // settlement loop is the only site that observes every executed step.
        // Plain guarded call (NOT `DBOS.runStep`): body re-execution on recovery
        // must re-fire it, and the checkpointed `DBOS.now()` read keeps the
        // timestamp replay-stable. Never-dispatched steps reach no settlement, so
        // they emit nothing by design.
        const settledAtMs = await DBOS.now();
        emitProvenanceGuarded(
            deps,
            {
                type: "step_completed",
                analysisId: input.analysisId,
                runId,
                stepId: settled.stepId,
                status: stepStatus,
                ...(stepDurationMs !== undefined ? { durationMs: stepDurationMs } : {}),
                atMs: settledAtMs,
            },
            input.runSession,
        );
    }

    await drainChildSuspensions(childSuspensions);

    return {
        completed,
        failed,
        canceled,
        suspension,
        failureReason,
        stepStates: stepRuntime,
        ...(hasReportedUsage(runUsage) ? { usage: { ...runUsage } } : {}),
    };
}

/** Collect each typed suspension that a child sent, by child workflow id. The first one per child wins. */
async function drainChildSuspensions(suspensions: Map<string, ChildSuspended>): Promise<void> {
    while (true) {
        const msg = await DBOS.recv<ChildSuspended>(CHILD_SUSPENDED_TOPIC, 0);
        if (!msg) return;
        if (msg.kind === "suspended" && !suspensions.has(msg.childWorkflowId)) suspensions.set(msg.childWorkflowId, msg);
    }
}

/**
 * Cancel each in-flight child. `cause` labels the metric of each cancel:
 * `fail_fast` for the `neverFits` guard, or the reason of the host for a
 * suspension, unread.
 */
async function cancelInFlight(
    inFlight: ReadonlyMap<string, { stepId: string; handle: WorkflowHandle<SandboxStepResult> }>,
    cause: string,
    canceledByParent: Set<string>,
): Promise<void> {
    const ids = [...inFlight.keys()];
    // Record every id BEFORE the cancel so the settlement loop classifies the resulting
    // DBOS-cancellation rejection as canceled rather than failed (see `canceledByParent`).
    for (const childId of ids) canceledByParent.add(childId);
    await Promise.allSettled(ids.map((childId) => DBOS.cancelWorkflow(childId)));
    for (let i = 0; i < ids.length; i++) {
        recordCancelledChild({ cause });
    }
}

// ── (6) collectAndComplete ────────────────────────────────────────────

interface CollectAndCompleteArgs {
    readonly input: ExecuteAnalysisInput;
    readonly runId: string;
    readonly workflowId: string;
    /** `run_started` `atMs` (a `DBOS.now()` read) — subtracted for `run_completed.durationMs`. */
    readonly startedAtMs: number;
    readonly completed: ReadonlySet<string>;
    readonly failed: ReadonlySet<string>;
    readonly canceled: ReadonlySet<string>;
    /** The suspension of the run, with the reason of the host, or null when the run did not suspend. */
    readonly suspension: Suspension | null;
    readonly failureReason: string | null;
    /**
     * The run's aggregate token usage for the run-completed card. Absent when no
     * step reported a rollup.
     */
    readonly usage?: TokenUsageRollup;
    /** When true, override the derived status to "failed" (synthesis failure). */
    readonly forceFailed?: boolean;
    /** Quick-display findings from synthesis for the run-completed card. */
    readonly findings: readonly RunFinding[];
    /**
     * Classified synthesis outcome to record on the run ledger. Null when
     * synthesis never ran — the columns stay NULL ("unknown").
     */
    readonly synthesisOutcome: { status: SynthesisStatus; reason: string | null } | null;
    readonly deps: ExecuteAnalysisDeps;
}

async function collectAndComplete(args: CollectAndCompleteArgs): Promise<ExecuteAnalysisResult> {
    const { input, runId, workflowId, startedAtMs, completed, failed, canceled, suspension, failureReason, forceFailed, deps } = args;
    // The suspension branch: a forced failure (synthesis threw, or the charge gate
    // failed the run) is terminal and never a resumable suspension.
    const suspended = suspension !== null && !forceFailed ? suspension : null;
    const logger = (deps.logger ?? createNoopLogger()).named("executeAnalysis").with({ runId, analysisId: input.analysisId });

    const status = forceFailed
        ? "failed"
        : deriveFinalStatus({
              totalSteps: input.steps.length,
              completed,
              failed,
              canceled,
              suspended: suspended !== null,
          });

    const chargeOutcome: RunChargeOutcome =
        status === "completed" || status === "partial"
            ? { kind: "ok" }
            : status === "failed"
              ? { kind: "error" }
              : suspended !== null
                ? { kind: "suspended", reason: suspended.reason }
                : { kind: "canceled" };
    const revokeReason =
        status === "completed" || status === "partial"
            ? "workflow-completed"
            : status === "failed"
              ? "workflow-failed"
              : suspended !== null
                ? "workflow-suspended"
                : "workflow-canceled";

    // Terminal clock read + run-completion provenance, emitted BEFORE the `cortex_runs`
    // status write below — and thus before any of the terminal cleanup steps. The CLI
    // watches the run by POLLING that row (`run.ts` `waitForRunTerminal`) and shuts down
    // the instant it leaves `running`, flushing provenance and then `process.exit()`ing;
    // emitting the record only after the status write races that shutdown and can drop
    // the run's terminal provenance entirely. Emitting first makes the record dirty
    // (synchronously, via the bus) before the row can be observed terminal, so the CLI's
    // flush always captures it. Not step-wrapped — a DBOS recovery replay must re-fire it;
    // `DBOS.now()` is checkpointed, so the span stays replay-stable (see `RunProvenanceEvent`).
    // The duration measures from the `run_started` read threaded in as `startedAtMs`.
    const terminalAtMs = await DBOS.now();
    emitProvenanceGuarded(
        deps,
        {
            type: "run_completed",
            analysisId: input.analysisId,
            runId,
            status,
            atMs: terminalAtMs,
            durationMs: terminalAtMs - startedAtMs,
        },
        input.runSession,
    );

    await ledgerStep(logger.with({ status }), "persist-final-status", async () => {
        const written = await updateRunStatus(
            deps.pool,
            runId,
            status,
            failureReason ?? (status === "canceled" && suspended === null ? "external_cancel" : null),
        );
        if (written.isErr()) return written;
        // The outcome metrics ride inside the step that persists the terminal status: DBOS
        // caches the step, so a recovered body records nothing again. A step's own terminal
        // row already carried its metric; the residue counted here is every settled step
        // without one — a child the cancel cut before `mark-canceled` (the cancel check runs
        // before a step body), or one that died before `failStep`. The ledger read is kept
        // apart from the status write: a failed read costs the metrics, never the write.
        const stepRows = await queryStepsByRun(deps.pool, runId);
        if (stepRows.isErr()) logger.warn("run metrics: step ledger read failed, residual step outcomes skipped", { error: describeDbError(stepRows.error) });
        for (const row of stepRows.unwrapOr([])) {
            if (row.completedAt !== null) continue;
            if (canceled.has(row.stepId)) recordStepCompleted({ agentId: row.agentId, status: "canceled" });
            else if (failed.has(row.stepId)) recordStepCompleted({ agentId: row.agentId, status: "failed" });
        }
        recordRunCompleted({ workflow: "analysis", status, durationMs: terminalAtMs - startedAtMs });
        return written;
    });

    // Record the run's synthesis outcome AFTER the status write — a reader that
    // sees a terminal status then also sees whether (and why) synthesis ran. A
    // null outcome means synthesis never ran; leave the columns NULL ("unknown").
    // Log-don't-rollback, like the sibling terminal steps: a failed ledger note
    // must not undo an otherwise-complete run.
    const outcome = args.synthesisOutcome;
    if (outcome !== null) {
        await ledgerStep(logger.with({ synthesisStatus: outcome.status }), "persist-synthesis-outcome", () =>
            setRunSynthesisOutcome(deps.pool, runId, outcome.status, outcome.reason),
        );
    }

    // Sweep never-started steps to `skipped` — but ONLY on genuinely-terminal
    // paths. The gate is the BRANCH, not the written run status: the resumable
    // suspension below also writes "canceled", yet its pending rows must survive
    // for the resumed workflow to execute. Log-don't-rollback, like every other
    // finalisation step here.
    if (suspended === null) {
        await ledgerStep(logger, "sweep-pending-steps", () => sweepPendingStepExecutions(deps.pool, runId));
    }

    // The one function that marks the analysis as suspended, for each reason of
    // the host. A forced failure never reaches this branch.
    if (suspended !== null) {
        await ledgerStep(logger, "suspend-analysis", () => suspendAnalysisQuery(deps.pool, input.analysisId));
    }

    // A notice: a failed close is logged, and the terminal status stays.
    await DBOS.runStep(
        () =>
            deliverNotice(
                logger.with({ chargeOutcome: chargeOutcome.kind }),
                "RunCharge.close",
                deps.runCharge.close({
                    analysisId: input.analysisId,
                    runId,
                    outcome: chargeOutcome,
                    session: input.runSession,
                }),
            ),
        { name: "close-running-charge" },
    );

    // Revoke the run authorization for the terminal run state. Ownership
    // defaults to true for inputs persisted before the field existed (a
    // workflow recovered across this deploy) — those were always Cortex-owned.
    const authorization: RunAuthorization = {
        runSession: input.runSession,
        ownsMandate: input.ownsMandate ?? true, // oss-core-managed-ok
    };
    await DBOS.runStep(() => deliverNotice(logger.with({ revokeReason }), "RunAuthorizer.revoke", deps.runAuthorizer.revoke(authorization, revokeReason)), {
        name: "revoke-run-auth",
    });

    // The `run_completed` provenance was already emitted above (before the status write, to
    // beat the CLI's poll-and-shutdown). These branches only fan out the UI stream part, whose
    // completed/failed shapes genuinely differ — the provenance record does not.
    if (status === "completed" || status === "partial") {
        // The count is a figure of the card: a failed read gives zero.
        const artifactCount = await DBOS.runStep(
            async () => await ResultAsync.fromPromise(countArtifactsForRun(deps.pool, input.analysisId, runId), () => "the artifact count failed").unwrapOr(0),
            { name: "count-run-artifacts" },
        );
        await emitStreamPart({
            type: "data-run-completed",
            runId,
            status,
            completedSteps: completed.size,
            totalSteps: input.steps.length,
            artifactCount,
            findings: args.findings.map((f) => ({
                title: f.title,
                confidence: f.confidence,
            })),
            ...(status === "partial"
                ? {
                      note: `${completed.size} of ${input.steps.length} steps completed; results are partial.`,
                  }
                : {}),
            ...(args.usage ? { usage: args.usage } : {}),
        });
    } else {
        await emitStreamPart({
            type: "data-run-failed",
            runId,
            error: failureReason ?? (suspended !== null ? suspended.reason : "Run canceled before completion"),
            ...(suspended !== null ? { reason: suspended.reason } : {}),
        });
    }

    return {
        runId,
        workflowId,
        status,
        completedSteps: [...completed],
        failedSteps: [...failed],
        canceledSteps: [...canceled],
    };
}

/**
 * `"running"` is excluded from the return: it is only the joined-existing
 * trigger outcome, never a settled terminal status. Narrowing it away here lets
 * the terminal `run_completed` provenance emission carry the terminal-only
 * status vocabulary without a cast.
 */
function deriveFinalStatus(args: {
    totalSteps: number;
    completed: ReadonlySet<string>;
    failed: ReadonlySet<string>;
    canceled: ReadonlySet<string>;
    suspended: boolean;
}): Exclude<ExecuteAnalysisFinalStatus, "running"> {
    const { totalSteps, completed, failed, canceled, suspended } = args;
    if (suspended) return "canceled";
    if (failed.size > 0) {
        return completed.size > 0 ? "partial" : "failed";
    }
    if (canceled.size > 0) return "canceled";
    return completed.size === totalSteps ? "completed" : "partial";
}
