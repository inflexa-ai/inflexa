/**
 * executePlan — launch the DBOS `executeAnalysis` parent workflow for an
 * approved plan.
 *
 * Results are pull-only: the tool does NOT register a `.then(saveRunResult)`
 * or any completion callback that writes to the conversation thread. The
 * conversation agent retrieves run results via `inspectRun` on a later turn.
 *
 * Authorization contract: the tool runs in the chat HTTP route, so its session
 * carries the live auth. It authorizes through the injected `RunAuthorizer`
 * seam and never reads a credential. The flow is dedup → reserve → authorize
 * → startWorkflow:
 *
 *   1. Dedup pre-check via `queryActiveRun`. On hit, return the existing
 *      `runId` with no authorization and no `startWorkflow`.
 *   2. Reserve the slot: `insertRun` the `cortex_runs` row (`runId =
 *      randomUUID()`, the bare UUID that IS the DBOS workflowID) BEFORE
 *      authorizing. The partial-unique index is the race backstop; the loser
 *      returns the winner's `runId` without authorizing — nothing to revoke.
 *   3. `runAuthorizer.authorize({ ..., frame: { runId } })` — authorizes the
 *      run; the authorizer's persisted handle now lands because the row
 *      exists. On failure, mark the reserved row `failed` (releasing the dedup
 *      slot for a retry) and rethrow.
 *   4. `runLauncher.launch(executeAnalysis, { workflowId: runId }, ...)`,
 *      passing the `RunSession` in the workflow input. On failure, revoke + mark
 *      failed.
 */

import { randomUUID } from "node:crypto";
import { ok } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { buildRunCardData } from "../memory/card-builders.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import { unwrapOrThrow } from "../lib/result.js";
import { validatePlan } from "../schemas/validate-plan.js";
import { AnalysisPlanSchema, type AnalysisPlan } from "../schemas/workflow-state.js";
import { renderStepPrompt } from "../schemas/render-step-prompt.js";
import { RunDedupCollisionError, insertRun, loadPlan, queryActiveRun, updateRunStatus } from "../state/index.js";
import { defineTool } from "./define-tool.js";

const planIdSchema = z.string().regex(/^pln-[a-f0-9]{8}$/, "planId must be a pln-<8hex> value");

const inputSchema = z.object({
    planId: planIdSchema,
});

type ExecuteAnalysisWorkflow = (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;

export interface ExecutePlanToolDeps {
    readonly pool: Pool;
    /** Registered DBOS workflow function — produced by `registerAnalysisWorkflows`. */
    readonly executeAnalysisWorkflow: ExecuteAnalysisWorkflow;
    /** Authorizes the run at the async edge and revokes on the abort paths. */
    readonly runAuthorizer: RunAuthorizer;
    /** Starts the durable run — the durability engine stays behind this seam. */
    readonly runLauncher: RunLauncher;
    /**
     * Host resource policy. The machine budget is snapshotted into the workflow
     * input here at the async edge — the workflow body never reads live config,
     * so a mid-run config edit cannot change a running run's admission decisions.
     */
    readonly resourcePolicy?: ResourcePolicy;
}

export class PlanNotFoundError extends Error {
    constructor(planId: string) {
        super(`Plan ${planId} not found for this analysis`);
        this.name = "PlanNotFoundError";
    }
}

export class PlanMalformedError extends Error {
    constructor(planId: string) {
        super(`Plan ${planId} is malformed`);
        this.name = "PlanMalformedError";
    }
}

export class PlanValidationError extends Error {
    constructor(
        planId: string,
        readonly errors: string[],
    ) {
        super(`Plan ${planId} failed validation: ${errors.length} error(s)`);
        this.name = "PlanValidationError";
    }
}

function isDedupCollision(err: unknown): boolean {
    return err instanceof RunDedupCollisionError || (err instanceof Error && err.name === "RunDedupCollisionError");
}

export function createExecutePlanTool(deps: ExecutePlanToolDeps) {
    const { pool, executeAnalysisWorkflow, runAuthorizer, runLauncher, resourcePolicy } = deps;
    return defineTool({
        id: "execute_plan",
        description:
            "Execute an approved analysis plan by its planId. " +
            "Pass the planId returned from generatePlan — the tool resolves the plan " +
            "server-side, validates the DAG, and starts the executeAnalysis workflow " +
            "asynchronously. Returns the runId on success. " +
            "The user sees a run card in chat (also tracked in the Runs panel); " +
            "run results become available for inspection on a later turn. " +
            "Do not instruct the user to invoke any tool.",
        inputSchema,
        execute: async (input, ctx) => {
            const { planId } = input;
            // Mirror show_plan: emit a live display card so chat renders a run card
            // rather than a generic "used 1 tool" chip. Null (plan/run unresolvable)
            // simply skips the card — the run still starts.
            const emitRunCard = async (analysisId: string, runId: string) => {
                const card = await buildRunCardData(pool, {
                    planId,
                    analysisId,
                    runId,
                }).unwrapOr(null);
                if (card) {
                    await ctx.emit({
                        type: "data-run-card",
                        source: ctx.session.provenance,
                        data: card,
                    });
                }
            };
            const { session } = ctx;
            if (session.scope.kind !== "analysis") {
                throw new Error("executePlan can only be invoked on an analysis-scoped session");
            }
            if (!session.auth) {
                throw new Error("executePlan: session is missing its auth capability");
            }
            const analysisId = session.scope.analysisId;
            const threadId = session.scope.threadId ?? null;

            const raw = unwrapOrThrow(await loadPlan(pool, planId, { analysisId }));
            if (!raw) throw new PlanNotFoundError(planId);

            const parsed = AnalysisPlanSchema.safeParse(raw);
            if (!parsed.success) throw new PlanMalformedError(planId);

            const plan: AnalysisPlan = parsed.data;
            const result = validatePlan(plan);
            if (!result.valid) {
                throw new PlanValidationError(planId, result.errors);
            }

            // (1) Dedup pre-check — common case is the user re-clicked Execute on
            // an in-flight plan. A hit avoids both the authorization and the DBOS
            // startWorkflow.
            const existingPre = unwrapOrThrow(await queryActiveRun(pool, analysisId, planId));
            if (existingPre) {
                await emitRunCard(analysisId, existingPre.runId);
                return ok({ runId: existingPre.runId });
            }

            // (2) Reserve the dedup slot by inserting the run row BEFORE authorizing.
            // The partial-unique index is the race backstop for two callers that both
            // passed the pre-check; the loser returns the winner's runId without
            // having authorized — there is nothing to revoke. The authorization handle is left
            // null here and populated by the authorizer, whose UPDATE lands
            // because the row now exists.
            const runId = randomUUID();
            try {
                // On the dedup collision `insertRun` throws `RunDedupCollisionError`
                // (a control-flow signal that rides out of the ResultAsync as a
                // rejection) — `unwrapOrThrow` never sees it; the catch below does.
                unwrapOrThrow(
                    await insertRun(pool, {
                        runId,
                        analysisId,
                        threadId,
                        workflowName: "executeAnalysis",
                        planId,
                    }),
                );
            } catch (err) {
                if (isDedupCollision(err)) {
                    const existing = unwrapOrThrow(await queryActiveRun(pool, analysisId, planId));
                    if (existing) {
                        await emitRunCard(analysisId, existing.runId);
                        return ok({ runId: existing.runId });
                    }
                }
                throw err;
            }

            // (3) Authorize the run. The row exists, so the authorizer's persisted handle
            // persists. On failure, mark the reserved row failed — releasing the
            // partial-unique slot so a retry can re-run — and rethrow.
            let authorization;
            try {
                authorization = await runAuthorizer.authorize({
                    auth: session.auth,
                    scope: session.scope,
                    provenance: session.provenance,
                    frame: { runId },
                });
            } catch (err) {
                await updateRunStatus(pool, runId, "failed", "run authorization failed").match(
                    () => {},
                    () => {},
                );
                throw err;
            }
            const { runSession } = authorization;

            const planSummary = plan.title?.trim() || plan.analytical_narrative.trim().slice(0, 280);

            const workflowInput: ExecuteAnalysisInput = {
                analysisId,
                planId,
                planSummary,
                threadId,
                steps: plan.steps.map((s) => ({
                    id: s.id,
                    depends_on: s.depends_on ?? [],
                })),
                promptByStepId: Object.fromEntries(plan.steps.map((s) => [s.id, renderStepPrompt(s)])),
                agentByStepId: Object.fromEntries(plan.steps.map((s) => [s.id, s.agent ?? "unknown"])),
                resourcesByStepId: Object.fromEntries(
                    plan.steps.map((s) => {
                        if (!s.resources) {
                            throw new Error(`Step "${s.id}" has no resources — validatePlan should have rejected this plan`);
                        }
                        return [s.id, s.resources];
                    }),
                ),
                timeoutByStepId: Object.fromEntries(plan.steps.filter((s) => s.timeout !== undefined).map((s) => [s.id, s.timeout as number])),
                budget: resourcePolicy?.budget,
                runSession,
                ownsMandate: authorization.ownsMandate, // oss-core-managed-ok
            };

            // (4) Dispatch the workflow. `workflowId = runId` — both are the same
            // bare UUID. On failure after insert + authorize, revoke the authorization and
            // mark the row failed.
            try {
                await runLauncher.launch(executeAnalysisWorkflow, { workflowId: runId }, workflowInput);
            } catch (err) {
                await runAuthorizer.revoke(authorization, "workflow-start-failed").catch(() => {});
                await updateRunStatus(pool, runId, "failed", "workflow start failed").match(
                    () => {},
                    () => {},
                );
                throw err;
            }

            await emitRunCard(analysisId, runId);
            return ok({ runId });
        },
    });
}
