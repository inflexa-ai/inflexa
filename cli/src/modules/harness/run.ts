// TODO(extend): `triggerAnalysisRun` in this file is a faithful replica of the
// harness's own `executePlan` chat tool (`harness/src/tools/execute-plan.ts`):
// dedup pre-check → reserve → authorize → build input → launch, with the same
// three failure paths (authorize-failure marks the row failed; launch-failure
// revokes + marks failed; a dedup collision resolves to the winner). The harness
// keeps that flow inside a chat-route tool that needs a `ToolContext` and an
// analysis-scoped `RequestSession` and emits `data-run-card` parts the cli does
// not render, so the cli cannot call it off-label (design D2). This replica
// exists ONLY to drive the run engine from the cli before the
// conversation-agent/planner adoption lands a shared, callable trigger. It is
// under the SAME dev-surface clearing contract as file-based plan intake
// (`plan_intake.ts`, whose own `TODO(extend)` names the same contract) and the
// `plan-intake` spec (`openspec/specs/plan-intake/spec.md`): retire this replica
// together with file intake when the planner is adopted. Keep it a thin mirror —
// do not grow trigger logic here that the harness does not also have.

import { randomUUID } from "node:crypto";
import { intro, log, outro, spinner } from "@clack/prompts";
import { ok, err, type Result } from "neverthrow";
import {
    insertRun,
    loadDataProfileStatus,
    makeLocalAuth,
    queryActiveRun,
    queryRun,
    queryRunsByAnalysis,
    queryStepsByRun,
    renderStepPrompt,
    RunDedupCollisionError,
    updateRunStatus,
    upsertAnalysis,
    upsertPlan,
    type AnalysisPlan,
    type AnalysisStep,
    type AuthContext,
    type CortexRunRow,
    type DbError,
    type ExecuteAnalysisInput,
    type InsertRunInput,
    type Pool,
    type Provenance,
    type RunAuthorization,
    type RunAuthorizer,
    type RunStatus,
    type StepExecutionRow,
} from "@inflexa-ai/harness";

import { fail, dieOn } from "../../lib/cli.ts";
import { shutdown } from "../../lib/shutdown.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import type { ContextFlags } from "../analysis/context.ts";
import { sessionTreeDataDir } from "../staging/paths.ts";
import { stageInputs } from "../staging/staging.ts";
import { resolveHarnessConfig } from "./config.ts";
import { intakePlan, type PlanIntakeError } from "./plan_intake.ts";
import { describeBootError, ensureSandboxImage, formatElapsed, readNewestWorkflowStep, resolveSingleAnalysis, withStatusPool } from "./profile.ts";
import { bootHarnessRuntime, type RunTriggerDeps } from "./runtime.ts";

type Spinner = ReturnType<typeof spinner>;

// ── The replicated trigger flow (task 4.1 / design D2) ───────────────────────

/**
 * The harness calls the trigger flow makes, injected as one seams object so the
 * unit tests run fully offline (no Postgres, no DBOS, no authorizer) — the same
 * house pattern as {@link import("./plan_intake.ts").PlanIntakeDeps} and
 * `BootSeams`. Production binds the barrel state functions + the booted
 * {@link RunTriggerDeps} via {@link defaultRunTriggerSeams}.
 */
export type RunTriggerSeams = {
    /** Dedup pre-check + collision recovery: the active run for `(analysisId, planId)`, if any. */
    readonly queryActiveRun: (analysisId: string, planId: string) => ReturnType<typeof queryActiveRun>;
    /** Reserve the run row; throws `RunDedupCollisionError` on the partial-unique race. */
    readonly insertRun: (input: InsertRunInput) => ReturnType<typeof insertRun>;
    /** Mark the reserved row on the authorize/launch failure paths (releases the dedup slot). */
    readonly updateRunStatus: (runId: string, status: RunStatus, error: string) => ReturnType<typeof updateRunStatus>;
    /** Authorize the run at the async edge; `revoke` releases a self-minted mandate on launch failure. */
    readonly runAuthorizer: RunAuthorizer;
    /** Launch `executeAnalysis` under `workflowId = runId` — fire-and-forget. */
    readonly launch: (input: ExecuteAnalysisInput, runId: string) => Promise<void>;
    /** Render a plan step's prompt body for the child workflow. */
    readonly renderStepPrompt: (step: AnalysisStep) => string;
    /** Mint the run id — the bare UUID that IS the DBOS workflowId (see below). Injected so tests pin it. */
    readonly newRunId: () => string;
};

/**
 * Bind the trigger seams to the booted runtime's {@link RunTriggerDeps} and the
 * harness's barrel state functions. `newRunId` is a bare `randomUUID()` (v4) from
 * `node:crypto`, NOT the cli's house `randomUUIDv7()`: the run id IS the DBOS
 * `workflowId` (`runLauncher.launch(..., { workflowId: runId }, ...)`), so it must
 * match the harness's own contract — `execute-plan.ts` mints "the bare UUID that
 * IS the DBOS workflowID" the same way, and matching the harness beats the cli
 * house rule for this one value.
 */
export function defaultRunTriggerSeams(deps: RunTriggerDeps): RunTriggerSeams {
    return {
        queryActiveRun: (analysisId, planId) => queryActiveRun(deps.pool, analysisId, planId),
        insertRun: (input) => insertRun(deps.pool, input),
        updateRunStatus: (runId, status, error) => updateRunStatus(deps.pool, runId, status, error),
        runAuthorizer: deps.runAuthorizer,
        launch: (input, runId) => deps.runLauncher.launch(deps.executeAnalysis, { workflowId: runId }, input),
        renderStepPrompt,
        newRunId: () => randomUUID(),
    };
}

/** Identity + validated plan the trigger builds the workflow input from. */
export type TriggerAnalysisRunParams = {
    /** Opaque local auth capability (`makeLocalAuth()`) — the authorizer turns it into a `RunSession`. */
    readonly auth: AuthContext;
    readonly analysisId: string;
    /** Deterministic plan id from intake — the dedup key on `cortex_runs`. */
    readonly planId: string;
    /** Display summary (title or narrative slice) already derived by intake. */
    readonly planSummary: string;
    readonly plan: AnalysisPlan;
};

/** Outcome of a successful trigger: a fresh launch, or a join onto an already-active run. */
export type TriggerAnalysisRunResult =
    { readonly kind: "started"; readonly runId: string } | { readonly kind: "already_active"; readonly runId: string; readonly status: RunStatus };

/**
 * Why the trigger could not launch. Mirrors `executePlan`'s failure surface: a
 * dedup read failure, a reservation failure, and the two post-reserve failures
 * (authorize / launch) that leave the row marked `failed` so a retry can re-run.
 */
export type TriggerAnalysisRunError =
    | { readonly type: "dedup_failed"; readonly cause: DbError }
    | { readonly type: "reserve_failed"; readonly cause: unknown }
    | { readonly type: "authorize_failed"; readonly runId: string; readonly cause: unknown }
    | { readonly type: "launch_failed"; readonly runId: string; readonly cause: unknown };

/**
 * Provenance stamped on a cli-launched run. The cli has no conversation-agent
 * session to inherit one from (unlike `executePlan`, which reads
 * `session.provenance`), so this is a synthetic origin label. It is read-only
 * metadata for events/logs/OTel — control flow never branches on it — so a fixed
 * literal is correct.
 */
const RUN_LAUNCH_PROVENANCE: Provenance = { agentId: "cli-run-launch", callPath: ["cli-run-launch"] };

/** `RunDedupCollisionError` recognizer robust to a cross-realm instance (name check), mirroring `execute-plan.ts`. */
function isDedupCollision(cause: unknown): boolean {
    return cause instanceof RunDedupCollisionError || (cause instanceof Error && cause.name === "RunDedupCollisionError");
}

/**
 * Build the workflow input from the plan exactly as `execute-plan.ts` does: a
 * rendered prompt / agent / resources map per step, timeouts only for steps that
 * declare one, and `steps` reduced to the scheduler's `{ id, depends_on }` shape.
 * The `runSession` + `ownsMandate` come from the authorization.
 */
function buildExecuteAnalysisInput(params: TriggerAnalysisRunParams, seams: RunTriggerSeams, authorization: RunAuthorization): ExecuteAnalysisInput {
    const { analysisId, planId, planSummary, plan } = params;
    return {
        analysisId,
        planId,
        planSummary,
        threadId: null,
        steps: plan.steps.map((s) => ({ id: s.id, depends_on: s.depends_on ?? [] })),
        promptByStepId: Object.fromEntries(plan.steps.map((s) => [s.id, seams.renderStepPrompt(s)])),
        agentByStepId: Object.fromEntries(plan.steps.map((s) => [s.id, s.agent ?? "unknown"])),
        resourcesByStepId: Object.fromEntries(
            plan.steps.map((s) => {
                if (!s.resources) {
                    // Defense-in-depth: `validatePlan` (run at plan intake) already
                    // rejects any step without resources, so this is unreachable on
                    // the intake path. Mirrors `execute-plan.ts`'s guard; the
                    // surrounding try in `triggerAnalysisRun` bridges the throw into
                    // the Result channel and compensates the reserved row.
                    throw new Error(`Step "${s.id}" has no resources — validatePlan should have rejected this plan`);
                }
                return [s.id, s.resources];
            }),
        ),
        // `s.timeout` is defined for every element the filter kept, but TS cannot
        // narrow through `.filter`; the cast is sound by that filter.
        timeoutByStepId: Object.fromEntries(plan.steps.filter((s) => s.timeout !== undefined).map((s) => [s.id, s.timeout as number])),
        runSession: authorization.runSession,
        ownsMandate: authorization.ownsMandate,
    };
}

/**
 * Launch the `executeAnalysis` run for a validated plan, replicating
 * `execute-plan.ts` step for step. See the file-level `TODO(extend)` for why this
 * lives in the cli. Returns a `Result` (the cli's default error channel): the
 * throwing harness calls (dedup collision, authorize, launch) are bridged into it.
 */
export async function triggerAnalysisRun(
    seams: RunTriggerSeams,
    params: TriggerAnalysisRunParams,
): Promise<Result<TriggerAnalysisRunResult, TriggerAnalysisRunError>> {
    const { auth, analysisId, planId } = params;

    // (1) Dedup pre-check — the common case is a re-run of the same plan file
    // while its run is still in flight. A hit skips both authorize and launch.
    const preCheck = await seams.queryActiveRun(analysisId, planId);
    if (preCheck.isErr()) return err({ type: "dedup_failed", cause: preCheck.error });
    if (preCheck.value) return ok({ kind: "already_active", runId: preCheck.value.runId, status: preCheck.value.status });

    // (2) Reserve the dedup slot by inserting the row BEFORE authorizing. The
    // partial-unique index is the race backstop: a collision means a concurrent
    // caller won, and we recover its runId via `queryActiveRun` (nothing to revoke
    // — we never authorized).
    //
    // TODO(robustness): a HARD kill (SIGKILL/OOM/power-loss) in the window between
    // this reserve and `seams.launch` persisting the DBOS workflow leaves the row
    // wedged at `running` with no `dbos.workflow_status` row, so recovery has
    // nothing to reclaim. Every later re-run of the byte-identical plan then dedups
    // onto the orphan (`already_active`) and `waitForRunTerminal` polls a row that
    // will never transition. An ordinary throw on either post-reserve path IS
    // compensated below (the row is marked `failed`); only the hard-kill window is
    // exposed. The profile path heals its identical window post-boot via the
    // harness's `reconcileOrphanedDataProfile`; the run engine has no exported
    // `reconcileOrphanedRun` yet — that shared recovery path is deferred to #28.
    const runId = seams.newRunId();
    try {
        const inserted = await seams.insertRun({ runId, analysisId, threadId: null, workflowName: "executeAnalysis", planId });
        if (inserted.isErr()) return err({ type: "reserve_failed", cause: inserted.error });
    } catch (cause) {
        if (isDedupCollision(cause)) {
            const winner = await seams.queryActiveRun(analysisId, planId);
            if (winner.isErr()) return err({ type: "dedup_failed", cause: winner.error });
            if (winner.value) return ok({ kind: "already_active", runId: winner.value.runId, status: winner.value.status });
        }
        return err({ type: "reserve_failed", cause });
    }

    // (3) Authorize the run. The row exists, so the authorizer's persisted handle
    // lands. On failure, mark the reserved row `failed` — releasing the slot so a
    // retry can re-run — and surface it.
    let authorization: RunAuthorization;
    try {
        authorization = await seams.runAuthorizer.authorize({
            auth,
            scope: { kind: "analysis", analysisId },
            provenance: RUN_LAUNCH_PROVENANCE,
            frame: { runId },
        });
    } catch (cause) {
        await seams.updateRunStatus(runId, "failed", "run authorization failed").match(
            () => {},
            () => {},
        );
        return err({ type: "authorize_failed", runId, cause });
    }

    // (4)+(5) Build the workflow input and launch under `workflowId = runId`. Any
    // throw here — the defensive resources guard or the launcher — compensates:
    // revoke the just-issued authorization and mark the row failed so a retry can
    // re-run.
    try {
        const input = buildExecuteAnalysisInput(params, seams, authorization);
        await seams.launch(input, runId);
    } catch (cause) {
        await seams.runAuthorizer.revoke(authorization, "workflow-start-failed").catch(() => {
            // Best-effort revoke on the failure path; the local authorizer's revoke
            // is a no-op anyway, and a revoke that itself fails must not mask the
            // launch failure we are about to report.
        });
        await seams.updateRunStatus(runId, "failed", "workflow start failed").match(
            () => {},
            () => {},
        );
        return err({ type: "launch_failed", runId, cause });
    }

    return ok({ kind: "started", runId });
}

// ── The `inflexa run` command (tasks 4.2 / 4.3 / 4.4) ────────────────────────

/** The `empty`-context hint specific to `inflexa run` (see {@link resolveSingleAnalysis}). */
const RUN_EMPTY_HINT = "No analysis here. Run `inflexa` to start one, add inputs, then `inflexa run`.";

/** Each plan-intake rejection, as one actionable line naming the offending file and the verbatim errors. */
function describePlanIntakeError(e: PlanIntakeError): string {
    switch (e.type) {
        case "read_failed":
            return `Could not read the plan file ${e.path}: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}.`;
        case "invalid_json":
            return `The plan file ${e.path} is not valid JSON: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}.`;
        case "schema_invalid":
            return `The plan file ${e.path} does not match the plan schema:\n${e.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`;
        case "plan_invalid":
            return `The plan in ${e.path} failed validation:\n${e.errors.map((m) => `  - ${m}`).join("\n")}`;
        case "persist_failed":
            return `Could not persist the plan from ${e.path} (${e.cause.type}). Is Postgres reachable?`;
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled plan-intake error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** Each trigger failure, as one actionable line. The post-reserve failures note the row was released for retry. */
function describeTriggerError(e: TriggerAnalysisRunError): string {
    const errText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
    switch (e.type) {
        case "dedup_failed":
            return `Could not check for an existing run (${e.cause.type}). Is Postgres reachable?`;
        case "reserve_failed":
            return `Could not reserve the run row: ${errText(e.cause)}.`;
        case "authorize_failed":
            return `Run authorization failed for ${e.runId}: ${errText(e.cause)}. The row was marked failed — re-run to retry.`;
        case "launch_failed":
            return `Could not start the run workflow for ${e.runId}: ${errText(e.cause)}. The row was marked failed — re-run to retry.`;
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled trigger error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * `inflexa run <analysis> --plan <file>` — the deliberate action that stages
 * files, boots the embedded harness, and launches a full `executeAnalysis` run
 * (no-litter: passive flows never reach any of this). Flow mirrors `inflexa
 * profile` beat for beat: resolve analysis → pre-flight → boot → stage → seed
 * ledger → plan intake → trigger → block to terminal.
 */
export async function runAnalysis(flags: ContextFlags, planPath: string | undefined): Promise<void> {
    const analysis = resolveSingleAnalysis(flags, RUN_EMPTY_HINT);
    if (!planPath) {
        fail("Provide a plan file with `--plan <file>` (a JSON analysis plan to execute). Use `inflexa run --status` to view existing runs.");
    }
    const cfg = resolveHarnessConfig();

    intro(`inflexa run — ${analysis.name}`);

    // Surface an invalid `harness` config block before the image check — see the
    // same guard in `inflexa profile` for why (a config error collapses every
    // field to its default, so a later check would fail misleadingly).
    if (cfg.configError) fail(describeBootError({ type: "harness_config_invalid", issues: cfg.configError.issues }));

    // Short-circuit an analysis with no inputs BEFORE booting (spec:
    // analysis-run-launch — "no resolvable inputs SHALL short-circuit before
    // boot"). This is a read-only reference count, NOT staging, so the "no boot
    // for an empty analysis" contract holds while the real staging + reconciliation
    // still runs post-boot below. A references-but-all-unresolvable analysis is the
    // rare case the post-boot empty check catches.
    const inputRefs = listAnalysisInputs(analysis.id).match((refs) => refs, dieOn("Failed to read the analysis inputs"));
    if (inputRefs.length === 0) {
        fail(`"${analysis.name}" has no inputs — add input files in the chat first, then re-run \`inflexa run --plan <file>\`.`);
    }

    await ensureSandboxImage(cfg.sandboxImage);

    const s = spinner();
    s.start("Booting the harness runtime (Postgres, callback listener, DBOS)");
    const bootResult = await bootHarnessRuntime({ config: cfg });
    const runtime = bootResult.match(
        (r) => r,
        (e) => {
            s.error("Harness runtime boot failed");
            return fail(describeBootError(e));
        },
    );
    s.stop(`Runtime ready — model ${runtime.model}`);

    s.start("Staging inputs");
    const staged = (await stageInputs(analysis.id, sessionTreeDataDir(analysis.id))).match(
        (files) => files,
        (e) => {
            s.error("Staging failed");
            return fail("Failed to stage inputs", e);
        },
    );
    if (staged.length === 0) {
        s.error("Nothing to stage");
        fail(`"${analysis.name}" has no resolvable inputs — add input files in the chat first, then re-run \`inflexa run --plan <file>\`.`);
    }
    s.stop(`Staged ${staged.length} file(s)`);

    // Seed the harness ledger row the trigger's CAS transitions read. Context stays
    // null: the cli has no goal text at run time (the plan carries the intent).
    (
        await upsertAnalysis(
            runtime.pool,
            analysis.id,
            null,
            null,
            staged.map((f) => f.fileId),
        )
    ).match(
        () => {},
        (e) => fail("Failed to seed the harness analysis state", e),
    );

    // Agents orient on `dataprofile/profile-summary.md`, but nothing hard-fails
    // without it — warn and proceed (spec: warns but does not block).
    const profileStatus = (await loadDataProfileStatus(runtime.pool, analysis.id)).match(
        (st) => st,
        () => null,
    );
    if (profileStatus?.status !== "completed") {
        log.warn(
            "No completed data profile — agents orient on `dataprofile/profile-summary.md`, so steps get less context. Run `inflexa profile` first for best results.",
        );
    }

    // Plan intake — read, apply the harness's plan gates, persist under the
    // deterministic id. Each rejection maps to its own actionable message.
    const intake = (await intakePlan(analysis.id, planPath, { upsertPlan: (input) => upsertPlan(runtime.pool, input) })).match(
        (i) => i,
        (e) => fail(describePlanIntakeError(e)),
    );

    // Trigger — the replicated `executePlan` flow.
    const outcome = (
        await triggerAnalysisRun(defaultRunTriggerSeams(runtime.runTriggerDeps), {
            auth: makeLocalAuth(),
            analysisId: analysis.id,
            planId: intake.planId,
            planSummary: intake.planSummary,
            plan: intake.plan,
        })
    ).match(
        (o) => o,
        (e) => fail(describeTriggerError(e)),
    );

    switch (outcome.kind) {
        case "started":
            log.step(`Run started — ${outcome.runId}`);
            break;
        case "already_active":
            log.info(`A run for this plan is already active (${outcome.runId} · ${outcome.status}) — watching it`);
            break;
        default: {
            const exhaustive: never = outcome;
            throw new Error(`unhandled trigger outcome: ${JSON.stringify(exhaustive)}`);
        }
    }

    // The workflow runs inside THIS process's DBOS runtime — exiting now would
    // orphan it until a future boot adopts it. Block until terminal; Ctrl+C is
    // safe (DBOS marks the run recoverable and the next boot resumes it).
    log.info("Ctrl+C detaches; the run resumes on the next `inflexa run`/`inflexa profile` boot — check it with `inflexa run --status`");
    s.start("Running");
    const final = await waitForRunTerminal(runtime.pool, outcome.runId, s);
    await reportTerminal(runtime.pool, final, s);
}

/** One-line progress narration from the per-step ledger + the newest child workflow's DBOS step. */
function renderRunProgress(steps: StepExecutionRow[], detail: { step: number; label: string } | null, startedAt: number): string {
    const total = steps.length;
    const done = steps.filter((st) => st.status === "completed").length;
    const active = steps.filter((st) => st.status === "running").map((st) => st.stepId);
    const head = total > 0 ? `Running — ${done}/${total} step(s) complete` : "Running";
    const activeTail = active.length > 0 ? ` · active: ${active.join(", ")}` : "";
    const detailTail = detail ? ` · ${detail.label}` : "";
    return `${head}${activeTail}${detailTail} · ${formatElapsed(startedAt)}`;
}

/**
 * Poll `cortex_runs` until the run leaves `running`, narrating step-level progress
 * on the spinner. Progress reads (steps + newest DBOS step) are best-effort and
 * NEVER abort the wait; only losing the run row itself is fatal (the row was
 * reserved before launch, so its disappearance is a genuine fault, not routine
 * desync).
 */
async function waitForRunTerminal(pool: Pool, runId: string, s: Spinner): Promise<CortexRunRow> {
    const startedAt = Date.now();
    for (;;) {
        const run = (await queryRun(pool, runId)).match(
            (r) => r,
            (e) => {
                s.error("Lost the ledger connection");
                return fail("Lost the ledger connection while waiting", e);
            },
        );
        if (run === null) {
            s.error("The run row disappeared");
            return fail("The run row disappeared from the ledger while waiting.");
        }
        if (run.status !== "running") return run;

        const steps = (await queryStepsByRun(pool, runId)).unwrapOr([]);
        // Newest workflow of the run family: the parent (`workflow_uuid = runId`) or
        // a child (`runId-N`). A UUID contains no LIKE wildcards, so the pattern is
        // literal apart from the trailing `%`.
        const detail = await readNewestWorkflowStep(pool, {
            text: `SELECT workflow_uuid FROM dbos.workflow_status
                     WHERE workflow_uuid = $1 OR workflow_uuid LIKE $1 || '-%'
                     ORDER BY created_at DESC LIMIT 1`,
            values: [runId],
        });
        s.message(renderRunProgress(steps, detail, startedAt));
        await Promise.sleep(2000);
    }
}

/** Join step ids for a report line; `none` when the set is empty. */
function fmtSteps(ids: string[]): string {
    return ids.length > 0 ? ids.join(", ") : "none";
}

/**
 * Map the terminal `RunStatus` (minus `running`) to a distinct outcome, naming the
 * failed/canceled steps where relevant. `completed` drains cleanly and exits 0 —
 * the runtime's live handles (ingress, pools, DBOS admin) otherwise keep the event
 * loop busy and the process would never exit on its own. Every other terminal
 * status exits non-zero.
 */
async function reportTerminal(pool: Pool, final: CortexRunRow, s: Spinner): Promise<void> {
    const steps = (await queryStepsByRun(pool, final.runId)).unwrapOr([]);
    const done = steps.filter((st) => st.status === "completed").map((st) => st.stepId);
    const failed = steps.filter((st) => st.status === "failed").map((st) => st.stepId);
    const canceled = steps.filter((st) => st.status === "canceled").map((st) => st.stepId);
    const errTail = final.error ? ` (${final.error})` : "";

    switch (final.status) {
        case "completed":
            s.stop(`Run completed — ${done.length} step(s)`);
            outro("Done — inspect details with `inflexa run --status`");
            return shutdown(0);
        case "partial":
            s.error("Run partially completed");
            return fail(
                `Run partial — completed: ${fmtSteps(done)}; failed: ${fmtSteps(failed)}${canceled.length > 0 ? `; canceled: ${fmtSteps(canceled)}` : ""}.${errTail}`,
            );
        case "failed":
            s.error("Run failed");
            return fail(`Run failed — failed step(s): ${fmtSteps(failed)}${canceled.length > 0 ? `; canceled: ${fmtSteps(canceled)}` : ""}.${errTail}`);
        case "canceled":
            s.error("Run canceled");
            return fail(`Run canceled — canceled step(s): ${fmtSteps(canceled)}.${errTail}`);
        case "suspended_insufficient_funds":
            s.error("Run suspended");
            // Do NOT promise "re-run to resume": resuming a suspended run needs the
            // resume entry-point that change 9 owns (`resume-execute-analysis.ts`),
            // not wired here yet. `queryActiveRun` counts this row as active, so a
            // re-run of the same plan dedups onto it and re-reports suspended rather
            // than resuming — the message must not imply otherwise.
            return fail(
                `Run suspended for insufficient funds — add funds, then resume it once run resume lands (track it with \`inflexa run --status\`).${errTail}`,
            );
        case "running":
            // Unreachable: `waitForRunTerminal` returns only on a non-running
            // status. `running` is a member of `RunStatus`, so the switch must
            // still handle it to stay exhaustive; if we ever get here it is a
            // logic fault — bail at the CLI boundary rather than looping.
            return fail("Internal error: reached the terminal report with a still-running row — please report this.");
        default: {
            const exhaustive: never = final.status;
            throw new Error(`unhandled terminal status: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * `inflexa run --status <analysis>` — read-only ledger view. Deliberately never
 * boots the runtime or provisions anything; the pool acquire/drain (shared with
 * `inflexa profile --status`) lives in {@link withStatusPool}.
 */
export async function runAnalysisStatus(flags: ContextFlags): Promise<void> {
    const analysis = resolveSingleAnalysis(flags, RUN_EMPTY_HINT);

    await withStatusPool(async (pool, hasRuntime) => {
        const runs = (await queryRunsByAnalysis(pool, analysis.id)).match(
            (r) => r,
            (e) => fail("Postgres is not reachable — run state lives there. Start it with `inflexa setup` (or launch a run first).", e),
        );
        if (runs.length === 0) {
            console.log(`  "${analysis.name}" has no runs yet. Launch one with \`inflexa run --plan <file>\`.`);
            return;
        }
        console.log(`  Runs for "${analysis.name}" (${analysis.id}):`);
        for (const run of runs) {
            console.log("");
            console.log(`  ${run.runId}  [${run.status}]`);
            console.log(`    plan:       ${run.planId ?? "—"}`);
            console.log(`    started:    ${run.startedAt}`);
            if (run.completedAt) console.log(`    completed:  ${run.completedAt}`);
            if (run.error) console.log(`    error:      ${run.error}`);
            if (run.status === "running" && !hasRuntime) {
                // A `running` row with no runtime in THIS process is usually normal:
                // another inflexa process owns it, or a previous session died mid-run
                // and DBOS resumes the workflow on the next boot. The exception is a
                // row orphaned BEFORE its workflow was launched (the hard-kill window
                // in `triggerAnalysisRun`) — that one has nothing to resume and stays
                // wedged until the #28 run-recovery path lands.
                console.log("    note:       no runtime here — a launched run resumes on the next `inflexa run`/`inflexa profile` boot");
            }
            const steps = (await queryStepsByRun(pool, run.runId)).unwrapOr([]);
            for (const st of steps) {
                const dur = st.durationMs !== null ? ` (${Math.round(st.durationMs / 1000)}s)` : "";
                const stepErr = st.error ? `  ${st.error}` : "";
                console.log(`      - ${st.stepId}  ${st.status}  [${st.agentId}]${dur}${stepErr}`);
            }
        }
    });
}
