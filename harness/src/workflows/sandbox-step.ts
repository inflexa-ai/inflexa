/**
 * `sandbox-step` — the per-step DBOS child workflow that drives one
 * sandbox-agent execution and its post-step bookkeeping.
 *
 * Structure (each block runs as a `DBOS.runStep` so a crashed workflow
 * replays from the cache instead of re-issuing work):
 *
 *  1. `mark-running`        — update `cortex_step_executions` to running.
 *  2. `createSandbox`       — provision the sandbox; persist its handle.
 *  3. `runAgent`            — the harness agent loop. Every LLM and tool
 *                             call inside is its own durableStep, named
 *                             with the parent's resume attempt so a 402
 *                             resume hits a fresh cache slot (NOTES #3).
 *                             Catches `isBudgetExceeded` and self-cancels
 *                             via `DBOS.cancelWorkflow(self)` to CANCELLED
 *                             (resumable, not ERROR).
 *  4. `generateFileMetadata`— post-step LLM call (chunked, slice-to-length).
 *  5. `generateStepSummary` — post-step LLM call producing `output/summary.md`.
 *  6. `reconcile + register`— write artifact manifest entries to cortex_artifacts.
 *  7. `syncArtifacts`       — register provenance + upload missing file_ids
 *                             via the managed root (scoped to this run+step).
 *  8. `vector-index`        — index file descriptions + summary into pgvector.
 *  9. `teardown`            — destroy the sandbox + clear sandbox_ref.
 * 10. `mark-terminal`       — write the final status, emit `data-step-activity`
 *                             onto the parent's DBOS stream.
 *
 * The parent owns sibling lifecycle: fail-fast and 402-cascade live on the
 * parent (`executeAnalysis`). This child only owns its own teardown and
 * its own self-cancel on 402.
 */

import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { StepPhase } from "@inflexa-ai/harness/contracts/chat-parts.js";
import type { Pool } from "pg";

import { insertStepExecution, updateStepExecution } from "../state/index.js";
import { unwrapOrThrow } from "../lib/result.js";
import { isBudgetExceeded } from "../loop/budget-exceeded.js";
import type { AgentDefinition, EmitFn, LoopMessage } from "../loop/types.js";
import { runAgent, type StepNameFormatter } from "../loop/run-agent.js";
import { durableStep } from "../loop/run-step.js";
import { activityForTool, applyTreeDelta, isChatDataPart, sandboxTreeDelta } from "../sandbox/sandbox-step-translate.js";
import type { AgentChat, EmbeddingProvider } from "../providers/types.js";
import { forSubAgent, type RunSession } from "../auth/types.js";
import type { FileMetadataEntry } from "../execution/artifact-metadata.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { StepSummary } from "../schemas/step-summary.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ArtifactRegistry } from "../execution/artifact-registry.js";
import { walkStepArtifacts } from "../execution/post-step.js";
import {
    collectStepOutputs,
    generateStepFileMetadata,
    generateStepSummaryAndWrite,
    reconcileAndRegisterStepArtifacts,
    vectorIndexStepOutputs,
} from "../execution/post-step-pipeline.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import type { ResourceSpec } from "../config/resource-limits.js";
import type { CreateSandboxMeta, SandboxRef } from "../sandbox/types.js";
import { ProvenanceCollector } from "../provenance/collector.js";
import { createBlockerHolder, type BlockerHolder } from "../tools/sandbox/report-blocker.js";

// ── Workflow input/output shapes ─────────────────────────────────────

/**
 * Input the parent hands the child. Must be JSON-serialisable — DBOS
 * persists this as the workflow's input row.
 */
export interface SandboxStepInput {
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly agentId: string;
    /** Topological level — persisted on `cortex_step_executions.wave`. */
    readonly level: number;
    /** User-content prompt the agent receives as its initial message. */
    readonly prompt: string;
    /**
     * 0-based resume attempt. The parent passes its own attempt counter so
     * the child's LLM step names include `:${attempt}` and resumed calls
     * miss the prior cached 402 instead of returning it (NOTES #3).
     */
    readonly attempt: number;
    /**
     * DBOS workflow id of the parent (`executeAnalysis`). The child uses
     * this to address the parent for the budget-exceeded side-channel
     * (`DBOS.send(parent, …, "child-budget-exceeded")`) — the parent's
     * scheduler-loop classifier relies on it to disambiguate a budget-induced
     * self-cancel from an operator-driven sibling cancel (CANCELLED is the
     * same terminal state for both).
     */
    readonly parentWorkflowId: string;
    /** Sandbox image override; falls back to the child's configured default. */
    readonly image?: string;
    /** Per-step env overrides forwarded to sandbox-server. */
    readonly extraEnv?: Record<string, string>;
    /** Planner-estimated CPU/memory/GPU request for this step's sandbox. */
    readonly resources: ResourceSpec;
    /**
     * Per-step execution budget in seconds. The body translates this into the
     * absolute unix-ms deadline that `awaitExec` honours as its durable
     * backstop. Comes from the plan's `step.timeout` (defaulted on the parent
     * side); falls back to `DEFAULT_STEP_TIMEOUT_SECONDS` when unset so a
     * client that omits the field still gets a non-pathological ceiling.
     */
    readonly timeoutSeconds?: number;
    /**
     * Durable `RunSession` derived by the parent via `forStep`. Carries the
     * run-authorization credential, identity, scope, and `runFrame = { runId, stepId }`.
     * DBOS replay reconstructs it on resume — the body never reads the JWT
     * from `cortex_runs`.
     */
    readonly runSession: RunSession;
}

/**
 * Fallback when the plan step omits `timeout`. Plans that need 3-hour runs
 * declare it explicitly.
 */
export const DEFAULT_STEP_TIMEOUT_SECONDS = 3600;

export type SandboxStepStatus = "complete" | "failed" | "canceled" | "blocked";

/**
 * DBOS message topic the child uses to notify the parent that it is
 * about to self-cancel because of a 402 budget-exceeded error. The
 * notification fires BEFORE `DBOS.cancelWorkflow(self)` so the parent's
 * concurrent recv accumulator records the child id before the child's
 * terminal state lands. Without it the parent observes
 * `DBOSWorkflowCancelledError` from `getResult` — a generic message that
 * `isBudgetExceeded` does NOT match — and misclassifies the failure as
 * fail-fast, skipping the 402 pause cascade.
 */
export const BUDGET_EXCEEDED_TOPIC = "child-budget-exceeded";

export interface BudgetExceededNotification {
    readonly childWorkflowId: string;
    readonly stepId: string;
    readonly error: string;
}

export interface SandboxStepResult {
    readonly status: SandboxStepStatus;
    readonly durationMs: number;
    readonly finishReason: string | null;
    readonly error: string | null;
}

// ── Step detail emit shapes ───────────────────────────────────────────

/** One file in the step's terminal file tree / output listing. */
export interface StepFileEntry {
    readonly path: string;
    readonly size: number;
    /** Schema-conformant `StepOutputFile.fileType`. */
    readonly fileType: "script" | "output" | "figure" | "log" | "notebook" | "summary";
    readonly description: string;
}

/**
 * Post-step detail the body emits to the run stream once the bookkeeping
 * helpers have run. Derived from the metadata entries, the generated step
 * summary, and the reconciled artifact manifest. `collectStepOutputs`
 * assembles it from the same stash the vector-index step consumes.
 */
export interface StepOutputs {
    /** Reconciled artifact files with category + description + size. */
    readonly files: readonly StepFileEntry[];
    /** Generated step summary markdown (empty when none produced). */
    readonly summaryMarkdown: string;
}

/**
 * The typed post-step products threaded through the workflow body: file
 * descriptions, the interpretive summary, and the reconciled (phantom-dropped)
 * artifact manifest. Each value is produced by one post-step dep and consumed
 * by `collectStepOutputs` and the vector indexer — the body is the explicit
 * composition, so the producer→consumer ordering is a type constraint rather
 * than an implicit contract over shared mutable state.
 */
export interface PostStepArtifacts {
    readonly metadataEntries: readonly FileMetadataEntry[];
    readonly summary: StepSummary | undefined;
    readonly reconciledManifest: readonly ArtifactManifestEntry[];
}

// ── Dep injection ─────────────────────────────────────────────────────

/**
 * Per-step coordinates the workflow body computes once and threads to the
 * deps factory. The parent supplies the durable inputs; the factory
 * supplies the live sandbox ref, the per-call function-id minter, and the
 * deadline.
 */
export interface SandboxAgentBuildContext {
    readonly input: SandboxStepInput;
    readonly session: RunSession;
    readonly sandbox: SandboxRef;
    /** Workflow-id used to scope sandbox callbacks + workspace mutate provenance. */
    readonly workflowId: string;
    readonly stepWritePrefix: string;
    readonly nextFunctionId: () => string;
    readonly deadlineMs: () => number;
    /**
     * Step-scoped lineage collector. The body owns one per step and threads
     * it both here (so `execute_command` feeds each exec's provenance frame)
     * and into `PostStepContext` (so registration reads the resulting
     * input/script edges). Same instance on both paths.
     */
    readonly lineageCollector: ProvenanceCollector;
    /**
     * Per-run blocker cell (see the harness-sandbox-agents spec). The body owns it and reads
     * `holder.outcome` after `runAgent`; the agent factory adds `report_blocker`
     * bound to this holder.
     */
    readonly blockerHolder: BlockerHolder;
}

/**
 * Inversion of control: the parent supplies the live agent, the parent's
 * stream emitter, and the post-step helpers. Keeping the workflow body
 * free of per-agent imports means it can drive every agent in the catalog
 * without becoming a switch on agentId.
 */
export interface SandboxStepDeps {
    readonly pool: Pool;
    /** Non-streaming chat — drives the agent loop + the post-step sub-agents. */
    readonly provider: AgentChat;
    /** Write-side embedder for the post-step vector index. */
    readonly embedding: EmbeddingProvider;
    readonly sandboxClient: SandboxClient;
    /**
     * External artifact registration + sync seam. The harness's post-step pipeline
     * registers each step's outputs through it (filesystem index in the
     * cloud-free build, external provenance ledger in the managed build).
     */
    readonly artifactRegistry: ArtifactRegistry;
    /** Workspace read seam — backs `read_file` in the metadata + summary loops. */
    readonly workspaceFs: WorkspaceFilesystem;
    /** Base path holding per-analysis session directories. */
    readonly sessionsBasePath: string;
    /** Sandbox model id — provenance label for metadata + summary generation. */
    readonly model: string;
    /**
     * Build the agent definition for this step. The parent resolves the
     * agent from the catalog, wires its workspace tools, and returns the
     * configured `AgentDefinition` runAgent will drive.
     */
    buildAgent(ctx: SandboxAgentBuildContext): AgentDefinition;
    /**
     * Resolve the absolute writable artifact prefix for this step. The
     * workspace mutate tools enforce write confinement against this path.
     */
    resolveWritePrefix(input: SandboxStepInput): string;
}

/**
 * Per-step context passed to every post-step dep. Carries the durable input
 * (analysisId/runId/stepId/agentId), the durable `RunSession`, the in-memory
 * agent transcript, and the on-disk write prefix. The write prefix is the
 * absolute path each post-step dep walks to discover artifacts;
 * `lineageCollector` carries the runtime-observed input/script edges the
 * step loop accumulated, which registration translates into managed-root parents.
 */
export interface PostStepContext {
    readonly input: SandboxStepInput;
    readonly session: RunSession;
    readonly transcript: readonly LoopMessage[];
    /** Absolute path to the step's writable artifact directory. */
    readonly writePrefix: string;
    /** Sandbox handle id — informational only, used in log lines. */
    readonly sandboxId: string;
    /** Same step-scoped collector the agent loop fed each exec frame into. */
    readonly lineageCollector: ProvenanceCollector;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build an attempt-aware step-name formatter. Names land in the DBOS step
 * cache, so the `:${attempt}` suffix is the load-bearing 402-resume
 * mechanism: on resume the formatter returns a name that has never been
 * seen, the cache misses, and the LLM call fires fresh.
 */
export function attemptStepNameFormatter(attempt: number): StepNameFormatter {
    return {
        llm: (iteration) => `llm:${iteration}:${attempt}`,
        tool: (toolName, toolUseId) => `tool:${toolName}:${toolUseId}:${attempt}`,
    };
}

function nextFunctionIdFactory(): () => string {
    let n = 0;
    return () => `fn-${(n++).toString(36)}`;
}

/**
 * Stable reconciliation id for a step's reconciling parts
 * (`data-step-activity`, `data-step-file-tree`). One id per (runId, stepId)
 * so the run-stream fold collapses every phase transition latest-wins onto
 * a single frame. The client keys these by `stepId`, but the server fold
 * keys by part `id`, so the id MUST be unique per step within the run.
 */
function stepPartId(kind: string, runId: string, stepId: string): string {
    return `${kind}-${runId}-${stepId}`;
}

/**
 * Map an internal step failure to a user-safe string. Internal detail (file
 * paths, content hashes, managed-root rejection reasons, stack traces) stays in the pod
 * logs and in `lastErrorClass`; the surfaces a user sees — the live run panel
 * (`data-step-activity`), `cortex_step_executions.error` (read by `inspectRun`
 * and `routes/runs.ts`), and the parent's DAG snapshot / `cortex_runs.error` —
 * carry only this generic phrase.
 */
function userFacingStepFailure(errorClass: "agent_loop" | "lineage_attestation"): string {
    return errorClass === "lineage_attestation" ? "Step results could not be finalized." : "Step failed during execution.";
}

// ── The child workflow body ───────────────────────────────────────────

/**
 * Register the sandbox-step child workflow with DBOS. Returns the
 * registered callable so callers can dispatch via `DBOS.startWorkflow`.
 *
 * Workflow version stamping is handled globally via `DBOS.setConfig({
 * applicationVersion })` in `launchDbos` — DBOS records the running
 * version on every workflow row automatically, so blue/green drains read
 * `dbos.application_versions` without per-workflow config.
 */
export function registerSandboxStep(deps: SandboxStepDeps): (input: SandboxStepInput) => Promise<SandboxStepResult> {
    return DBOS.registerWorkflow(
        async (input: SandboxStepInput): Promise<SandboxStepResult> => {
            return runSandboxStepBody(input, deps);
        },
        { name: "sandbox-step" },
    );
}

/**
 * Body extracted so tests can drive it without registering a workflow
 * (the DBOS calls inside still rely on a workflow context being present).
 */
async function runSandboxStepBody(input: SandboxStepInput, deps: SandboxStepDeps): Promise<SandboxStepResult> {
    const childWorkflowId = DBOS.workflowID ?? `${input.runId}-${input.stepId}`;
    // Checkpointed so the value (and every `durationMs` derived from it) replays
    // identically — a raw `Date.now()` in the workflow body drifts on recovery.
    const startedAt = await DBOS.now();

    // (1) mark-running — also persists the level (cortex_step_executions.wave)
    // and child_workflow_id (cortex_step_executions.child_workflow_id).
    await DBOS.runStep(
        async () => {
            unwrapOrThrow(
                await insertStepExecution(deps.pool, {
                    runId: input.runId,
                    stepId: input.stepId,
                    analysisId: input.analysisId,
                    wave: input.level,
                    agentId: input.agentId,
                    childWorkflowId,
                }),
            );
        },
        { name: "mark-running" },
    );

    // Stamp the sandbox agent's id into provenance so loop events carry
    // `source.agentId === input.agentId` (the parent's RunSession still reads
    // "conversation-agent"). `run-agent.ts` builds source from
    // `session.provenance.agentId`, and billing tags ride the same provenance.
    const session = forSubAgent(input.runSession, input.agentId);
    const writePrefix = deps.resolveWritePrefix(input);

    // One lineage collector per step. The agent loop feeds each exec's
    // provenance frame into it; post-step registration reads the resulting
    // input/script edges. Reconstructed deterministically on replay — the
    // frames it consumes are cached recv outputs and the command strings are
    // cached LLM tool-use (see the harness-thread-store and harness-durable-runtime specs).
    const lineageCollector = new ProvenanceCollector({
        stepId: input.stepId,
        runId: input.runId,
    });

    // (2a) sandbox.mint — checkpoint the machine's identity (name + HMAC secret)
    // BEFORE it is spawned (see the harness-sandbox-exec spec). Durable-before-create is what makes (2b)
    // idempotent: a crash between spawn and the spawn checkpoint re-runs (2b)
    // with the same identity, which adopts the already-created machine instead
    // of leaking a second one.
    const identity = await DBOS.runStep(() => Promise.resolve(mintSandboxIdentity(input.runId)), { name: "sandbox.mint" });

    // (2b) sandbox.create — spawn (or adopt) the machine under the minted
    // identity. The handle (secret included) is cached so recovery picks the
    // same machine back up without re-provisioning.
    const sandboxMeta: CreateSandboxMeta = {
        runId: input.runId,
        stepId: input.stepId,
        analysisId: input.analysisId,
        childWorkflowId,
        image: input.image,
        extraEnv: input.extraEnv,
        resources: input.resources,
    };
    const sandbox = await DBOS.runStep(() => deps.sandboxClient.createSandbox(sandboxMeta, identity), { name: "sandbox.create" });

    // Recovery path: re-check `isAlive` on the persisted ref before continuing.
    // A classified-dead sandbox triggers a fresh `createSandbox` (task 4.6).
    // For first execution this is a cheap no-op; on replay it's the seam
    // that catches a dead pod between checkpoints.
    await DBOS.runStep(
        async () => {
            const liveness = await deps.sandboxClient.isAlive(sandbox);
            if (!liveness.alive) {
                const cause = liveness.oomKilled ? "was killed for exceeding its memory limit (sandbox-oom-killed)" : "no longer alive on replay";
                throw new Error(`sandbox ${sandbox.sandboxId} ${cause} — caller must restart the step`);
            }
        },
        { name: "sandbox.recheck-alive" },
    );

    // (3) runAgent — the harness loop with durableStep + attempt-aware names.
    // The step deadline is captured ONCE at step start from the checkpointed
    // clock so it reproduces on replay — the `awaitExec` recv loop gates on this
    // absolute deadline, so a raw `Date.now()` here would shift the recorded
    // `DBOS.recv` sequence on recovery (see the harness-durable-runtime spec). `deadlineMs` is a getter so
    // deps read the absolute ms without holding a captured value; returning a
    // fresh `now + timeout` per call would make a step with N tool calls runnable
    // for up to N × `timeoutSeconds`.
    const stepDeadlineMs = (await DBOS.now()) + (input.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000;
    const blockerHolder = createBlockerHolder();
    const agent = deps.buildAgent({
        input,
        session,
        sandbox,
        workflowId: childWorkflowId,
        stepWritePrefix: writePrefix,
        nextFunctionId: nextFunctionIdFactory(),
        deadlineMs: () => stepDeadlineMs,
        lineageCollector,
        blockerHolder,
    });

    // Forward every loop event onto the child's own DBOS `"events"` stream
    // (the route fans-in parent + every active child stream — Pattern A).
    // Pre-shaped chat data parts (e.g. `data-sandbox-event` from `run-exec.ts`)
    // pass through verbatim; orchestration events (`iteration`, `tool-started`,
    // `tool-finished`) and model-output deltas are wrapped under the
    // `data-loop-event` envelope so the SSE consumer can route them.
    //
    // Every emit is `await`ed in body order (the loop awaits its own emits, and
    // `awaitExec` awaits its sandbox-event emits), so each body-path
    // `DBOS.writeStream` lands at a deterministic function-ID on replay
    // (see the harness-durable-runtime spec) — no fire-and-forget tail racing the next real op for the
    // counter. `safeEmit` swallows a stream-write failure: a dropped UI frame
    // is non-fatal and must not fail the step.
    // Pattern A (fan-in at route): write to the CHILD's own `"events"` stream.
    // `DBOS.writeStream` is body-only, so cross-workflow writes aren't supported;
    // the SSE route reads the parent's stream plus every active child's, addressed
    // by `cortex_step_executions.child_workflow_id`.
    const emitToParentStream = (part: unknown): Promise<void> => DBOS.writeStream("events", part);
    const safeEmit = async (part: unknown): Promise<void> => {
        try {
            await emitToParentStream(part);
        } catch (err) {
            console.warn(`[sandbox-step] emitToParentStream failed (non-fatal):`, err instanceof Error ? err.message : err);
        }
    };
    // Schema-conformant step-activity emitter — stable id per (runId, stepId)
    // so the run-stream fold collapses every phase transition latest-wins.
    const activityId = stepPartId("step-activity", input.runId, input.stepId);
    const emitActivity = (phase: StepPhase, activity: string): Promise<void> =>
        safeEmit({
            type: "data-step-activity",
            id: activityId,
            runId: input.runId,
            stepId: input.stepId,
            phase,
            activity,
        });

    // Single exit for the two terminal failure paths (agent loop, lineage
    // attestation). Tears the sandbox down, logs the internal detail for
    // operators, then persists + emits only a generic phrase and re-raises a
    // scrubbed error — so the child DB row, the run panel, and the parent's
    // re-thrown `settled.err.message` (DAG snapshot + `cortex_runs.error`) all
    // stay free of internal paths/hashes/managed-root jargon. A DBOS cancellation is
    // control-flow, not a failure — re-raise it verbatim.
    const failStep = async (errorClass: "agent_loop" | "lineage_attestation", err: unknown): Promise<never> => {
        if (err instanceof DBOSErrors.DBOSWorkflowCancelledError) throw err;
        await tryTeardown(deps, sandbox);
        const durationMs = (await DBOS.now()) - startedAt;
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error(`[sandbox-step] ${errorClass} failure for ${input.runId}/${input.stepId}: ${detail}`);
        const safe = userFacingStepFailure(errorClass);
        await DBOS.runStep(
            async () => {
                unwrapOrThrow(
                    await updateStepExecution(deps.pool, input.runId, input.stepId, {
                        status: "failed",
                        durationMs,
                        error: safe,
                        attempts: input.attempt + 1,
                        lastErrorClass: errorClass,
                    }),
                );
            },
            {
                name: errorClass === "lineage_attestation" ? "mark-failed-attestation" : "mark-failed",
            },
        );
        await emitActivity("failed", safe);
        throw new Error(safe);
    };

    // Live per-step file tree. The sandbox executor posts on-change deltas per
    // exec; the body folds them into one cumulative path set (across every exec
    // of the step) and emits the FULL tree under a stable per-step reconciling
    // id — the terminal `walkArtifacts` tree reconciles onto the same id at step
    // end. Full-tree + reconciling means an observer reconnecting from offset 0
    // still converges (raw deltas alone would not). REPLAY: the fold is a 1:1
    // pure function of the checkpointed `awaitExec` recv sequence — do NOT add a
    // timer/debounce here, that would re-break the harness-durable-runtime spec.
    const treeFileId = stepPartId("step-file-tree", input.runId, input.stepId);
    const treeFiles = new Set<string>();
    const emitFileTree = (): Promise<void> =>
        safeEmit({
            type: "data-step-file-tree",
            id: treeFileId,
            runId: input.runId,
            stepId: input.stepId,
            files: [...treeFiles].sort().map((path) => ({ path, type: "file" as const })),
        });

    // One translator from sandbox/loop events to the typed per-step parts
    // consumers render. Add a new sandbox event kind as one case here. `data-step-activity`
    // / `data-step-file-tree` are what the run side panel reads — raw loop events
    // and per-exec deltas are not, so the fold is what makes the live activity and
    // file tree visible during a step.
    const emit: EmitFn = async (event) => {
        if (isChatDataPart(event)) {
            const delta = sandboxTreeDelta(event);
            if (delta) {
                applyTreeDelta(treeFiles, delta);
                await emitFileTree();
                return;
            }
            await safeEmit(event);
            return;
        }
        // Forward the raw orchestration / model-delta event under the loop-event
        // envelope, and surface each tool call as live step activity.
        await safeEmit({ type: "data-loop-event" as const, data: { stepId: input.stepId, event } });
        if (event.type === "tool-started") {
            await emitActivity("executing", activityForTool(event.name, event.input));
        }
    };

    const initial: LoopMessage[] = [{ role: "user", content: input.prompt }];

    await emitActivity("executing", `Running ${input.agentId}`);

    // DBOS exposes no JS AbortSignal that fires on `cancelWorkflow` — cancellation
    // is enforced at DBOS checkpoint (step) boundaries, not cooperatively in-loop.
    const neverAbort = new AbortController().signal;

    let transcript: LoopMessage[];
    let finishReason: string;
    let hitMaxSteps: boolean;
    try {
        const agentResult = await runAgent(agent, initial, session, {
            provider: deps.provider,
            signal: neverAbort,
            emit,
            runStep: durableStep,
            formatStepName: attemptStepNameFormatter(input.attempt),
            isFatalLoopError: (err) => err instanceof DBOSErrors.DBOSWorkflowCancelledError,
        });
        transcript = agentResult.messages;
        finishReason = agentResult.finish.reason;
        hitMaxSteps = agentResult.finish.cappedOut;
    } catch (err) {
        if (isBudgetExceeded(err)) {
            // Notify the parent BEFORE self-cancel — DBOSWorkflowCancelledError
            // surfaced by `getResult` carries a generic message that
            // `isBudgetExceeded` cannot match, so without this side-channel the
            // parent classifier falls through to fail-fast and the 402 pause
            // cascade never fires. Wrapped in `DBOS.runStep` for replay
            // idempotency (DBOS persists the send under (workflowID, function_id),
            // a recovered child does not re-send). Failure to send is logged but
            // swallowed: the worst case is the parent misclassifies the cancel
            // as fail-fast, which is the pre-fix behaviour and still safe.
            const errMsg = err instanceof Error ? err.message : String(err);
            const notification: BudgetExceededNotification = {
                childWorkflowId,
                stepId: input.stepId,
                error: errMsg,
            };
            try {
                await DBOS.runStep(() => DBOS.send(input.parentWorkflowId, notification, BUDGET_EXCEEDED_TOPIC), { name: "notify-parent-budget-exceeded" });
            } catch (sendErr) {
                console.warn(`[sandbox-step] notify-parent-budget-exceeded failed (non-fatal): ${sendErr instanceof Error ? sendErr.message : sendErr}`);
            }

            // Self-cancel to CANCELLED so the parent's `getResult` observes the
            // cancellation and triggers the 402 pause cascade. ERROR is NOT
            // resumable (NOTES #3); CANCELLED is what `resumeWorkflow` reads.
            // The subsequent runStep flips the cortex_step_executions row to
            // canceled and raises `DBOSWorkflowCancelledError` — nothing past
            // that line executes. The parent's classifier reads the budget
            // notification from the side-channel set populated above and
            // observes the cancel terminal state via `getResult`.
            await DBOS.cancelWorkflow(childWorkflowId);
            const durationMs = (await DBOS.now()) - startedAt;
            await DBOS.runStep(
                async () => {
                    unwrapOrThrow(
                        await updateStepExecution(deps.pool, input.runId, input.stepId, {
                            status: "canceled",
                            durationMs,
                            error: "budget_exceeded",
                            attempts: input.attempt + 1,
                            lastErrorClass: "budget_exceeded",
                        }),
                    );
                },
                { name: "mark-canceled" },
            );
            // Unreachable — the runStep above raises DBOSWorkflowCancelledError.
            throw new Error("unreachable: mark-canceled did not raise", { cause: err });
        }

        // Non-resumable failure — tear down, mark failed (scrubbed), re-raise so
        // the parent's `getResult` sees ERROR and the fail-fast cascade fires.
        // `failStep` always throws; the outer `throw` is for control-flow analysis.
        throw await failStep("agent_loop", err);
    }

    // Blocker (see the harness-sandbox-agents spec): the agent declared it cannot fulfil the step. A
    // blocked step has no deliverables — skip the artifact post-step pipeline,
    // mark `blocked` (carrying the reason), emit the blocked part, and return a
    // terminal-failure status so the parent's fail-fast cascade fires.
    const blockerOutcome = blockerHolder.outcome;
    if (blockerOutcome) {
        await tryTeardown(deps, sandbox);
        const durationMs = (await DBOS.now()) - startedAt;
        await DBOS.runStep(
            async () => {
                unwrapOrThrow(
                    await updateStepExecution(deps.pool, input.runId, input.stepId, {
                        status: "blocked",
                        durationMs,
                        error: blockerOutcome.reason,
                        blockedReason: blockerOutcome.reason,
                        attempts: input.attempt + 1,
                        lastErrorClass: "blocked",
                        finishReason,
                        hitMaxSteps,
                    }),
                );
            },
            { name: "mark-blocked" },
        );
        await safeEmit({
            type: "data-step-blocked",
            id: stepPartId("step-blocked", input.runId, input.stepId),
            runId: input.runId,
            stepId: input.stepId,
            agentId: input.agentId,
            reason: blockerOutcome.reason,
        });
        await emitActivity("failed", "Step blocked");
        return {
            status: "blocked",
            durationMs,
            finishReason,
            error: blockerOutcome.reason,
        };
    }

    // (4-8) post-step — the body is the explicit composition: walk the artifact
    // tree once, then thread each stage's typed output into the next. Helpers
    // run inline (not `DBOS.runStep`-wrapped), so a replay re-executes this
    // section. Each helper is best-effort (`safeRun*` logs + degrades) so a
    // single failure never fails the step.
    const postCtx: PostStepContext = {
        input,
        session,
        transcript,
        writePrefix,
        sandboxId: sandbox.sandboxId,
        lineageCollector,
    };

    await emitActivity("generating-metadata", "Describing output files");
    const manifest = await safeRunValue(
        () =>
            walkStepArtifacts({
                writePrefix,
                stepId: input.stepId,
                runId: input.runId,
            }),
        "post-step.walk",
        [] as readonly ArtifactManifestEntry[],
    );
    // The two post-step LLM producers are wrapped in `DBOS.runStep` so their
    // outputs are checkpointed (see the harness-durable-runtime spec): the conditional terminal emits they
    // gate (`data-step-summary`, file-tree) stay replay-stable and the billed
    // LLM calls are not re-issued on recovery. The remaining stages (walk /
    // reconcile / sync / index) stay inline — a separate follow-up.
    const metadataEntries = await safeRunValue(
        () =>
            DBOS.runStep(() => generateStepFileMetadata(deps, postCtx, manifest), {
                name: "post-step.generate-file-metadata",
            }),
        "post-step.metadata",
        [] as readonly FileMetadataEntry[],
    );
    await emitActivity("generating-summary", "Summarizing step results");
    const summary = await safeRunValue(
        () =>
            DBOS.runStep(() => generateStepSummaryAndWrite(deps, postCtx, manifest), {
                name: "post-step.generate-step-summary",
            }),
        "post-step.summary",
        undefined,
    );
    // Lineage attestation (registration + sync) is fail-fast (see the artifact-manifest spec): unlike
    // the best-effort enrichment stages, a failure here orphans the step's real
    // outputs, so it fails the step loudly instead of finishing green. Transient
    // managed-root errors are already retried in the client, so anything thrown here is
    // persistent — tear down, mark failed, and re-raise so the parent's fail-fast
    // cascade fires (mirrors the agent-loop failure path).
    await emitActivity("persisting", "Registering artifacts");
    let reconciledManifest: readonly ArtifactManifestEntry[];
    try {
        reconciledManifest = await reconcileAndRegisterStepArtifacts(deps, postCtx, manifest);
        await deps.artifactRegistry.sync(
            {
                resourceId: input.analysisId,
                runId: input.runId,
                stepId: input.stepId,
            },
            session,
        );
    } catch (err) {
        throw await failStep("lineage_attestation", err);
    }

    const postArtifacts: PostStepArtifacts = {
        metadataEntries,
        summary,
        reconciledManifest,
    };

    let stepOutputs: StepOutputs | undefined;
    try {
        stepOutputs = collectStepOutputs(postCtx, postArtifacts);
    } catch (err) {
        console.warn(`[sandbox-step] post-step.collect failed (non-fatal):`, err instanceof Error ? err.message : err);
    }

    await emitActivity("indexing", "Indexing outputs for search");
    await safeRun(() => vectorIndexStepOutputs(deps, postCtx, postArtifacts), "post-step.vector-index");

    // (9) teardown — destroy sandbox + clear sandbox_ref.
    await DBOS.runStep(() => deps.sandboxClient.teardown(sandbox), { name: "sandbox.teardown" });

    // (10) mark-terminal + emit.
    const durationMs = (await DBOS.now()) - startedAt;
    await DBOS.runStep(
        async () => {
            unwrapOrThrow(
                await updateStepExecution(deps.pool, input.runId, input.stepId, {
                    status: "completed",
                    durationMs,
                    attempts: input.attempt + 1,
                    lastErrorClass: null,
                    finishReason,
                    hitMaxSteps,
                }),
            );
        },
        { name: "mark-complete" },
    );
    // Terminal step-detail parts. file-tree + summary + output each get a
    // stable id per step so the run-stream fold + client both treat them as
    // one-per-step (file-tree reconciles; summary/output are emitted once).
    if (stepOutputs) {
        if (stepOutputs.files.length > 0) {
            await safeEmit({
                type: "data-step-file-tree",
                id: stepPartId("step-file-tree", input.runId, input.stepId),
                runId: input.runId,
                stepId: input.stepId,
                files: stepOutputs.files.map((f) => ({
                    path: f.path,
                    size: f.size,
                    type: "file" as const,
                })),
            });
        }
        if (stepOutputs.summaryMarkdown.trim().length > 0) {
            await safeEmit({
                type: "data-step-summary",
                id: stepPartId("step-summary", input.runId, input.stepId),
                runId: input.runId,
                stepId: input.stepId,
                agentId: input.agentId,
                markdown: stepOutputs.summaryMarkdown,
            });
        }
        if (stepOutputs.files.length > 0) {
            await safeEmit({
                type: "data-step-output",
                id: stepPartId("step-output", input.runId, input.stepId),
                runId: input.runId,
                stepId: input.stepId,
                agentId: input.agentId,
                files: stepOutputs.files.map((f) => ({
                    path: f.path,
                    size: f.size,
                    fileType: f.fileType,
                    description: f.description,
                })),
                artifactCount: stepOutputs.files.length,
                durationMs,
                finishReason,
                hitMaxSteps,
            });
        }
    }

    await emitActivity("complete", "Step complete");

    return {
        status: "complete",
        durationMs,
        finishReason,
        error: null,
    };
}

/**
 * Best-effort wrapper for non-load-bearing post-step calls. Logs and
 * swallows non-fatal failures — these are reflected in the step summary
 * but do not fail the step itself (synthesis/sync/index can be retried).
 */
async function safeRun(fn: () => Promise<void>, label: string): Promise<void> {
    try {
        await fn();
    } catch (err) {
        if (err instanceof DBOSErrors.DBOSWorkflowCancelledError) throw err;
        console.warn(`[sandbox-step] ${label} failed (non-fatal):`, err instanceof Error ? err.message : err);
    }
}

/**
 * `safeRun` for a value-returning post-step stage: on a non-fatal failure it
 * logs and yields `fallback` so the body can thread a safe default downstream
 * instead of aborting the post-step pipeline.
 */
async function safeRunValue<T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof DBOSErrors.DBOSWorkflowCancelledError) throw err;
        console.warn(`[sandbox-step] ${label} failed (non-fatal):`, err instanceof Error ? err.message : err);
        return fallback;
    }
}

async function tryTeardown(deps: SandboxStepDeps, sandbox: SandboxRef): Promise<void> {
    try {
        await DBOS.runStep(() => deps.sandboxClient.teardown(sandbox), { name: "sandbox.teardown" });
    } catch (err) {
        console.warn(`[sandbox-step] teardown failed (non-fatal):`, err instanceof Error ? err.message : err);
    }
}
