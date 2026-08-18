/**
 * Unified async edge for approved plans and explicitly requested one-step ad
 * hoc analyses. Both modes launch the ordinary executeAnalysis workflow.
 */

import { randomUUID } from "node:crypto";
import { ok } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { SANDBOX_AGENT_META } from "../agents/sandbox/index.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import { DEFAULT_SANDBOX_MAX_STEPS } from "../config/resource-limits.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { buildRunCardData } from "../memory/card-builders.js";
import type { ChatProvider } from "../providers/types.js";
import type { ExtendAnalysisFarm, PackageRequest, PackageRequestOutcome } from "../sandbox/types.js";
import { AnalysisPlanSchema, type AnalysisPlan } from "../schemas/workflow-state.js";
import { validatePlan } from "../schemas/validate-plan.js";
import { RunDedupCollisionError, insertRun, loadPlan, queryActiveRun, reserveRunById, updateRunStatus, upsertPlan } from "../state/index.js";
import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import { routeAdHocRequest, type AdHocRoute } from "./ad-hoc-router.js";
import { adHocPlanId, adHocRunId } from "./analysis-invocation.js";
import { defineTool, type ToolContext } from "./define-tool.js";

const planIdSchema = z.string().regex(/^pln-[a-f0-9]{8}$/, "planId must be a pln-<8hex> value");
const inputSchema = z
    .object({
        mode: z.enum(["plan", "adhoc"]),
        planId: planIdSchema.optional(),
        request: z.string().min(1).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.mode === "plan" && (value.planId === undefined || value.request !== undefined)) {
            ctx.addIssue({ code: "custom", message: "plan mode requires planId and forbids request" });
        }
        if (value.mode === "adhoc" && (value.request === undefined || value.planId !== undefined)) {
            ctx.addIssue({ code: "custom", message: "adhoc mode requires request and forbids planId" });
        }
    });

type ExecuteAnalysisWorkflow = (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;

export interface ExecuteAnalysisToolDeps {
    readonly pool: Pool;
    readonly executeAnalysisWorkflow: ExecuteAnalysisWorkflow;
    readonly runAuthorizer: RunAuthorizer;
    readonly runLauncher: RunLauncher;
    readonly resourcePolicy?: ResourcePolicy;
    readonly utilityProvider: ChatProvider;
    readonly utilityModel: string;
    /**
     * The farm-extension seam. The planner names the packages of each step, and
     * this tool links that set into the farm of the analysis before it launches.
     * Thus a step starts with what its plan named, on the chat path and on the
     * replay path alike.
     *
     * Optional, and absence is a normal state. An embedder that binds none has no
     * such capability, and the launch proceeds against the farm it composed. No
     * code branches on which realization is bound.
     */
    readonly extendAnalysisFarm?: ExtendAnalysisFarm;
    readonly logger?: Logger;
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

/** The two outcome states that stop a launch. `linked` and `present` are a success. */
type PackageRefusal = Extract<PackageRequestOutcome, { kind: "absent" | "collision" }>;

/**
 * The mark that separates a wait from a dead end.
 *
 * The harness names no remedy of its own. An acquisition is a host action, and the
 * command that takes it belongs to the host: a managed deployment has no `inflexa`
 * binary, thus a remedy in this text would name a command that a user there cannot
 * run. The embedder writes the remedy into the `reason` of each outcome, because
 * only the embedder holds the pool.
 */
const NO_ACQUISITION_NOTE = "One request names a package that this store can never acquire, thus no retry and no later attempt succeeds.";

/** A farm holds one version of one top-level name. */
const COLLISION_NOTE = "A farm holds one version of one name, thus no retry succeeds. Report both store directories.";

/** One refusal, as a line that names the package and the reason of the pool. */
function describeRefusal(refusal: PackageRefusal): string {
    if (refusal.kind === "collision") {
        return (
            `"${refusal.requested}": the farm already links a different version of "${refusal.name}". ` +
            `It links ${refusal.linkedDirectory}, and the plan asks for ${refusal.requestedDirectory}.`
        );
    }
    // The seam gives a lowercase fragment, because only the embedder holds the pool
    // and only the embedder knows the reason.
    return `"${refusal.requested}": ${refusal.reason}.`;
}

/**
 * The refusal that a person reads. A bare "not found" sends a caller around the same
 * loop for ever. Thus each line carries the reason of the embedder, and this text adds
 * only the rules that the harness itself holds.
 */
function describePackageRefusals(planId: string, refusals: readonly PackageRefusal[]): string {
    const absent = refusals.filter((refusal): refusal is Extract<PackageRefusal, { kind: "absent" }> => refusal.kind === "absent");
    return [
        `The packages of plan ${planId} did not all reach the farm of this analysis, thus the run did not start.`,
        ...refusals.map((refusal) => `  - ${describeRefusal(refusal)}`),
        ...(absent.some((refusal) => !refusal.acquisitionPossible) ? [NO_ACQUISITION_NOTE] : []),
        ...(refusals.some((refusal) => refusal.kind === "collision") ? [COLLISION_NOTE] : []),
    ].join("\n\n");
}

/**
 * The packages that a plan names, and that the pool did not give.
 *
 * The conversation agent reads the message and relays it to the user. Thus the
 * message carries each refusal, and not a count of them.
 */
export class PlanPackagesUnavailableError extends Error {
    constructor(
        planId: string,
        readonly refusals: readonly PackageRefusal[],
    ) {
        super(describePackageRefusals(planId, refusals));
        this.name = "PlanPackagesUnavailableError";
    }
}

/**
 * Link the packages that the plan names into the farm of the analysis, before the
 * run takes a reservation.
 *
 * The planner names the packages of each step, and this pass is the one place
 * where that set meets the pool on the chat path. The seam links from the pool and
 * it acquires nothing, thus the call starts no container and it opens no network
 * connection.
 *
 * The set is not a promise of completeness. A step that meets a package which the
 * plan did not name reaches it through `link_packages`. Thus one package that a
 * plan missed does not stop a run.
 */
async function linkPlanPackages(deps: ExecuteAnalysisToolDeps, args: { analysisId: string; planId: string; plan: AnalysisPlan }): Promise<void> {
    if (!deps.extendAnalysisFarm) return;
    // A farm is one tree for the whole analysis, thus one request answers each step
    // that names the same package.
    const requested = [...new Set(args.plan.steps.flatMap((step) => step.packages ?? []))];
    if (requested.length === 0) return;
    const outcomes = await deps.extendAnalysisFarm(
        args.analysisId,
        // `distribution` because the planner writes requirement form, and
        // `validatePlan` refused each entry that is not one.
        requested.map((requirement): PackageRequest => ({ kind: "distribution", requirement })),
    );
    const refusals = outcomes.filter((outcome): outcome is PackageRefusal => outcome.kind === "absent" || outcome.kind === "collision");
    if (refusals.length > 0) throw new PlanPackagesUnavailableError(args.planId, refusals);
}

function isDedupCollision(err: unknown): boolean {
    return err instanceof RunDedupCollisionError || (err instanceof Error && err.name === "RunDedupCollisionError");
}

function planSummary(plan: AnalysisPlan): string {
    return plan.title?.trim() || plan.analytical_narrative.trim().slice(0, 280);
}

function workflowInput(
    planId: string,
    plan: AnalysisPlan,
    args: {
        analysisId: string;
        threadId: string | null;
        runSession: ExecuteAnalysisInput["runSession"];
        ownsMandate: boolean;
        budget: ExecuteAnalysisInput["budget"];
        synthesisEnabled: boolean;
    },
): ExecuteAnalysisInput {
    return {
        analysisId: args.analysisId,
        planId,
        planSummary: planSummary(plan),
        threadId: args.threadId,
        steps: plan.steps.map((step) => ({ id: step.id, depends_on: step.depends_on ?? [] })),
        planStepById: Object.fromEntries(plan.steps.map((step) => [step.id, step])),
        agentByStepId: Object.fromEntries(plan.steps.map((step) => [step.id, step.agent ?? "unknown"])),
        resourcesByStepId: Object.fromEntries(
            plan.steps.map((step) => {
                if (!step.resources) throw new Error(`Step "${step.id}" has no resources — validation should have rejected it`);
                return [step.id, step.resources];
            }),
        ),
        timeoutByStepId: Object.fromEntries(plan.steps.filter((step) => step.timeout !== undefined).map((step) => [step.id, step.timeout as number])),
        budget: args.budget,
        runSession: args.runSession,
        ownsMandate: args.ownsMandate,
        synthesisEnabled: args.synthesisEnabled,
    };
}

function validateStoredPlan(raw: unknown, planId: string): AnalysisPlan {
    const parsed = AnalysisPlanSchema.safeParse(raw);
    if (!parsed.success) throw new PlanMalformedError(planId);
    const result = validatePlan(parsed.data);
    if (!result.valid) throw new PlanValidationError(planId, result.errors);
    return parsed.data;
}

function adHocTitle(request: string): string {
    const compact = request.trim().replace(/\s+/g, " ");
    return compact.length <= 80 ? compact : `${compact.slice(0, 77)}…`;
}

export function buildAdHocPlan(request: string, route: AdHocRoute, createdAt = new Date().toISOString()): AnalysisPlan {
    const meta = SANDBOX_AGENT_META[route.agentId];
    const plan: AnalysisPlan = {
        title: adHocTitle(request),
        analytical_narrative: `Execute one targeted analysis step for the explicit request: ${request}`,
        created_at: createdAt,
        steps: [
            {
                id: "T1S1",
                name: "Ad hoc analysis",
                track: "ad-hoc",
                step_type: "analysis",
                question: request,
                context: `Automatically routed to ${route.agentId}. Routing rationale: ${route.rationale}`,
                constraints: [
                    "Use the staged analysis inputs and persisted data profile; do not invent missing data.",
                    "Complete only this targeted request; do not expand it into a multi-step plan.",
                ],
                acceptance_criteria: [
                    "Persist every script needed to reproduce the computation.",
                    "Persist machine-readable result file(s), even when the answer is a single scalar.",
                    "Provide a direct result summary grounded in the persisted outputs.",
                ],
                caveats: route.fallbackClass ? [`Automatic routing fallback: ${route.fallbackClass}`] : undefined,
                depends_on: [],
                status: "pending",
                resources: route.resources,
                agent: route.agentId,
                maxSteps: meta?.defaultMaxSteps ?? DEFAULT_SANDBOX_MAX_STEPS,
            },
        ],
    };
    return AnalysisPlanSchema.parse(plan);
}

async function persistedAdHocPlan(
    deps: ExecuteAnalysisToolDeps,
    args: { analysisId: string; request: string; ctx: ToolContext; planId: string },
): Promise<AnalysisPlan> {
    const existing = unwrapOrThrow(await loadPlan(deps.pool, args.planId, { analysisId: args.analysisId }));
    if (existing) return validateStoredPlan(existing, args.planId);

    const route = await routeAdHocRequest(
        {
            provider: deps.utilityProvider,
            model: deps.utilityModel,
            pool: deps.pool,
            resourcePolicy: deps.resourcePolicy,
            logger: deps.logger,
        },
        { analysisId: args.analysisId, request: args.request, session: args.ctx.session, signal: args.ctx.signal },
    );
    const candidate = buildAdHocPlan(args.request, route);
    unwrapOrThrow(await upsertPlan(deps.pool, { planId: args.planId, analysisId: args.analysisId, plan: candidate }));
    const stored = unwrapOrThrow(await loadPlan(deps.pool, args.planId, { analysisId: args.analysisId }));
    if (!stored) throw new Error(`Internal ad hoc plan ${args.planId} could not be reloaded`);
    return validateStoredPlan(stored, args.planId);
}

export function createExecuteAnalysisTool(deps: ExecuteAnalysisToolDeps) {
    const logger = (deps.logger ?? createNoopLogger()).named("execute-analysis-tool");
    return defineTool({
        id: "execute_analysis",
        description:
            "Launch analysis computation asynchronously. Use mode=plan with the planId only after the user approved that stored plan. " +
            "Use mode=adhoc with the user's exact targeted computational request when they explicitly asked to run/compute/test/compare it; " +
            "that explicit request is consent and needs no synthetic-plan approval. If computation is merely your suggestion, ask first. " +
            "You never choose the sandbox specialist: ad hoc routing does that automatically. Returns runId with status=in_progress; inspect results on a later turn.",
        inputSchema,
        // The mode is what a user most needs to see here — an approved plan
        // running is a different event from an ad hoc request being routed.
        describeCall: (input) => (input.mode === "plan" ? `plan ${input.planId ?? ""}` : `ad hoc: ${input.request ?? ""}`),
        execute: async (input, ctx) => {
            if (ctx.session.scope.kind !== "analysis") throw new Error("execute_analysis requires an analysis-scoped session");
            if (!ctx.session.auth) throw new Error("execute_analysis: session is missing its auth capability");
            const analysisId = ctx.session.scope.analysisId;
            const threadId = ctx.session.scope.threadId ?? null;
            const planId = input.mode === "plan" ? input.planId! : adHocPlanId(analysisId, ctx.invocationId);
            const emitRunCard = async (runId: string) => {
                const card = await buildRunCardData(deps.pool, { planId, analysisId, runId }).unwrapOr(null);
                if (card) await ctx.emit({ type: "data-run-card", source: ctx.session.provenance, data: card });
            };

            let plan: AnalysisPlan;
            if (input.mode === "plan") {
                const raw = unwrapOrThrow(await loadPlan(deps.pool, planId, { analysisId }));
                if (!raw) throw new PlanNotFoundError(planId);
                plan = validateStoredPlan(raw, planId);
                const active = unwrapOrThrow(await queryActiveRun(deps.pool, analysisId, planId));
                if (active) {
                    await emitRunCard(active.runId);
                    return ok({ runId: active.runId, status: "in_progress" as const });
                }
            } else {
                plan = await persistedAdHocPlan(deps, { analysisId, request: input.request!, ctx, planId });
            }

            // The packages of the plan reach the farm here. The plan is valid, and
            // the run holds no reservation, no mandate, and no ledger row yet. Thus a
            // refusal costs nothing to release, and the same plan starts clean after
            // the user acquires what the pool lacks.
            await linkPlanPackages(deps, { analysisId, planId, plan });

            const runId = input.mode === "plan" ? randomUUID() : adHocRunId(analysisId, ctx.invocationId);
            if (input.mode === "plan") {
                try {
                    unwrapOrThrow(
                        await insertRun(deps.pool, {
                            runId,
                            analysisId,
                            threadId,
                            workflowName: "executeAnalysis",
                            planId,
                        }),
                    );
                } catch (error) {
                    if (isDedupCollision(error)) {
                        const active = unwrapOrThrow(await queryActiveRun(deps.pool, analysisId, planId));
                        if (active) {
                            await emitRunCard(active.runId);
                            return ok({ runId: active.runId, status: "in_progress" as const });
                        }
                    }
                    throw error;
                }
            } else {
                const reservation = unwrapOrThrow(
                    await reserveRunById(deps.pool, {
                        runId,
                        analysisId,
                        threadId,
                        workflowName: "executeAnalysis",
                        planId,
                    }),
                );
                if (!reservation.inserted) {
                    await emitRunCard(reservation.row.runId);
                    return ok({ runId: reservation.row.runId, status: "in_progress" as const });
                }
            }

            let authorization;
            try {
                authorization = await deps.runAuthorizer.authorize({
                    auth: ctx.session.auth,
                    scope: ctx.session.scope,
                    provenance: ctx.session.provenance,
                    frame: { runId },
                });
            } catch (error) {
                await updateRunStatus(deps.pool, runId, "failed", "run authorization failed").match(
                    () => {},
                    () => {},
                );
                throw error;
            }

            const wfInput = workflowInput(planId, plan, {
                analysisId,
                threadId,
                runSession: authorization.runSession,
                ownsMandate: authorization.ownsMandate,
                budget: deps.resourcePolicy?.budget,
                synthesisEnabled: input.mode === "plan",
            });
            try {
                await deps.runLauncher.launch(deps.executeAnalysisWorkflow, { workflowId: runId }, wfInput);
            } catch (error) {
                await deps.runAuthorizer.revoke(authorization, "workflow-start-failed").catch(() => {});
                await updateRunStatus(deps.pool, runId, "failed", "workflow start failed").match(
                    () => {},
                    () => {},
                );
                throw error;
            }

            logger.info("analysis launched", { analysisId, runId, planId, mode: input.mode });
            await emitRunCard(runId);
            return ok({ runId, status: "in_progress" as const });
        },
    });
}
