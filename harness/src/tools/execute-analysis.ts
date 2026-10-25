/**
 * Unified async edge for approved plans and explicitly requested one-step ad
 * hoc analyses. Both modes launch the ordinary executeAnalysis workflow.
 */

import { randomUUID } from "node:crypto";
import { err, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { type Connectable } from "../lib/db-result.js";
import type { Querier } from "../state/db.js";
import { z } from "zod";

import { capabilityDataRequirement } from "../agents/sandbox-catalog.js";
import { SANDBOX_AGENT_META } from "../agents/sandbox/index.js";
import type { AgentSession } from "../auth/types.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { EnvironmentStorePaths } from "../config/environment-stores.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import { DEFAULT_SANDBOX_MAX_STEPS } from "../config/resource-limits.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { readInstalledDatasetIds } from "./sandbox/list-available-refs.js";
import { tryQuery, withTransaction, type DbError, type TransactionQuerier } from "../lib/db-result.js";
import { deliverNotice, passGate } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { buildRunCardData } from "../memory/card-builders.js";
import type { ChatProvider } from "../providers/types.js";
import { formatQuery, parseQuery, type PackageQuery } from "../sandbox/package-identity.js";
import type { ExtendAnalysisFarm } from "../sandbox/types.js";
import { AnalysisPlanSchema, type AnalysisPlan } from "../schemas/workflow-state.js";
import { validatePlan } from "../schemas/validate-plan.js";
import {
    RunDedupCollisionError,
    insertRun,
    loadPlan,
    queryActiveRun,
    queryNewestPlanRun,
    reserveRunById,
    suspendAnalysis,
    updateRunStatus,
    upsertPlan,
} from "../state/index.js";
import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import { routeAdHocRequest, type AdHocRoute, type AdHocRouterDeps } from "./ad-hoc-router.js";
import { adHocPlanId, adHocRunId } from "./analysis-invocation.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { queryPackages, readInventorySections, type ListAvailablePackagesDeps } from "./sandbox/list-available-packages.js";
import { callExtendAnalysisFarm } from "./sandbox/link-packages.js";

import { PLAN_ID_RE } from "../contracts/schemas/chat-parts.js";
import { collapseWhitespace } from "../lib/text.js";

const planIdSchema = z.string().regex(PLAN_ID_RE, "planId must be a pln-<8hex> value");
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

export type ExecuteAnalysisToolDeps = Pick<EnvironmentStorePaths, "farmLockFile" | "imagePackagesFile" | "readPoolInventory" | "refStorePath"> & {
    readonly pool: Querier & Connectable;
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
    return err instanceof RunDedupCollisionError || (err instanceof Error && err.name === "RunDedupCollisionError");
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
        ].filter((p): p is string => p !== null);
        super(`The packages of this plan cannot link — ${parts.join("; ")}`);
        this.name = "PlanPackagesMissingError";
    }
}

/**
 * A declared dataset that the reference store does not hold, found at the pre-launch pass. The
 * message names the datasets and no remedy command — the remedy belongs to the embedder, and its
 * wrapper appends it.
 */
export class PlanReferencesMissingError extends Error {
    constructor(
        readonly missing: string[],
        readonly unavailable?: string,
    ) {
        const parts = [
            // The store-level reason FIRST, for the same reason the package error leads with it:
            // with an unanswerable store, no per-dataset claim below it is trustworthy.
            unavailable !== undefined
                ? `the store cannot answer (${unavailable}) — this says nothing about the datasets themselves, so do not re-request them`
                : null,
            missing.length > 0 ? `the store does not hold: ${missing.join(", ")}` : null,
        ].filter((part): part is string => part !== null);
        super(`The reference data of this plan is not installed — ${parts.join(" ")}`);
        this.name = "PlanReferencesMissingError";
    }
}

/** The deps that start the run of a stored plan. */
export type LaunchPlanRunDeps = Pick<
    ExecuteAnalysisToolDeps,
    "pool" | "executeAnalysisWorkflow" | "runAuthorizer" | "runLauncher" | "resourcePolicy" | "extendAnalysisFarm" | "refStorePath" | "logger"
>;

/**
 * The run of a stored plan. `started` is false when this call started nothing: `runId` then names the
 * active run of the plan, or the newest run of the plan when the view of the caller was stale.
 */
export type PlanLaunch = { runId: string; started: boolean };

/**
 * Why a stored plan did not start a run. `store_failed.cause` and `launch_failed.cause` are the
 * values as the failing call gave them, thus a caller that must throw them keeps their class.
 */
export type LaunchPlanRunRefusal =
    | { type: "plan_not_found"; planId: string }
    | { type: "plan_invalid"; planId: string; malformed: boolean; errors: string[] }
    | { type: "packages_missing"; missing: string[]; collisions: string[]; unavailable?: string }
    | { type: "references_missing"; missing: string[]; unavailable?: string }
    | { type: "run_not_found"; runId: string }
    | { type: "not_authorized"; reason: string }
    | { type: "suspended"; reason: string }
    | { type: "store_failed"; cause: unknown }
    | { type: "launch_failed"; cause: unknown };

/**
 * Resolve the reference data that the capabilities of a plan declare, before the run reserves
 * anything. A step names its capability, the agent of the step holds the declaration, and the
 * declaration names catalog ids. An absent dataset refuses the launch with the ids named.
 *
 * Nothing is read when no step declares a requirement: the common plan touches no store at all.
 *
 * @returns How many datasets reached the store. Zero says that nothing was checked — a plan that
 * declares none, or a store the embedder bound nowhere — which a launch record must be able to tell
 * from a checked launch.
 */
async function resolvePlanReferences(refStorePath: string | undefined, plan: AnalysisPlan): Promise<Result<number, LaunchPlanRunRefusal>> {
    const declared = new Set<string>();
    for (const step of plan.steps) {
        if (!step.agent || !step.capability) continue;
        for (const dataset of capabilityDataRequirement(step.agent, step.capability)) declared.add(dataset);
    }
    if (declared.size === 0) return ok(0);
    // An unbound store is an embedder that provisions reference data some other way, exactly as an
    // unbound farm seam leaves the package pass at once. Reading the container path here instead
    // would fail on every host and refuse every launch that declares a capability.
    if (refStorePath === undefined) return ok(0);
    const installed = await readInstalledDatasetIds({ refStorePath });
    if (installed === undefined) {
        // The path is named, because the reason is a fault of the environment and the reader has to
        // know WHICH store did not answer. A bare "could not be read" sends a caller round in circles.
        return err({ type: "references_missing", missing: [], unavailable: `the reference store at ${refStorePath} could not be read` });
    }
    const missing = [...declared].filter((dataset) => !installed.has(dataset)).sort();
    if (missing.length > 0) return err({ type: "references_missing", missing });
    return ok(declared.size);
}

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
                `${o.detail === undefined ? "" : ` (${o.detail})`}` +
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
    if (parsed.isErr()) return throwLaunchRefusal(parsed.error, planId);
    return parsed.value;
}

function adHocTitle(request: string): string {
    const compact = collapseWhitespace(request);
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
                capability: route.capability,
                maxSteps: meta?.defaultMaxSteps ?? DEFAULT_SANDBOX_MAX_STEPS,
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
        farmLockFile: deps.farmLockFile,
        imagePackagesFile: deps.imagePackagesFile,
        readPoolInventory: deps.readPoolInventory,
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
            resolvePackages,
            usageRecorder: deps.usageRecorder,
        },
        {
            analysisId: args.analysisId,
            request: args.request,
            session: args.ctx.session,
            signal: args.ctx.signal,
            turnUsage: args.ctx.turnUsage,
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

    // Reference data first: it is a read, so it costs nothing to learn before the farm link
    // writes. Both passes come before the run reserves anything, thus a miss of either leaves no
    // run row and no revoked authorization behind.
    const references = await resolvePlanReferences(deps.refStorePath, plan);
    if (references.isErr()) return err(references.error);

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

/** A caller whose view of the plan does not match the newest run: `runId` is the newest run, or the run that a plan without a run was said to have. */
type StaleView = { type: "newer"; runId: string } | { type: "missing"; runId: string };

function staleViewOf(newest: string | null, seen: string | null): StaleView | null {
    if (newest !== null) return newest === seen ? null : { type: "newer", runId: newest };
    return seen === null ? null : { type: "missing", runId: seen };
}

/** A stale view starts nothing: it gives the newest run with `started: false`, or `run_not_found` when the plan has no run. */
function refuseStaleView(view: StaleView): Result<PlanLaunch, LaunchPlanRunRefusal> {
    return view.type === "newer" ? ok({ runId: view.runId, started: false }) : err({ type: "run_not_found", runId: view.runId });
}

type PlanSlot = { type: "inserted" } | { type: "stale"; view: StaleView };

function lockPlanLaunch(client: TransactionQuerier, planId: string): ResultAsync<void, DbError> {
    return tryQuery("execute-analysis.lockPlanLaunch", () => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`plan-launch:${planId}`])).map(
        () => undefined,
    );
}

/**
 * Reserve a fresh run for a plan under the lock of the plan, thus the reservations of one plan occur one
 * after the other. A caller with a `newestRunId` reserves nothing when the newest run of the plan is a
 * different run. The new row starts after the newest start, thus it is the newest run of the plan. A
 * concurrent launch of the same plan can hold the active-plan slot, and its run is the answer.
 */
async function reservePlanRun(
    deps: LaunchPlanRunDeps,
    args: { analysisId: string; threadId: string | null; planId: string; newestRunId?: string | null },
): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> {
    const runId = randomUUID();
    try {
        const reserved = await withTransaction(deps.pool, "execute-analysis.reservePlanRun", (client) =>
            lockPlanLaunch(client, args.planId)
                .andThen(() => queryNewestPlanRun(client, { analysisId: args.analysisId, planId: args.planId }))
                .andThen((newest): ResultAsync<PlanSlot, DbError> => {
                    const stale = args.newestRunId === undefined ? null : staleViewOf(newest?.runId ?? null, args.newestRunId);
                    if (stale) return okAsync({ type: "stale", view: stale });
                    const startedAt = newest === null ? undefined : new Date(Math.max(Date.now(), Date.parse(newest.startedAt) + 1)).toISOString();
                    return insertRun(client, {
                        runId,
                        analysisId: args.analysisId,
                        threadId: args.threadId,
                        workflowName: "executeAnalysis",
                        planId: args.planId,
                        startedAt,
                    }).map((): PlanSlot => ({ type: "inserted" }));
                }),
        );
        if (reserved.isErr()) return err({ type: "store_failed", cause: reserved.error });
        if (reserved.value.type === "stale") return refuseStaleView(reserved.value.view);
        return ok({ runId, started: true });
    } catch (cause) {
        // `insertRun` rejects its promise on a collision of the active-plan index, and on nothing else. The
        // transaction is rolled back and released by now, so the read goes to the pool.
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

async function launchStoredPlan(deps: LaunchPlanRunDeps, input: LaunchPlanRunInput): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> {
    const { session, planId, newestRunId } = input;
    const analysisId = session.scope.analysisId;

    const raw = await loadPlan(deps.pool, planId, { analysisId });
    if (raw.isErr()) return err({ type: "store_failed", cause: raw.error });
    if (!raw.value) return err({ type: "plan_not_found", planId });
    const plan = parseStoredPlan(raw.value, planId);
    if (plan.isErr()) return err(plan.error);

    if (newestRunId !== undefined) {
        const newest = await queryNewestPlanRun(deps.pool, { analysisId, planId });
        if (newest.isErr()) return err({ type: "store_failed", cause: newest.error });
        const stale = staleViewOf(newest.value?.runId ?? null, newestRunId);
        if (stale) return refuseStaleView(stale);
    }

    const active = await queryActiveRun(deps.pool, analysisId, planId);
    if (active.isErr()) return err({ type: "store_failed", cause: active.error });
    if (active.value) return ok({ runId: active.value.runId, started: false });

    return launchReservedRun(deps, {
        session,
        planId,
        plan: plan.value,
        mode: "plan",
        reserve: (frame) => reservePlanRun(deps, { ...frame, planId, newestRunId }),
    });
}

/**
 * `newestRunId` is the newest run of the plan that the caller saw, or `null` when the caller saw no run.
 * Without it, the launch compares no run.
 */
export type LaunchPlanRunInput = { session: AgentSession; planId: string; newestRunId?: string | null };

/**
 * Start the run of a stored plan. It reads the plan under the analysis of the session, validates it,
 * compares the newest run of the plan with `newestRunId`, links its packages, reserves a run,
 * authorizes it, and starts the workflow. It gives the run id, or the refusal, and it emits no chat
 * part. `started` is false when this call started nothing: a run of the plan was already active, or the
 * newest run of the plan is not the run that the caller saw. `runId` then names that run.
 *
 * This is an API boundary: a host calls it outside a tool body, thus no outcome above rejects the
 * promise.
 */
export function launchPlanRun(deps: LaunchPlanRunDeps, input: LaunchPlanRunInput): ResultAsync<PlanLaunch, LaunchPlanRunRefusal> {
    return new ResultAsync(launchStoredPlan(deps, input));
}

/** Throw the error that the tool body threw before the launch gave a `Result`. */
function throwLaunchRefusal(refusal: Exclude<LaunchPlanRunRefusal, { type: "not_authorized" | "suspended" }>, planId: string): never {
    switch (refusal.type) {
        case "run_not_found":
            throw new Error(`Plan ${planId} has no run ${refusal.runId}`);
        case "plan_not_found":
            throw new PlanNotFoundError(refusal.planId);
        case "plan_invalid":
            throw refusal.malformed ? new PlanMalformedError(refusal.planId) : new PlanValidationError(refusal.planId, refusal.errors);
        case "packages_missing":
            throw new PlanPackagesMissingError(refusal.missing, refusal.collisions, refusal.unavailable);
        case "references_missing":
            throw new PlanReferencesMissingError(refusal.missing, refusal.unavailable);
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
            let planId: string;
            if (input.mode === "plan") {
                if (input.planId === undefined) throw new Error("plan mode requires planId");
                planId = input.planId;
            } else {
                planId = adHocPlanId(analysisId, ctx.invocationId);
            }
            const emitRunCard = async (runId: string) => {
                const card = await buildRunCardData(deps.pool, { planId, analysisId, runId }).unwrapOr(null);
                if (card) await ctx.emit({ type: "data-run-card", source: ctx.session.provenance, data: card });
            };

            const launch = async (): Promise<Result<PlanLaunch, LaunchPlanRunRefusal>> => {
                if (input.mode === "plan") return launchPlanRun(deps, { session: ctx.session, planId });
                if (input.request === undefined) throw new Error("adhoc mode requires request");
                const plan = await persistedAdHocPlan(deps, { analysisId, request: input.request, ctx, planId });
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
                return throwLaunchRefusal(refusal, planId);
            }

            await emitRunCard(launched.value.runId);
            return ok({ runId: launched.value.runId, status: "in_progress" as const });
        },
    });
}
