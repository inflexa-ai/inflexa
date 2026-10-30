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
 *  4. Pause (work-pause spec)
 *     - a step pauses in its own workflow, and the parent waits for its result as
 *       for a step that runs. The other steps go on, and the run row stays
 *       `running`
 *     - a refusal of the `RunCharge.open` gate with the suspend flag pauses the
 *       run before any step starts, and the charge opens again after the resume
 *     - a failed model request of the synthesis with a cause of a pause waits in
 *       the loop of the synthesizer
 *  5. `synthesizeFindings` (single sequential block, no sandbox)
 *  6. `collectAndComplete` (terminal — runs on ALL paths)
 *     - determine final status from completed/cancelled/failed counts
 *     - update `cortex_runs.status` + `error`. When the write changes the row,
 *       the same step emits `run_completed` before the commit, records the run
 *       outcome metric plus the outcome of every settled step whose child never
 *       wrote its own terminal row (a cancelled child, or one that died before
 *       `failStep`), closes the running charge with the matching outcome, and
 *       revokes the run authorization through the injected `runAuthorizer`
 *     - the write retries with backoff on a failed transaction. When the write is
 *       refused, or fails on each attempt, close and revoke in their own steps, then
 *       emit `run_completed`. After a failed write the row stays `running`, so the
 *       body records its run end as a workflow event for the run canceler
 *     - emit terminal stream part
 *     - WRITES NOTHING to the conversation thread (results are pull-only
 *       via `inspectRun`)
 */

import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ScriptRuntime } from "../tools/script/run-script.js";
import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import { DBOS, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import { isWorkflowCancellation } from "../runtime/dbos.js";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Querier } from "../state/db.js";

import { forStep } from "../auth/types.js";
import type { RunSession } from "../auth/types.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import { RUN_END_EVENT_KEY, type RecordedRunEnd } from "../execution/run-end-record.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { deliverNotice, passGate, type GateRefusal } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { ATTR_INFLEXA_STEP_ID, stableSpan } from "../lib/otel-spans.js";
import { recordRunCompleted, recordStepCompleted, stepOutcomeOf } from "../lib/metrics.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import { describeDbError, withTransaction, type Connectable, type DbError } from "../lib/db-result.js";
import { unwrapOrThrow } from "../lib/result.js";
import {
    countArtifactsByRuns,
    insertStepExecution,
    loadDataProfileStatus,
    queryActiveRun,
    queryStepArtifactPaths,
    queryStepsByRun,
    seedStepExecutions,
    setRunSynthesisOutcome,
    sweepPendingStepExecutions,
    updateRunStatus,
    updateStepExecution,
} from "../state/index.js";
import type { SynthesisStatus, UpdateStepExecutionInput } from "../state/index.js";
import { addChatUsage, hasReportedUsage, type AgentRunUsage } from "../loop/metrics.js";
import { flattenDataPart } from "../contracts/chat-frame.js";
import type { RunCompletedPart, SynthesisPhase } from "../contracts/chat-parts.js";
import type { TokenUsageRollup } from "../contracts/usage.js";
import { SYNTHESIS_AGENT_ID, loadStepSummariesFromDisk } from "../execution/run-synthesis.js";
import {
    MAX_UPSTREAM_ARTIFACTS,
    composeStepBriefing,
    emptyStepMemory,
    type StepBriefing,
    type TemplateBoundSetting,
    type UpstreamHandoff,
} from "../prompts/briefing.js";
import type { WorkingMemoryStore } from "../memory/working-memory.js";
import type { AnalysisStep, GroundingSetting } from "../schemas/workflow-state.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { KnowledgeClient, KnowledgeRejected, KnowledgeUnavailable, TemplateContract, TemplateParameter } from "../tools/knowledge/client.js";
import type { TemplateBinding, TemplateBindingValue } from "../tools/knowledge/template.js";
import type { ProvenanceSeam, RunProvenanceEvent } from "../provenance/seam.js";
import type { ToolOutputStore } from "../loop/tool-output.js";
import { withoutToolValues } from "../loop/tool-value.js";
import type { Tool } from "../tools/define-tool.js";
import type { EmitFn } from "../loop/types.js";
import type { RunCharge, RunChargeOutcome } from "../billing/run-charge.js";
import { SYNTHESIS_STEP_ID, runDir, runStepDir, stepSubdir, stepWritePrefix, toSandboxPath, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { isChatDataPart, synthesisEmission } from "../sandbox/sandbox-step-translate.js";
import { synthesizeRun } from "../app/synthesize-run.js";
import { type PlanStep, computeTopologicalLevels, scheduleReady, validatePlanDag } from "./execute-analysis-scheduler.js";
import { pauseAtGate, workPause, type WorkPause } from "./pause.js";
import type { SandboxStepInput, SandboxStepResult } from "./sandbox-step.js";
import { presentGet } from "../lib/present.js";

/** Registered child sandbox-step callable the parent's child-dispatch closes over. */
type SandboxStepCallable = (input: SandboxStepInput) => Promise<SandboxStepResult>;

// ── Workflow input/output shapes ─────────────────────────────────────

/** Quick-display finding on the run-completed card. Mirrors the wire schema's RunCompletedFinding. */
export type RunFinding = {
    readonly title: string;
    readonly confidence: "high" | "medium" | "low";
};

export type ExecuteAnalysisInput = {
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
    /** The request that the plan answers, which the seed of each step renders. Absent when the plan stores none. */
    readonly request?: string;
    /** Per-step agent id (sandbox catalog entry). */
    readonly agentByStepId: Readonly<Record<string, string>>;
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
};

/**
 * Outcome of the trigger. `running` is what the dedup-collision recovery
 * path returns — the caller joined an in-flight run, no new workflow was
 * started. Every other variant is a terminal status the parent reached.
 */
export type ExecuteAnalysisFinalStatus = "running" | "completed" | "partial" | "failed" | "canceled";

export type ExecuteAnalysisResult = {
    readonly runId: string;
    readonly workflowId: string;
    readonly status: ExecuteAnalysisFinalStatus;
    readonly completedSteps: readonly string[];
    readonly failedSteps: readonly string[];
    readonly canceledSteps: readonly string[];
};

// ── Dep injection ─────────────────────────────────────────────────────

/**
 * A step's in-run display state. Wider than the ledger's `StepExecutionStatus`: `skipped` is asserted
 * mid-run for a doomed dependent whose ledger row stays `pending` until the terminal sweep.
 */
export type StepRuntimeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/**
 * One step's state inside a {@link RunObservation}. `id` is the plan slug the ledger and the
 * dependency edges use; `name` is the human phrase the plan author wrote, which is the only field
 * that says what the step is FOR. `durationMs` and `error` appear only once the step has settled
 * in a way that produced them.
 */
export type RunStepObservation = {
    readonly id: string;
    readonly name: string;
    readonly agent: string;
    readonly status: StepRuntimeStatus;
    readonly durationMs?: number;
    readonly error?: string;
};

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
export type RunObservation = {
    readonly runId: string;
    readonly analysisId: string;
    /** `running` for every mid-flight snapshot; the derived terminal status on the last one. */
    readonly status: ExecuteAnalysisFinalStatus;
    /** Every plan step, including ones that have not started — never a delta. */
    readonly steps: readonly RunStepObservation[];
};

/**
 * Construction-time deps for the parent workflow. The order-of-operations is
 * the body's own: it brackets the run, dispatches children, and synthesizes
 * directly via `DBOS.*` + the harness's helpers. Only the genuinely host-specific seams
 * stay injected — the run-charge bracket, run-authorization revoke, and the
 * registered sandbox-step callable — plus the construction inputs (provider,
 * embedder, model, keys, roots) the in-body synthesis needs.
 */
export type ExecuteAnalysisDeps = {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Querier & Connectable;
    /** Chat provider for the in-body literature-grounded synthesis. */
    readonly provider: ChatProvider;
    /** Write-side embedder for indexing the run synthesis. */
    readonly embedding: EmbeddingProvider;
    /** Registered child sandbox-step callable the body dispatches per step. */
    readonly sandboxStepCallable: SandboxStepCallable;
    /** Workspace-root resolution seam — run dir creation + synthesis disk reads. */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** The read path of the workspace. The synthesizer reads the files of the run through it. */
    readonly workspaceFs: WorkspaceFilesystem;
    /** Model id for the synthesizer agent loop. */
    readonly synthesisModel: string;
    /** The lookup tools of the synthesis (`createSynthesisLookupTools`). */
    readonly synthesisLookups: readonly Tool[];
    /** Where the VM of `run_script` comes from, for the lookups of the synthesizer. */
    readonly scriptRuntime?: ScriptRuntime;
    /** Run-level billing-bracket seam (managed: external bracket; OSS: no-op). */
    readonly runCharge: RunCharge;
    /** The delays of the timer of an outage. Absent: the default of the pause. */
    readonly pauseRetryDelaysMs?: readonly number[];
    /** Run-authorization seam — the terminal path revokes through `revoke`. */
    readonly runAuthorizer: RunAuthorizer;
    /** LLM usage-accounting seam for the in-body synthesizer loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The store of the loops of the run synthesis and of their read tools. */
    readonly toolOutputStore?: ToolOutputStore;
    /**
     * The working memory of the analysis. The body only reads it: each step seed
     * carries the goal and the constraints as they are at the dispatch of that step.
     */
    readonly workingMemory: WorkingMemoryStore;
    /**
     * The knowledge client of the composition, when the embedder binds one.
     * The seed composition reads the contract of the template a grounded step
     * renders through it, and binds the plan settings to that contract.
     * Absent, the seed says the contract was not retrieved, and the step agent
     * learns the slots from the render answers alone.
     */
    readonly knowledge?: KnowledgeClient;

    /**
     * The provenance seam of the composition. The body reads its run emit member,
     * and it reads no other member.
     *
     * `run_started` and `step_completed` are emitted directly in the workflow body
     * (NOT wrapped in `DBOS.runStep`) so that body re-execution on DBOS recovery
     * re-fires them — a cached step would suppress the recovery re-emission.
     * `run_completed` is emitted by the won `persist-final-status` step, or by the
     * body after that step when the step did not emit in this execution (a refused
     * or failed write, or a won step served from the DBOS cache), so a recovery
     * replay still fires it. Idempotency is the consumer's job, achieved via the
     * deterministic identifiers the events carry, not via step caching. Every call
     * site is guarded so a throwing observer never fails the run.
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
};

// ── In-body orchestration helpers ────────────────────────────────────

/** Emit a chat data part on the parent's DBOS stream. */
function emitStreamPart(part: unknown): Promise<void> {
    return DBOS.writeStream("events", part);
}

/**
 * A failed write rolls back no side effect that succeeded. The step body logs
 * its own failure and never throws. A DBOS exception passes through with no
 * change.
 */
async function ledgerStep(log: Logger, name: string, write: () => ResultAsync<unknown, DbError> | Promise<Result<unknown, DbError>>): Promise<void> {
    // typecheck-disable-next-line must-use-result -- a ledger miss must not fail the run
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
                durationMs: rt?.durationMs,
                error: rt?.error,
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
 * projection tests.
 */
export function buildChildInput(args: {
    input: ExecuteAnalysisInput;
    stepId: string;
    level: number;
    runId: string;
    prompt: string;
    templateBinding?: TemplateBinding;
}): Omit<SandboxStepInput, "runSession"> {
    const { input, stepId, level, runId, prompt, templateBinding } = args;
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
        // Composed beside the seed, thus the same checkpoint carries both and a
        // replay hands the child the binding its briefing describes.
        templateBinding,
        level,
        prompt,
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
 * The template contract of a grounded step is read with the package, and the
 * plan settings are bound to it: the seed describes the binding, and the child
 * input carries it, from one checkpoint. The child fetches nothing.
 *
 * REPLAY: the caller wraps this in a `DBOS.runStep`, so the composed seed is
 * checkpointed and a replay returns it verbatim — the DB, the disk, and the
 * knowledge service are not read again and cannot drift the seed under a
 * recovered run. Never call it unwrapped from the workflow body.
 */
export async function composeStepSeed(args: { input: ExecuteAnalysisInput; stepId: string; runId: string; deps: ExecuteAnalysisDeps }): Promise<StepSeed> {
    const { briefing, templateBinding } = await gatherStepPackage(args);
    return { prompt: composeStepBriefing(briefing), templateBinding };
}

/** What `gatherStepPackage` gives: the data of the seed, and the binding of the plan settings when one holds. */
export type StepPackage = {
    readonly briefing: StepBriefing;
    readonly templateBinding?: TemplateBinding;
};

/**
 * Do every read of one step's package and give the data its seed is rendered
 * from. All reads live here, so `composeStepBriefing` stays a pure renderer.
 *
 * Everything read is durable state: written by an already-settled child
 * (`output/summary.md`, `cortex_artifacts`), by the profiler
 * (`cortex_analysis_state`), or by the conversation agent
 * (`cortex_working_memory`). The working memory is the one read that can
 * change while the run is live — it is read per dispatch, not once per run,
 * so an edit during a run reaches each later step, and two steps of one run
 * can carry different copies.
 *
 * The contract of the template a grounded step renders is read here too, from
 * the knowledge client, and the plan settings are bound to it.
 *
 * A read failure throws (house rules): a swallowed error would be frozen into
 * the checkpointed seed and served to every replay of this step.
 */
export async function gatherStepPackage(args: { input: ExecuteAnalysisInput; stepId: string; runId: string; deps: ExecuteAnalysisDeps }): Promise<StepPackage> {
    const { input, stepId, runId, deps } = args;

    const step = input.planStepById[stepId];
    if (!step) {
        throw new Error(`executeAnalysis: step "${stepId}" missing from planStepById — every step must carry its plan data`);
    }

    const analysisId = input.analysisId;
    const workspaceRoot = await deps.resolveWorkspaceRoot(analysisId);
    // The paths the agent actually sees: the tree is bind-mounted at
    // `/{analysisId}`, and the step's writable directory is its cwd. Derived
    // through the same helpers the sandbox mount and the mutate tools use, so
    // the seed cannot disagree with the container about where anything is.
    const workspace = {
        analysisId,
        workingDir: toSandboxPath(workspaceRoot, analysisId, stepWritePrefix({ workspaceRoot, runId, stepId })),
    };

    const profile = unwrapOrThrow(await loadDataProfileStatus(deps.pool, analysisId));
    // A failed memory read leaves the section out: the step runs without the copy of the memory, not without a seed.
    const memoryRead = await deps.workingMemory.load(analysisId);
    if (memoryRead.isErr()) {
        const log = (deps.logger ?? createNoopLogger()).named("executeAnalysis.seed");
        log.warn("the working-memory read failed, thus the seed has no memory section", {
            analysisId,
            stepId,
            error: describeDbError(memoryRead.error),
            ...log.errorFields(memoryRead.error.cause),
        });
    }
    const memory = memoryRead.isOk() ? memoryRead.value : emptyStepMemory();

    const upstream = await collectUpstreamHandoffs({
        analysisId,
        runId,
        workspaceRoot,
        dependsOn: step.depends_on,
        agentByStepId: input.agentByStepId,
        pool: deps.pool,
    });

    const contract = await resolveTemplateContract(step, deps.knowledge);

    return {
        briefing: {
            step,
            workspace,
            profile: profile?.result ?? null,
            upstream,
            memory: { goal: memory.goal, constraints: memory.constraints },
            request: input.request,
            ...contract.briefing,
        },
        templateBinding: contract.binding,
    };
}

/**
 * What `composeStepSeed` checkpoints: the seed, and the binding of the plan
 * settings to the template of the step when the contract was retrieved and
 * its served version is the version the plan names. JSON-serialisable, as a
 * durable step result must be.
 */
export type StepSeed = {
    readonly prompt: string;
    readonly templateBinding?: TemplateBinding;
};

/** The template part of a seed: the brief or the reason for its absence, and the binding when one holds. */
type TemplateSeedPart = {
    readonly briefing: Pick<StepBriefing, "template" | "templateNotRetrieved">;
    readonly binding?: TemplateBinding;
};

/** A served contract carries no `match`; the two refusals do. */
function isTemplateContract(answer: TemplateContract | KnowledgeUnavailable | KnowledgeRejected): answer is TemplateContract {
    return !("match" in answer);
}

/**
 * Fetch the contract of the template a step grounds on, and bind the plan
 * settings to it. A step without a template has no template part. A step
 * with one and no way to read it (no client, no answer, or an unknown
 * template) gets the reason, thus the seed reports the absence rather than
 * hiding it, and no binding.
 */
async function resolveTemplateContract(step: AnalysisStep, client: KnowledgeClient | undefined): Promise<TemplateSeedPart> {
    const ref = step.grounding?.template;
    if (!ref) return { briefing: {} };
    if (!client) return { briefing: { templateNotRetrieved: "no knowledge client is bound" } };

    const answer = await client.contract(ref);
    if (!isTemplateContract(answer)) {
        const reason =
            answer.match === "unavailable"
                ? `the knowledge service did not answer: ${answer.reason}`
                : `the knowledge service refused the lookup: ${answer.message}`;
        return { briefing: { templateNotRetrieved: reason } };
    }
    return bindTemplateContract(ref, answer, step.grounding?.settings ?? [], {
        stepId: step.id,
        claims: step.grounding?.claims ?? [],
        snapshot: step.grounding?.snapshot && step.grounding.snapshot !== "none" ? step.grounding.snapshot : undefined,
    });
}

/** The version of a template reference (`tpl-x@1.0.0` gives `1.0.0`), or `undefined` when the reference has none. */
function versionOfRef(ref: string): string | undefined {
    const at = ref.indexOf("@");
    return at < 0 ? undefined : ref.slice(at + 1);
}

/** Two setting values agree when their JSON agrees: the values are scalars or lists of strings. */
function sameSettingValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether a plan value is a value of the slot, and not a policy word. A
 * procedure parameter and a template slot share a name, but not always a
 * value domain: `min_samples = smallest_group_size` names a rule the agent
 * applies, and the slot takes the resulting integer. Only a member of the
 * enum of the slot, a number for a number slot, or a boolean for a boolean
 * slot binds. A free-text slot never binds, because the host cannot tell a
 * policy word from a value there.
 */
function fitsSlot(slot: TemplateParameter, value: unknown): boolean {
    if (slot.enum) return typeof value === "string" && slot.enum.includes(value);
    if (slot.type === "integer" || slot.type === "number") return typeof value === "number";
    if (slot.type === "boolean") return typeof value === "boolean";
    return false;
}

/**
 * Project the served contract for the seed, and intersect the plan settings
 * with its slots by name. Each setting lands in exactly one place:
 *
 * - a setting that names an adaptable slot is bound (the first value wins
 *   when two procedure steps set the same slot; a later different value is
 *   reported, not bound)
 * - a setting that names a pinned slot cannot be sent: a different value is
 *   a pinned conflict the agent must know about, an equal value is satisfied
 * - a setting that names no slot stays a plan setting the agent applies itself
 *
 * A served version that differs from the version the plan names binds
 * nothing: the render refuses the plan version, and the settings then ride
 * as unbound lines under the caveat the section renders.
 */
/** What binds the render to the plan step beside the settings: its id, its claims, and the release the plan pinned. */
type StepGroundingRef = {
    readonly stepId: string;
    readonly claims: readonly string[];
    readonly snapshot?: string;
};

function bindTemplateContract(ref: string, contract: TemplateContract, settings: readonly GroundingSetting[], grounding: StepGroundingRef): TemplateSeedPart {
    const refVersion = versionOfRef(ref);
    const versionMatches = refVersion === undefined || refVersion === contract.version;
    const adaptable = contract.parameters.filter((slot) => slot.adaptable);
    const adaptableNames = new Set(adaptable.map((slot) => slot.name));
    const pinnedByName = new Map(contract.parameters.filter((slot) => !slot.adaptable).map((slot) => [slot.name, slot]));

    const bound: TemplateBoundSetting[] = [];
    const unbound: string[] = [];
    const slots: Record<string, TemplateBindingValue> = {};
    const sources: Record<string, string> = {};

    for (const setting of settings) {
        const shown = `\`${setting.name}\` = ${JSON.stringify(setting.value)} (${setting.step})`;
        if (!versionMatches) {
            unbound.push(`${shown}: not bound, because the served version differs from the plan`);
            continue;
        }
        if (adaptableNames.has(setting.name)) {
            const slot = adaptable.find((candidate) => candidate.name === setting.name);
            if (slot && !fitsSlot(slot, setting.value)) {
                unbound.push(`${shown}: a policy of the plan, not a value of the \`${setting.name}\` slot (${slot.type}); state the value it gives`);
                continue;
            }
            const prior = slots[setting.name];
            if (prior !== undefined) {
                if (!sameSettingValue(prior, setting.value)) unbound.push(`${shown}: differs from the bound value ${JSON.stringify(prior)} of the same slot`);
                continue;
            }
            slots[setting.name] = setting.value;
            if (setting.source) sources[setting.name] = setting.source;
            bound.push({ name: setting.name, value: setting.value, source: setting.source ?? "plan" });
            continue;
        }
        const pinned = pinnedByName.get(setting.name);
        if (pinned) {
            const pinnedValue = pinned.default === undefined ? "a fixed value" : JSON.stringify(pinned.default);
            unbound.push(
                sameSettingValue(pinned.default, setting.value)
                    ? `${shown}: pinned by the template at the same value`
                    : `${shown}: the template pins \`${setting.name}\` at ${pinnedValue}, and the plan value cannot be sent`,
            );
            continue;
        }
        unbound.push(`${shown}: no slot of the template carries it`);
    }

    return {
        briefing: {
            template: {
                ref,
                version_served: contract.version,
                slots: adaptable,
                inputs: (contract.inputs ?? []).map((input) => ({
                    name: input.name,
                    path: input.path,
                    description: input.description,
                })),
                bound,
                unbound_settings: unbound,
            },
        },
        binding: versionMatches
            ? {
                  template: ref,
                  slots,
                  sources,
                  step: grounding.stepId,
                  claims: grounding.claims,
                  snapshot: grounding.snapshot,
                  // The local slots of the contract, thus the tool binds a path or a column name on the machine
                  // without a second read of the contract.
                  local: contract.parameters.filter((slot) => slot.local === true),
                  adaptable: adaptable.map((slot) => slot.name),
              }
            : undefined,
    };
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
    pool: Querier & Connectable;
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
        const artifacts = unwrapOrThrow(await queryStepArtifactPaths(pool, analysisId, runId, summary.stepId, MAX_UPSTREAM_ARTIFACTS));
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
 * two ledgers cannot disagree about why synthesis died. Exported for the
 * projection tests (the `buildChildInput` pattern).
 */
export function synthesisRowUpdate(outcome: { status: SynthesisStatus; reason: string | null }, durationMs: number): UpdateStepExecutionInput {
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
 * skipped or produced no synthesizable content. A genuine failure re-throws,
 * failing the run (D10). It runs in the body of the run workflow: each read and
 * write is a step, each model call is a step, and each lookup call is a step.
 * Exported so integration tests can drive the wired synthesis
 * without a full parent body.
 */
export function synthesizeFindings(args: {
    analysisId: string;
    runId: string;
    completedSteps: readonly string[];
    session: RunSession;
    deps: ExecuteAnalysisDeps;
    /** The pause of the run. The body of the run gives it, thus the synthesizer waits in place. */
    pause?: WorkPause;
}): Promise<{ findings: readonly RunFinding[]; synthesisStatus: Exclude<SynthesisStatus, "failed">; synthesisReason: string | null }> {
    const { analysisId, runId, completedSteps, session, deps } = args;
    const logger = (deps.logger ?? createNoopLogger()).named("executeAnalysis.synthesis");
    // Observation is a diagnostic channel: a failed progress write is logged and never fails the synthesis.
    let progressSeq = 0;
    const writeProgressAlone = async (part: unknown, phase: SynthesisPhase): Promise<void> => {
        try {
            await DBOS.writeStream("events", part);
        } catch (err) {
            logger.warn("synthesis progress write failed (non-fatal)", { phase, ...logger.errorFields(err) });
        }
    };
    const emit: EmitFn = (event) => {
        const part = isChatDataPart(event)
            ? flattenDataPart(event)
            : {
                  type: "data-loop-event" as const,
                  data: { stepId: "synthesis", event: withoutToolValues(event) },
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
            workspaceFs: deps.workspaceFs,
            synthesisModel: deps.synthesisModel,
            synthesisLookups: deps.synthesisLookups,
            scriptRuntime: deps.scriptRuntime,
            usageRecorder: deps.usageRecorder,
            toolOutputStore: deps.toolOutputStore,
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
            pause: args.pause?.afterFailure,
            durably: (name, run) => DBOS.runStep(run, { name }),
            onProgress: async (phase, activity, extra = {}) => {
                // The body checkpoints the clock and each write, thus a replay writes no entry again.
                const seq = progressSeq++;
                const at = new Date(await DBOS.now()).toISOString();
                const parts = synthesisEmission(runId, SYNTHESIS_STEP_ID, seq, phase, activity, at, extra);
                await writeProgressAlone(parts.progress, phase);
                await writeProgressAlone(parts.entry, phase);
            },
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
    const pause = workPause({
        pool: deps.pool,
        workId: runId,
        workKind: "run",
        analysisId: input.analysisId,
        emit: emitStreamPart,
        retryDelaysMs: deps.pauseRetryDelaysMs,
        run: { session: input.runSession, authorizer: deps.runAuthorizer },
        logger,
    });
    const init = await validateAndInit(input, runId, deps, pause);
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
        const refusedAtMs = await DBOS.now();
        const refused = await collectAndComplete({
            input,
            runId,
            workflowId,
            startedAtMs: refusedAtMs,
            completed: new Set(),
            failed: new Set(),
            canceled: new Set(),
            failureReason: init.refusal.reason,
            forceFailed: true,
            findings: [],
            synthesisOutcome: null,
            deps,
        });
        observeRunGuarded(deps, buildRunObservation({ input, runId, status: refused.status, stepStates: new Map() }));
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
    let synthesisMessage: string | undefined;
    let synthesisFindings: readonly RunFinding[] = [];
    // Null when synthesis never ran (disabled or no completed steps): the ledger
    // columns stay NULL — "unknown", not a recorded skip — and the seeded
    // `synthesis` row (if any) stays `pending` for the terminal sweep.
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
        let rowOutcome: { status: SynthesisStatus; reason: string | null };
        try {
            const synthOut = await synthesizeFindings({
                analysisId: input.analysisId,
                runId,
                completedSteps: [...final.completed],
                session: input.runSession,
                deps,
                pause,
            });
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
            if (isWorkflowCancellation(err)) throw err;
            // A failure with a cause of a pause waited in the loop of the synthesizer, thus this one fails the run.
            synthesisError = err;
            synthesisMessage = errorMessageOf(err);
            synthesisOutcome = { status: "failed", reason: errorMessageOf(err) ?? textOf(err) };
            rowOutcome = synthesisOutcome;
            logger.error("synthesizeFindings failed — failing the run", { runId, ...logger.errorFields(err) });
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
    const result = await collectAndComplete({
        input,
        runId,
        workflowId,
        startedAtMs,
        completed: final.completed,
        failed: final.failed,
        canceled: final.canceled,
        usage: final.usage,
        failureReason:
            synthesisError === null ? final.failureReason : synthesisMessage === undefined ? "synthesis-failed" : `synthesis-failed: ${synthesisMessage}`,
        forceFailed: synthesisError !== null,
        findings: synthesisFindings,
        synthesisOutcome,
        deps,
    });

    // Terminal snapshot, fired here rather than inside `collectAndComplete` because this is the
    // first point where BOTH the derived final status and the scheduler's final step map are in
    // hand.
    observeRunGuarded(deps, buildRunObservation({ input, runId, status: result.status, stepStates: final.stepStates }));

    // Re-throw after the terminal block so the workflow record goes to ERROR.
    // oxlint-disable-next-line typescript/only-throw-error -- the caught synthesis failure rides as-is so the workflow record fails with the original cause; a wrapper would erase its identity.
    if (synthesisError !== null) throw synthesisError;

    return result;
}

// ── (1) validateAndInit ───────────────────────────────────────────────

type ValidateAndInitFresh = {
    readonly kind: "fresh";
};

type ValidateAndInitJoinedExisting = {
    readonly kind: "joined-existing";
    readonly runId: string;
};

type ValidateAndInitChargeRefused = {
    readonly kind: "charge-refused";
    readonly refusal: GateRefusal;
};

type ValidateAndInitResult = ValidateAndInitFresh | ValidateAndInitJoinedExisting | ValidateAndInitChargeRefused;

async function validateAndInit(input: ExecuteAnalysisInput, runId: string, deps: ExecuteAnalysisDeps, pause: WorkPause): Promise<ValidateAndInitResult> {
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
            // A resolver rejection here (unknown analysis, unresolvable root) fails the
            // step durably — exactly the contract the workspace-root-resolution spec
            // requires of failures inside DBOS bodies.
            await mkdir(join(await deps.resolveWorkspaceRoot(input.analysisId), runDir(runId)), {
                recursive: true,
            });
        },
        { name: "init-run-filesystem" },
    );

    const openCharge = (): Promise<Result<void, GateRefusal>> =>
        DBOS.runStep(
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
    let opened = await openCharge();
    // A refusal with the suspend flag waits in a pause, and the charge opens again after the resume.
    while (opened.isErr() && opened.error.kind === "suspended") {
        await pauseAtGate(pause, opened.error.reason);
        opened = await openCharge();
    }
    if (opened.isErr()) return { kind: "charge-refused", refusal: opened.error };

    return { kind: "fresh" };
}

// ── (2-4) Scheduler loop ──────────────────────────────────────────────

type SchedulerLoopArgs = {
    readonly input: ExecuteAnalysisInput;
    readonly runId: string;
    readonly workflowId: string;
    readonly levels: ReadonlyMap<string, number>;
    readonly deps: ExecuteAnalysisDeps;
};

type SchedulerLoopOutcome = {
    readonly completed: Set<string>;
    readonly failed: Set<string>;
    readonly canceled: Set<string>;
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
};

async function runSchedulerLoop(args: SchedulerLoopArgs): Promise<SchedulerLoopOutcome> {
    const { input, runId, workflowId, levels, deps } = args;

    const completed = new Set<string>();
    const failed = new Set<string>();
    const canceled = new Set<string>();
    const inFlight = new Map<string, { stepId: string; handle: WorkflowHandle<SandboxStepResult> }>();

    // Run-level usage aggregate, folded from the children's own durable results.
    // `getResult` IS the replay-safe source: a recovered parent reads back the
    // identical value from each child's workflow record, so the sum reproduces
    // exactly without a second channel. A child that settled by throwing carries
    // no result and therefore contributes nothing — same rule as its duration.
    const runUsage: AgentRunUsage = {};

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
     * `pending` (never running); an already-`skipped` one is not
     * re-walked.
     */
    const markDependentsSkipped = (failedStepId: string): void => {
        const stack = [...(dependentsByStepId.get(failedStepId) ?? [])];
        while (stack.length > 0) {
            const id = stack.pop();
            if (id === undefined) break;
            if (presentGet(stepRuntime, id, "the runtime of the step").status === "pending") {
                stepRuntime.set(id, { status: "skipped" });
                stack.push(...(dependentsByStepId.get(id) ?? []));
            }
        }
    };

    let failureReason: string | null = null;

    const stepIndexById = new Map(input.steps.map((s, i) => [s.id, i] as const));

    const emitDagSnapshot = async (): Promise<void> => {
        await emitStreamPart({
            type: "data-dag-state",
            id: `dag-${runId}`,
            runId,
            steps: input.steps.map((s) => {
                const rt = presentGet(stepRuntime, s.id, "the runtime of the step");
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

    const dispatchReady = async (): Promise<void> => {
        const inFlightStepIds = new Set([...inFlight.values()].map((h) => h.stepId));
        // A settled-but-not-completed step (failed / blocked / canceled) is not
        // in `completed` and not in flight, so `scheduleReady` would offer it
        // again — filter it out of the candidate list.
        const candidates = input.steps.filter((s) => !failed.has(s.id) && !canceled.has(s.id));
        const admit = scheduleReady(candidates, completed, inFlightStepIds);
        if (admit.length === 0) return;
        for (const stepId of admit) {
            const idx = presentGet(stepIndexById, stepId, "the index of the step");
            const childWorkflowId = `${workflowId}-${idx}`;
            // Compose the seed HERE — the dependencies of `stepId` are all in
            // `completed`, so this is the first (and only) moment their results
            // can be named. Checkpointed so a replay re-dispatches the child
            // with a byte-identical prompt instead of re-reading the DB/disk.
            const seedStepName = `compose-step-seed:${stepId}`;
            const checkpointed: StepSeed | string = await DBOS.runStep(
                () => {
                    stableSpan(seedStepName, "compose-step-seed", { [ATTR_INFLEXA_STEP_ID]: stepId });
                    return composeStepSeed({ input, stepId, runId, deps });
                },
                { name: seedStepName },
            );
            // A run recovered from a checkpoint written when this step returned the
            // bare seed string replays that string: it carries no binding.
            const seed: StepSeed = typeof checkpointed === "string" ? { prompt: checkpointed } : checkpointed;
            const baseChildInput = buildChildInput({
                input,
                stepId,
                level: levels.get(stepId) ?? 0,
                runId,
                prompt: seed.prompt,
                templateBinding: seed.templateBinding,
            });
            const childInput: SandboxStepInput = {
                ...baseChildInput,
                runSession: forStep(input.runSession, stepId),
            };
            const handle = await DBOS.startWorkflow(deps.sandboxStepCallable, {
                workflowID: childWorkflowId,
            })(childInput);
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
        const entry = presentGet(inFlight, childId, "the in-flight entry of the winning child");
        inFlight.delete(childId);

        let settled:
            { childId: string; stepId: string; kind: "result"; result: SandboxStepResult } | { childId: string; stepId: string; kind: "error"; err: unknown };
        try {
            const result = await entry.handle.getResult();
            settled = { childId, stepId: entry.stepId, kind: "result", result };
        } catch (err) {
            settled = { childId, stepId: entry.stepId, kind: "error", err };
        }

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
                    durationMs: r.durationMs,
                });
                stepStatus = "completed";
                stepDurationMs = r.durationMs;
                await emitDagSnapshot();
                await dispatchReady();
            } else if (r.status === "canceled") {
                canceled.add(settled.stepId);
                stepRuntime.set(settled.stepId, {
                    status: "failed",
                    durationMs: r.durationMs,
                    error: r.error ?? "canceled",
                });
                stepStatus = "canceled";
                stepDurationMs = r.durationMs;
                await emitDagSnapshot();
            } else {
                // failed or blocked — a blocker (see the harness-sandbox-agents spec)
                // is treated exactly like a failure: the step declared it cannot
                // deliver, so only its transitive dependents can never run. In-flight
                // siblings and independent ready steps continue.
                failed.add(settled.stepId);
                failureReason ??= r.error ?? (r.status === "blocked" ? "step_blocked" : "step_failed");
                stepRuntime.set(settled.stepId, {
                    status: "failed",
                    durationMs: r.durationMs,
                    error: r.error ?? (r.status === "blocked" ? "step_blocked" : "step_failed"),
                });
                markDependentsSkipped(settled.stepId);
                stepStatus = "failed";
                stepDurationMs = r.durationMs;
                await emitDagSnapshot();
                await dispatchReady();
            }
        } else {
            // The child threw. A throw is treated exactly like a step failure:
            // dependents doomed, siblings continue.
            failed.add(settled.stepId);
            failureReason ??= errorMessageOf(settled.err) ?? textOf(settled.err);
            markDependentsSkipped(settled.stepId);
            stepRuntime.set(settled.stepId, {
                status: "failed",
                error: errorMessageOf(settled.err) ?? textOf(settled.err),
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
                durationMs: stepDurationMs,
                atMs: settledAtMs,
            },
            input.runSession,
        );
    }

    return {
        completed,
        failed,
        canceled,
        failureReason,
        stepStates: stepRuntime,
        usage: hasReportedUsage(runUsage) ? { ...runUsage } : undefined,
    };
}

// ── (6) collectAndComplete ────────────────────────────────────────────

/** The waits between the attempts are 1, 2, 4, and 8 seconds. */
const FINAL_STATUS_WRITE_RETRY = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1, backoffRate: 2 } as const;

type CollectAndCompleteArgs = {
    readonly input: ExecuteAnalysisInput;
    readonly runId: string;
    readonly workflowId: string;
    /** `run_started` `atMs` (a `DBOS.now()` read) — subtracted for `run_completed.durationMs`. */
    readonly startedAtMs: number;
    readonly completed: ReadonlySet<string>;
    readonly failed: ReadonlySet<string>;
    readonly canceled: ReadonlySet<string>;
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
};

async function collectAndComplete(args: CollectAndCompleteArgs): Promise<ExecuteAnalysisResult> {
    const { input, runId, workflowId, startedAtMs, completed, failed, canceled, failureReason, forceFailed, deps } = args;
    const logger = (deps.logger ?? createNoopLogger()).named("executeAnalysis").with({ runId, analysisId: input.analysisId });

    const status = forceFailed
        ? "failed"
        : deriveFinalStatus({
              totalSteps: input.steps.length,
              completed,
              failed,
              canceled,
          });

    const chargeOutcome: RunChargeOutcome =
        status === "completed" || status === "partial" ? { kind: "ok" } : status === "failed" ? { kind: "error" } : { kind: "canceled" };
    const revokeReason = status === "completed" || status === "partial" ? "workflow-completed" : status === "failed" ? "workflow-failed" : "workflow-canceled";

    const finalError = failureReason ?? (status === "canceled" ? "external_cancel" : null);

    const terminalAtMs = await DBOS.now();
    const emitRunEnd = (): void =>
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

    const closeCharge = (): Promise<boolean> =>
        deliverNotice(
            logger.with({ chargeOutcome: chargeOutcome.kind }),
            "RunCharge.close",
            deps.runCharge.close({
                analysisId: input.analysisId,
                runId,
                outcome: chargeOutcome,
                session: input.runSession,
            }),
        );
    const revokeAuthorization = (): Promise<boolean> =>
        deliverNotice(logger.with({ revokeReason }), "RunAuthorizer.revoke", deps.runAuthorizer.revoke(input.runSession, revokeReason));

    // The writer that wins the row owns the run end: the `run_completed` emit, the charge close,
    // and the revoke. The step does all three when its write changes the row. An engine cancel
    // cannot stop a step that started, so a won write is never cut before these acts.
    //
    // The emit rides inside the transaction of the write. The update holds the row lock until the
    // commit, so the run canceler waits and then loses, and no reader sees the terminal row before
    // the emit. The cli polls the row and flushes the provenance when it leaves `running`; an emit
    // after the commit can miss that flush. `emitRunEvent` returns `void`, so the emit completes before the commit.
    //
    // DBOS retries only a thrown error, so an attempt before the last throws on a failed transaction.
    // The last attempt returns "failed" instead: the body takes the failed path with no `try`, and a
    // failure of DBOS to record a won step cannot be mistaken for a failed write. A commit can fail
    // after the emit, so `emittedInStep` keeps the later attempts from emitting again.
    // The `undefined` in the annotation exists only because control-flow analysis cannot see the closure assignment; no code may depend on the initial state.
    let emittedInStep: boolean | undefined;
    const finalWrite = await DBOS.runStep(
        async (): Promise<"won" | "refused" | "failed"> => {
            const stepLog = logger.with({ status }).named("persist-final-status");
            const written = await withTransaction(deps.pool, "runs.persistFinalStatus", (client) =>
                updateRunStatus(client, runId, status, finalError).map((changed) => {
                    if (changed && !emittedInStep) {
                        emitRunEnd();
                        emittedInStep = true;
                    }
                    return changed;
                }),
            );
            if (written.isErr()) {
                const attempt = DBOS.stepStatus;
                const isLastAttempt =
                    attempt?.currentAttempt === undefined || attempt.maxAttempts === undefined || attempt.currentAttempt >= attempt.maxAttempts;
                const failure = { error: describeDbError(written.error), ...stepLog.errorFields(written.error.cause) };
                if (isLastAttempt) {
                    stepLog.error("ledger write failed", failure);
                    return "failed";
                }
                stepLog.warn("ledger write failed, the step retries", { ...failure, attempt: attempt.currentAttempt });
                throw new Error(`ledger write failed: ${describeDbError(written.error)}`, { cause: written.error.cause });
            }
            // A refused write means an earlier write already set a terminal status: the run
            // canceler's, or an earlier run of this step before a crash. That writer owns the run end.
            if (!written.value) return "refused";
            // DBOS caches the step, so a recovered body records nothing again. A step's own terminal
            // row already carried its metric; the residue counted here is every settled step
            // without one — a child the cancel cut before `mark-canceled` (the cancel check runs
            // before a step body), or one that died before `failStep`. The ledger read is kept
            // apart from the status write: a failed read costs the metrics, never the write.
            const stepRows = await queryStepsByRun(deps.pool, runId);
            if (stepRows.isErr())
                logger.warn("run metrics: step ledger read failed, residual step outcomes skipped", { error: describeDbError(stepRows.error) });
            for (const row of stepRows.unwrapOr([])) {
                if (row.completedAt !== null) continue;
                if (canceled.has(row.stepId)) recordStepCompleted({ agentId: row.agentId, status: "canceled" });
                else if (failed.has(row.stepId)) recordStepCompleted({ agentId: row.agentId, status: "failed" });
            }
            recordRunCompleted({ workflow: "analysis", status, durationMs: terminalAtMs - startedAtMs });
            await closeCharge();
            await revokeAuthorization();
            return "won";
        },
        { name: "persist-final-status", ...FINAL_STATUS_WRITE_RETRY },
    );

    // A refused write leaves two owners. When the canceler won, its engine cancel came before its
    // write, so `close-running-charge` throws the cancel and the body does no act of the run end.
    // When a recovery runs the status step again after its own write landed, no cancel occurred and
    // the body completes the run end here. A failed write leaves the row `running` with no owner,
    // and the body still closes and revokes.
    let closed = false;
    let revoked = false;
    if (finalWrite !== "won") {
        closed = await DBOS.runStep(closeCharge, { name: "close-running-charge" });
        revoked = await DBOS.runStep(revokeAuthorization, { name: "revoke-run-auth" });
    }

    // The step emits only in the execution that ran it. A won step that DBOS gives from the cache
    // did not run, and a refused or failed write did not emit; the body fires the run end here
    // with the same checkpointed values. It is not step-wrapped, so a recovery replay fires it again.
    if (!emittedInStep) emitRunEnd();

    // After a failed write the row is not terminal, so the body records its run end for the run
    // canceler. The record comes after the acts: a cancel before it stops the body and the canceler
    // then owns the run end. A cancel is the only error that goes back to DBOS; a failed record must
    // not undo an otherwise-complete run, like the sibling terminal steps.
    if (finalWrite === "failed") {
        const recorded: RecordedRunEnd = { status, error: finalError, closed, revoked };
        try {
            await DBOS.setEvent(RUN_END_EVENT_KEY, recorded);
        } catch (error) {
            if (isWorkflowCancellation(error)) throw error;
            logger.error("run end record failed, the run canceler acts as for a run with no record", { status, ...logger.errorFields(error) });
        }
    }

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

    // Sweep never-started steps to `skipped`. Log-don't-rollback, like every other finalisation step here.
    await ledgerStep(logger, "sweep-pending-steps", () => sweepPendingStepExecutions(deps.pool, runId));

    // The run end was emitted above. These branches only fan out the UI stream part, whose
    // completed/failed shapes genuinely differ — the provenance record does not.
    if (status === "completed" || status === "partial") {
        const artifactCount = await DBOS.runStep(
            async () =>
                await countArtifactsByRuns(deps.pool, input.analysisId, [runId])
                    .map((counts) => counts[0]?.count ?? 0)
                    .unwrapOr(0),
            { name: "count-run-artifacts" },
        );
        const runCompleted: RunCompletedPart = {
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
        };
        if (status === "partial") runCompleted.note = `${completed.size} of ${input.steps.length} steps completed; results are partial.`;
        if (args.usage) runCompleted.usage = args.usage;
        await emitStreamPart(runCompleted);
    } else {
        await emitStreamPart({
            type: "data-run-failed",
            runId,
            error: failureReason ?? "Run canceled before completion",
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
}): Exclude<ExecuteAnalysisFinalStatus, "running"> {
    const { totalSteps, completed, failed, canceled } = args;
    if (failed.size > 0) {
        return completed.size > 0 ? "partial" : "failed";
    }
    if (canceled.size > 0) return "canceled";
    return completed.size === totalSteps ? "completed" : "partial";
}
