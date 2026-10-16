/**
 * Unified async edge for approved plans and explicitly requested one-step ad
 * hoc analyses. Both modes launch the ordinary executeAnalysis workflow.
 */

import { randomUUID } from "node:crypto";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { SANDBOX_AGENT_META } from "../agents/sandbox/index.js";
import type { AgentSession } from "../auth/types.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { EnvironmentStorePaths } from "../config/environment-stores.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import { DEFAULT_SANDBOX_MAX_STEPS } from "../config/resource-limits.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { deliverNotice, passGate } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { buildRunCardData } from "../memory/card-builders.js";
import type { ChatProvider } from "../providers/types.js";
import { formatQuery, parseQuery, type PackageQuery } from "../sandbox/package-identity.js";
import type { ExtendAnalysisFarm } from "../sandbox/types.js";
import { AnalysisPlanSchema, type AnalysisPlan } from "../schemas/workflow-state.js";
import { validatePlan } from "../schemas/validate-plan.js";
import { RunDedupCollisionError, insertRun, loadPlan, queryActiveRun, reserveRunById, suspendAnalysis, updateRunStatus, upsertPlan } from "../state/index.js";
import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import { routeAdHocRequest, type AdHocRoute, type AdHocRouterDeps } from "./ad-hoc-router.js";
import { adHocPlanId, adHocRunId } from "./analysis-invocation.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { queryPackages, readInventorySections, type ListAvailablePackagesDeps } from "./sandbox/list-available-packages.js";
import { callExtendAnalysisFarm } from "./sandbox/link-packages.js";
import { errorName } from "../lib/thrown.js";

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the grammar of this module's input: no builtin or parser knows it.
const planIdSchema = z.string().regex(/^pln-[a-f0-9]{8}$/, "planId must be a pln-<8hex> value");
const inputSchema = z
    .object({
        mode: z
            .enum(["plan", "adhoc"])
            .describe("`plan` runs a stored plan that the user approved. `adhoc` runs one targeted step for an explicit user request."),
        planId: planIdSchema
            .optional()
            .describe("mode=plan only, and required there: the `pln-<8hex>` id of the approved stored plan. Omit it for mode=adhoc."),
        request: z
            .string()
            .min(1)
            .optional()
            .describe("mode=adhoc only, and required there: the computational request of the user, in the words of the user. Omit it for mode=plan."),
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

// The `superRefine` of the input schema rejects a mode whose companion field is
// missing before `execute` sees the input; this helper hands the body that value.
function guaranteed<T>(value: T | undefined, field: string): T {
    if (value === undefined) throw new Error(`the input schema must supply ${field}`);
    return value;
}

export type ExecuteAnalysisToolDeps = Pick<EnvironmentStorePaths, "farmLockFile" | "imagePackagesFile" | "readPoolInventory"> & {
    readonly pool: Pool;
    readonly executeAnalysisWorkflow: ExecuteAnalysisWorkflow;
    readonly runAuthorizer: RunAuthorizer;
    readonly runLauncher: RunLauncher;
    readonly resourcePolicy?: ResourcePolicy;
    readonly utilityProvider: ChatProvider;
    readonly utilityModel: string;
    readonly logger?: Logger;
    /**
     * The farm-extension seam of the embedder. When it is bound, the launch
     * links the packages of the plan into the farm of the analysis before the
     * run reserves anything. Without it, the link pass returns at once.
     */
    readonly extendAnalysisFarm?: ExtendAnalysisFarm;
    /** Falls back to the no-op recorder when omitted. */
    readonly usageRecorder?: UsageRecorder;
};

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
    return err instanceof RunDedupCollisionError || errorName(err) === "RunDedupCollisionError";
}

/**
 * A pool miss at the pre-launch link pass. The message names the missing
 * packages and no remedy command — the remedy belongs to the embedder, and
 * its wrapper appends it.
 */
export class PlanPackagesMissingError extends Error {
    constructor(
        readonly missing: string[],
        readonly collisions: string[],
        readonly unavailable?: string,
    ) {
        const parts = [
            // The store-level reason FIRST, because it invalidates the rest: with an
            // unreadable graph, no per-package claim below it is trustworthy.
            unavailable !== undefined
                ? `the store cannot answer (${unavailable}) — this says nothing about the packages themselves, so do not re-request them`
                : null,
            missing.length > 0 ? `the pool does not hold: ${missing.join(", ")}` : null,
            collisions.length > 0 ? `a collision refused: ${collisions.join(", ")}` : null,
        ].filter((p: string | null): p is string => p !== null);
        super(`The packages of this plan cannot link — ${parts.join("; ")}`);
        this.name = "PlanPackagesMissingError";
    }
}

/** The deps that start the run of a stored plan. */
export type LaunchPlanRunDeps = Pick<
    ExecuteAnalysisToolDeps,
    "pool" | "executeAnalysisWorkflow" | "runAuthorizer" | "runLauncher" | "resourcePolicy" | "extendAnalysisFarm" | "logger"
>;

/** The run of a stored plan. `started` is false when a run of the plan was already active. */
export type PlanLaunch = { runId: string; started: boolean };

/**
 * Why a stored plan did not start a run. `store_failed.cause` and `launch_failed.cause` are the
 * values as the failing call gave them, thus a caller that must throw them keeps their class.
 */
export type LaunchPlanRunRefusal =
    | { type: "plan_not_found"; planId: string }
    | { type: "plan_invalid"; planId: string; malformed: boolean; errors: string[] }
    | { type: "packages_missing"; missing: string[]; collisions: string[]; unavailable?: string }
    | { type: "not_authorized"; reason: string }
    | { type: "suspended"; reason: string }
    | { type: "store_failed"; cause: unknown }
    | { type: "launch_failed"; cause: unknown };

/**
 * Link the packages of the plan into the farm of the analysis, before the
 * run reserves anything. The linked set is the union of the queries of each
 * step. A pool miss and a collision refuse the launch with the spellings.
 * Without a bound seam, the pass returns at once.
 *
 * @returns How many queries reached the seam. Zero says that nothing was
 * checked — an unbound seam, or a plan whose steps declare no package — which
 * is what the launch record must carry to tell a checked launch from an
 * unchecked one.
 */
async function linkPlanPackages(
    extendAnalysisFarm: ExtendAnalysisFarm | undefined,
    analysisId: string,
    planId: string,
    plan: AnalysisPlan,
): Promise<Result<number, LaunchPlanRunRefusal>> {
    if (!extendAnalysisFarm) return ok(0);
    // The union dedupes EQUAL queries only: two entries are one ask when their
    // spelling, their track, and their version are equal. A bare entry beside a
    // qualified entry of one spelling stays two asks, because the bare one
    // carries its own refusal — an absorption would drop the pin of one entry
    // and silence a wrong track.
    const union = new Map<string, PackageQuery>();
    for (const step of plan.steps) {
        for (const entry of step.packages ?? []) {
            const parsed = parseQuery(entry);
            if (parsed.isErr()) {
                // `validatePlan` parsed every entry of this plan already, thus a
                // refusal here means that the two readers disagree.
                return err({
                    type: "plan_invalid",
                    planId,
                    malformed: false,
                    errors: [`Step "${step.id}" carries the package entry "${entry}", which the plan validation should have refused`],
                });
            }
            const query = parsed.value;
            const key = formatQuery(query);
            if (!union.has(key)) union.set(key, query);
        }
    }
    const queries = [...union.values()];
    if (queries.length === 0) return ok(0);
    const linked = await callExtendAnalysisFarm(extendAnalysisFarm, analysisId, queries);
    if (linked.isErr()) {
        // A call that gave no answer is an `unavailable` answer, not a driver
        // error: the planner can act on "the store cannot answer".
        return err({ type: "packages_missing", missing: [], collisions: [], unavailable: linked.error });
    }
    const outcomes = linked.value;
    // An `unavailable` outcome preempts everything: the link pass could not
    // answer at all (an unreadable graph, a locked farm), so a per-package
    // absence list would be a fabrication. One reason covers the batch.
    const unavailable = outcomes.find((o) => o.kind === "unavailable");
    if (unavailable !== undefined) {
        return err({ type: "packages_missing", missing: [], collisions: [], unavailable: unavailable.reason });
    }
    // A seam-supplied detail classifies the miss in host terms (in flight,
    // failed with its reason, never requested), and it rides beside the name
    // so the agent replans from the true state instead of re-asking. A
    // collision's detail names the two pins and what needs each side — the
    // remedy is to drop or re-pin a DEPENDENT, so the refusal must name it.
    const missing = outcomes.filter((o) => o.kind === "absent").map((o) => (o.detail === undefined ? o.spelling : `${o.spelling} — ${o.detail}`));
    // A collision names the two store directories AND the two prefixed forms.
    // One spelling that both tracks hold is the common cause, and the prefix is
    // the remedy that a plan can write. `formatQuery` writes the two forms,
    // thus the refusal quotes the grammar that the plan reads.
    //
    // The prefix carries its CONDITION, because the outcome shape cannot tell
    // the two collisions apart: two versions of one distribution collide too,
    // and a prefix there resolves nothing. An unconditional instruction would
    // send the agent through a second launch that refuses identically.
    const collisions = outcomes
        .filter((o) => o.kind === "collision")
        .map(
            (o) =>
                `${o.spelling} — two store directories claim it, ${o.storeDirs[0]} and ${o.storeDirs[1]}` +
                (o.detail === undefined ? "" : ` (${o.detail})`) +
                `; when the two directories are one spelling in two tracks, name the track in the plan, as ` +
                `${formatQuery({ spelling: o.spelling, track: "python" })} or ${formatQuery({ spelling: o.spelling, track: "r" })}`,
        );
    if (missing.length > 0 || collisions.length > 0) {
        return err({ type: "packages_missing", missing, collisions });
    }
    return ok(queries.length);
}

function planSummary(plan: AnalysisPlan): string {
    return plan.title?.trim() || plan.analytical_narrative.trim().slice(0, 280);
}

/**
 * The resources of each step. `validatePlan` refuses a step without them, thus
 * a missing entry here means that the two readers disagree.
 */
function stepResources(planId: string, plan: AnalysisPlan): Result<ExecuteAnalysisInput["resourcesByStepId"], LaunchPlanRunRefusal> {
    const byStepId: Record<string, ExecuteAnalysisInput["resourcesByStepId"][string]> = {};
    for (const step of plan.steps) {
        if (!step.resources) {
            return err({
                type: "plan_invalid",
                planId,
                malformed: false,
                errors: [`Step "${step.id}" has no resources — validation should have rejected it`],
            });
        }
        byStepId[step.id] = step.resources;
    }
    return ok(byStepId);
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
        resourcesByStepId: ExecuteAnalysisInput["resourcesByStepId"];
    },
): ExecuteAnalysisInput {
    return {
        analysisId: args.analysisId,
        planId,
        planSummary: planSummary(plan),
        threadId: args.threadId,
        steps: plan.steps.map((step) => ({ id: step.id, depends_on: step.depends_on })),
        planStepById: Object.fromEntries(plan.steps.map((step) => [step.id, step])),
        agentByStepId: Object.fromEntries(plan.steps.map((step) => [step.id, step.agent ?? "unknown"])),
        resourcesByStepId: args.resourcesByStepId,
        timeoutByStepId: Object.fromEntries(plan.steps.flatMap((step): [string, number][] => (step.timeout === undefined ? [] : [[step.id, step.timeout]]))),
        budget: args.budget,
        runSession: args.runSession,
        ownsMandate: args.ownsMandate,
        synthesisEnabled: args.synthesisEnabled,
    };
}

function parseStoredPlan(raw: unknown, planId: string): Result<AnalysisPlan, Extract<LaunchPlanRunRefusal, { type: "plan_invalid" }>> {
    const parsed = AnalysisPlanSchema.safeParse(raw);
    if (!parsed.success) return err({ type: "plan_invalid", planId, malformed: true, errors: [] });
    const result = validatePlan(parsed.data);
    if (!result.valid) return err({ type: "plan_invalid", planId, malformed: false, errors: result.errors });
    return ok(parsed.data);
}

/** The error that a tool body throws for a stored plan that the parse refused. */
function validateStoredPlan(raw: unknown, planId: string): AnalysisPlan {
    const parsed = parseStoredPlan(raw, planId);
    if (parsed.isErr()) return throwLaunchRefusal(parsed.error);
    return parsed.value;
}

function adHocTitle(request: string): string {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the grammar of this module's input: no builtin or parser knows it.
    const compact = request.trim().replace(/\s+/g, " ");
    return compact.length <= 80 ? compact : `${compact.slice(0, 77)}…`;
}

/** How a dropped entry reads to the step agent, in the terms of its own reason. */
const DROP_REASON_TEXT: Record<AdHocRoute["droppedPackages"][number]["reason"], string> = {
    unparsable: "does not parse",
    absent: "the pool does not hold it",
};

/**
 * What the step agent must know about the packages that it did not choose.
 * The routing guessed them, and no person reviewed that guess, thus a drop and
 * an empty list are facts the agent needs before its first import.
 */
function adHocCaveats(route: AdHocRoute): string[] {
    const caveats: string[] = [];
    if (route.fallbackClass) caveats.push(`Automatic routing fallback: ${route.fallbackClass}`);
    if (route.droppedPackages.length > 0) {
        const drops = route.droppedPackages.map((drop) => `\`${drop.entry}\` (${DROP_REASON_TEXT[drop.reason]})`).join(", ");
        caveats.push(`The routing dropped these package entries: ${drops}.`);
    }
    if (route.packages.length === 0) {
        caveats.push(
            "This step declares no packages, thus the pre-launch link pass linked nothing. Confirm that each library you intend to use imports before you rely on it.",
        );
    }
    return caveats;
}

export function buildAdHocPlan(request: string, route: AdHocRoute, createdAt = new Date().toISOString()): AnalysisPlan {
    const meta = SANDBOX_AGENT_META[route.agentId];
    const caveats = adHocCaveats(route);
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
                caveats: caveats.length > 0 ? caveats : undefined,
                packages: [...route.packages],
                depends_on: [],
                status: "pending",
                resources: route.resources,
                agent: route.agentId,
                maxSteps: meta.defaultMaxSteps ?? DEFAULT_SANDBOX_MAX_STEPS,
            },
        ],
    };
    return AnalysisPlanSchema.parse(plan);
}

/**
 * The targeted presence check that the router runs over the names it emits,
 * against the same inventory that `list_available_packages` reads.
 *
 * It binds only when the embedder gives an inventory source. The unbound
 * defaults name a container mountpoint, and a host that mounts nothing there
 * would pay a file read on every ad hoc launch to learn nothing — while the
 * router, with no resolution, already keeps every entry that parses.
 */
function adHocPackageResolver(deps: ExecuteAnalysisToolDeps, analysisId: string): AdHocRouterDeps["resolvePackages"] {
    if (!deps.farmLockFile && !deps.imagePackagesFile && !deps.readPoolInventory) return undefined;
    const inventory: ListAvailablePackagesDeps = {
        farmLockFile: !(deps.farmLockFile === undefined) ? deps.farmLockFile : undefined,
        imagePackagesFile: !(deps.imagePackagesFile === undefined) ? deps.imagePackagesFile : undefined,
        readPoolInventory: !(deps.readPoolInventory === undefined) ? deps.readPoolInventory : undefined,
    };
    return async (names) => {
        const read = await readInventorySections(inventory, analysisId);
        // An inventory that cannot answer must not drop a name: the router
        // keeps every parsed entry, and the link pass judges at launch.
        if (read.kind === "unavailable") return null;
        const answer = queryPackages(read.sections, { names });
        return "checked" in answer ? answer.checked : null;
    };
}

async function persistedAdHocPlan(
    deps: ExecuteAnalysisToolDeps,
    args: { analysisId: string; request: string; ctx: ToolContext; planId: string },
): Promise<AnalysisPlan> {
    const existing = unwrapOrThrow(await loadPlan(deps.pool, args.planId, { analysisId: args.analysisId }));
    if (existing) return validateStoredPlan(existing, args.planId);

    const resolvePackages = adHocPackageResolver(deps, args.analysisId);
    const route = await routeAdHocRequest(
        {
            provider: deps.utilityProvider,
            model: deps.utilityModel,
            pool: deps.pool,
            resourcePolicy: deps.resourcePolicy,
            logger: deps.logger,
            resolvePackages: resolvePackages ? resolvePackages : undefined,
            usageRecorder: deps.usageRecorder ? deps.usageRecorder : undefined,
        },
        {
            analysisId: args.analysisId,
            request: args.request,
            session: args.ctx.session,
            signal: args.ctx.signal,
            turnUsage: args.ctx.turnUsage ? args.ctx.turnUsage : undefined,
            invocationId: args.ctx.invocationId,
        },
    );
    const candidate = buildAdHocPlan(args.request, route);
    unwrapOrThrow(await upsertPlan(deps.pool, { planId: args.planId, analysisId: args.analysisId, plan: candidate }));
    const stored = unwrapOrThrow(await loadPlan(deps.pool, args.planId, { analysisId: args.analysisId }));
    if (!stored) throw new Error(`Internal ad hoc plan ${args.planId} could not be reloaded`);
    return validateStoredPlan(stored, args.planId);
}

type LaunchTailArgs = {
    session: AgentSession;
    planId: string;
    plan: AnalysisPlan;
    mode: "plan" | "adhoc";
    /** Reserves the run row. `started: false` names the run that already holds the slot. */
    reserve: (frame: { analysisId: string; threadId: string | null }) => Promise<Result<PlanLaunch, LaunchPlanRunRefusal>>;
};

/**
 * The half of a launch that the plan mode and the ad hoc mode share: the link pass, the reservation,
 * the authorization, and the workflow start. It gives each outcome as a `Result`.
 */
async function launchReservedRun(deps: LaunchPlanRunDeps, args: LaunchTailArgs): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> {
    const logger = (deps.logger ?? createNoopLogger()).named("execute-analysis-tool");
    const { session, planId, plan } = args;
    const analysisId = session.scope.analysisId;
    const threadId = session.scope.threadId ?? null;

    const resources = stepResources(planId, plan);
    if (resources.isErr()) return err(resources.error);

    // The link pass comes before the run reserves anything, thus a pool
    // miss leaves no run row and no revoked authorization behind.
    const linked = await linkPlanPackages(deps.extendAnalysisFarm, analysisId, planId, plan);
    if (linked.isErr()) return err(linked.error);
    const packageQueries = linked.value;

    const reservation = await args.reserve({ analysisId, threadId });
    if (reservation.isErr()) return err(reservation.error);
    if (!reservation.value.started) return reservation;
    const runId = reservation.value.runId;

    const authorized = await passGate(
        "RunAuthorizer.authorize",
        deps.runAuthorizer.authorize({
            auth: session.auth,
            scope: session.scope,
            provenance: session.provenance,
            frame: { runId },
        }),
    );
    if (authorized.isErr()) {
        // The refusal ends the run before a workflow exists, thus the
        // reserved row must not stay `running`.
        const { kind, reason } = authorized.error;
        if (kind === "suspended") {
            await updateRunStatus(deps.pool, runId, "suspended_insufficient_funds", reason).match(
                () => {},
                () => {},
            );
            const suspension = await suspendAnalysis(deps.pool, analysisId);
            if (suspension.isErr()) return err({ type: "store_failed", cause: suspension.error });
            return err({ type: "suspended", reason });
        }
        await updateRunStatus(deps.pool, runId, "failed", reason).match(
            () => {},
            () => {},
        );
        return err({ type: "not_authorized", reason });
    }
    const authorization = authorized.value;

    const wfInput = workflowInput(planId, plan, {
        analysisId,
        threadId,
        runSession: authorization.runSession,
        ownsMandate: authorization.ownsMandate,
        budget: deps.resourcePolicy?.budget,
        synthesisEnabled: args.mode === "plan",
        resourcesByStepId: resources.value,
    });
    try {
        await deps.runLauncher.launch(deps.executeAnalysisWorkflow, { workflowId: runId }, wfInput);
    } catch (cause) {
        await deliverNotice(logger, "RunAuthorizer.revoke", deps.runAuthorizer.revoke(authorization, "workflow-start-failed"));
        // A failed write leaves the row `running` with no workflow. The boot repair (`reconcileOrphanedRuns`) fails it.
        await updateRunStatus(deps.pool, runId, "failed", "workflow start failed").match(
            () => {},
            (error) => logger.warn("the failed status of a run whose start failed was not written", { runId, ...logger.errorFields(error) }),
        );
        return err({ type: "launch_failed", cause });
    }

    logger.info("analysis launched", { analysisId, runId, planId, mode: args.mode, packageQueries });
    return ok({ runId, started: true });
}

/**
 * Reserve a fresh run for a plan. A concurrent launch of the same plan holds the active-plan slot,
 * and its run is the answer.
 */
async function reservePlanRun(
    deps: LaunchPlanRunDeps,
    args: { analysisId: string; threadId: string | null; planId: string },
): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> {
    const runId = randomUUID();
    try {
        const inserted = await insertRun(deps.pool, {
            runId,
            analysisId: args.analysisId,
            threadId: args.threadId,
            workflowName: "executeAnalysis",
            planId: args.planId,
        });
        if (inserted.isErr()) return err({ type: "store_failed", cause: inserted.error });
        return ok({ runId, started: true });
    } catch (cause) {
        // `insertRun` rejects its promise on a collision of the active-plan index, and on nothing else.
        if (!isDedupCollision(cause)) return err({ type: "store_failed", cause });
        const active = await queryActiveRun(deps.pool, args.analysisId, args.planId);
        if (active.isErr()) return err({ type: "store_failed", cause: active.error });
        // The slot was free again when the read ran, so no run holds it and the collision stays the cause.
        if (!active.value) return err({ type: "store_failed", cause });
        return ok({ runId: active.value.runId, started: false });
    }
}

/**
 * Reserve the run of an ad hoc call under its deterministic id, and treat a reservation that exists
 * as a redelivery of the same call.
 */
async function reserveAdHocRun(
    deps: LaunchPlanRunDeps,
    args: { analysisId: string; threadId: string | null; planId: string; runId: string },
): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> {
    try {
        const reservation = await reserveRunById(deps.pool, {
            runId: args.runId,
            analysisId: args.analysisId,
            threadId: args.threadId,
            workflowName: "executeAnalysis",
            planId: args.planId,
        });
        if (reservation.isErr()) return err({ type: "store_failed", cause: reservation.error });
        return ok({ runId: reservation.value.row.runId, started: reservation.value.inserted });
    } catch (cause) {
        // `reserveRunById` rejects its promise when the run id belongs to another analysis.
        return err({ type: "store_failed", cause });
    }
}

async function launchStoredPlan(deps: LaunchPlanRunDeps, input: { session: AgentSession; planId: string }): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> {
    const { session, planId } = input;
    const analysisId = session.scope.analysisId;

    const raw = await loadPlan(deps.pool, planId, { analysisId });
    if (raw.isErr()) return err({ type: "store_failed", cause: raw.error });
    if (!raw.value) return err({ type: "plan_not_found", planId });
    const plan = parseStoredPlan(raw.value, planId);
    if (plan.isErr()) return err(plan.error);

    const active = await queryActiveRun(deps.pool, analysisId, planId);
    if (active.isErr()) return err({ type: "store_failed", cause: active.error });
    if (active.value) return ok({ runId: active.value.runId, started: false });

    return launchReservedRun(deps, {
        session,
        planId,
        plan: plan.value,
        mode: "plan",
        reserve: (frame) => reservePlanRun(deps, { ...frame, planId }),
    });
}

/**
 * Start the run of a stored plan. It reads the plan under the analysis of the session, validates it,
 * links its packages, reserves a run, authorizes it, and starts the workflow. It gives the run id, or
 * the refusal, and it emits no chat part. `started` is false when a run of the plan was already active.
 *
 * This is an API boundary: a host calls it outside a tool body, thus no outcome above rejects the
 * promise.
 */
export function launchPlanRun(deps: LaunchPlanRunDeps, input: { session: AgentSession; planId: string }): ResultAsync<PlanLaunch, LaunchPlanRunRefusal> {
    return new ResultAsync(launchStoredPlan(deps, input));
}

/** Throw the error that the tool body threw before the launch gave a `Result`. */
function throwLaunchRefusal(refusal: Exclude<LaunchPlanRunRefusal, { type: "not_authorized" | "suspended" }>): never {
    switch (refusal.type) {
        case "plan_not_found":
            throw new PlanNotFoundError(refusal.planId);
        case "plan_invalid":
            throw refusal.malformed ? new PlanMalformedError(refusal.planId) : new PlanValidationError(refusal.planId, refusal.errors);
        case "packages_missing":
            throw new PlanPackagesMissingError(refusal.missing, refusal.collisions, refusal.unavailable);
        case "store_failed":
            return unwrapOrThrow(err(refusal.cause));
        case "launch_failed":
            // The cause is the value that the launcher threw, and the tool rethrows it unchanged.
            throw refusal.cause;
        default: {
            const unreachable: never = refusal;
            return unreachable;
        }
    }
}

export function createExecuteAnalysisTool(deps: ExecuteAnalysisToolDeps) {
    return defineTool({
        id: "execute_analysis",
        description:
            "Launch analysis computation asynchronously. Use mode=plan with the planId only after the user approved that stored plan. " +
            "Use mode=adhoc with the user's exact targeted computational request when they explicitly asked to run/compute/test/compare it; " +
            "that explicit request is consent and needs no synthetic-plan approval. If computation is merely your suggestion, ask first. " +
            "You never choose the sandbox specialist: ad hoc routing does that automatically. Returns runId with status=in_progress; inspect results on a later turn. " +
            "A plan that already has an active run returns that run, so a second run of one plan does not start. " +
            "The launch fails with an error, and no run starts, when the plan is not found or fails validation, when a package of the plan cannot link, or when the run is not authorized.",
        inputSchema,
        // The mode is what a user most needs to see here — an approved plan
        // running is a different event from an ad hoc request being routed.
        describeCall: (input) => (input.mode === "plan" ? `plan ${input.planId ?? ""}` : `ad hoc: ${input.request ?? ""}`),
        execute: async (input, ctx) => {
            const analysisId = ctx.session.scope.analysisId;
            const planId = input.mode === "plan" ? guaranteed(input.planId, "planId") : adHocPlanId(analysisId, ctx.invocationId);
            const emitRunCard = async (runId: string) => {
                const card = await buildRunCardData(deps.pool, { planId, analysisId, runId }).unwrapOr(null);
                if (card) await ctx.emit({ type: "data-run-card", source: ctx.session.provenance, data: card });
            };

            const launch = async (): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> => {
                if (input.mode === "plan") return launchPlanRun(deps, { session: ctx.session, planId });
                const plan = await persistedAdHocPlan(deps, { analysisId, request: guaranteed(input.request, "request"), ctx, planId });
                const runId = adHocRunId(analysisId, ctx.invocationId);
                return launchReservedRun(deps, {
                    session: ctx.session,
                    planId,
                    plan,
                    mode: "adhoc",
                    reserve: (frame) => reserveAdHocRun(deps, { ...frame, planId, runId }),
                });
            };
            const launched = await launch();
            if (launched.isErr()) {
                const refusal = launched.error;
                if (refusal.type === "suspended") return err({ error: `The analysis is suspended: ${refusal.reason}`, retryable: false });
                if (refusal.type === "not_authorized") return err({ error: `The run was not authorized: ${refusal.reason}`, retryable: false });
                return throwLaunchRefusal(refusal);
            }

            await emitRunCard(launched.value.runId);
            return ok({ runId: launched.value.runId, status: "in_progress" as const });
        },
    });
}
