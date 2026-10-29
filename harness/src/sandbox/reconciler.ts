/**
 * The sandbox reconciler (sandbox-leases spec): the backstop of the lease workflows.
 *
 * A lease workflow removes its own machine at each normal end. The reconciler covers the ends that a lease workflow
 * cannot see: an operator cancel of the lease workflow, a purge, and a consumer that ends while its lease workflow
 * waits in a pause. Each 5 minutes it does three passes in one DBOS step:
 *
 * 1. Each managed machine whose lease workflow is terminal goes away. A machine whose owner does not resolve goes
 *    away only when a liveness probe finds it dead.
 * 2. Each lease row whose lease workflow is terminal or absent becomes `released`, thus its capacity frees.
 * 3. Each lease workflow whose owner is terminal gets a cancel, and the next sweep removes its machine.
 *
 * The pure decision (`classifyManaged`) and the sweep (`reconcileOnce`) take their effects as parameters, thus a
 * test drives them without a DBOS runtime.
 */

import { rm } from "node:fs/promises";

import { DBOS } from "@dbos-inc/dbos-sdk";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { recordMachineReplaced } from "../lib/metrics.js";
import { untracedWorkflow } from "../lib/otel-spans.js";
import { unwrapOrThrow } from "../lib/result.js";
import { scheduleWorkflow } from "../runtime/dbos.js";
import type { Querier } from "../state/db.js";
import { openLeases, releaseLease } from "../state/sandbox-leases.js";
import { tailWritePrefix, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { SandboxClient } from "./client.js";
import { leaseRecordTail } from "./lease-names.js";
import type { ManagedSandbox } from "./types.js";

const RECONCILER_CRON = "0 */5 * * * *";
const RECONCILER_WORKFLOW = "sandbox-reconciler";
const DEFAULT_GRACE_MS = 10 * 60_000;

/** The statuses of a workflow that still runs. A machine or a lease of such a workflow stays. */
const ACTIVE_WORKFLOW_STATUSES = new Set(["PENDING", "ENQUEUED", "RUNNING"]);

export type ReconcileDecision = "leave" | "remove" | "remove-if-dead";

/**
 * Decide the fate of a managed machine. A resolved owner status is authoritative in both directions: DBOS records
 * the status of a lease workflow at its enqueue, before its machine exists. A missing status is authoritative for
 * neither, thus past the grace the decision defers to a liveness probe.
 */
export function classifyManaged(sb: ManagedSandbox, status: { status: string } | null, nowMs: number, graceMs: number): ReconcileDecision {
    if (status) return ACTIVE_WORKFLOW_STATUSES.has(status.status) ? "leave" : "remove";
    const ageMs = sb.createdAtMs == null ? Number.POSITIVE_INFINITY : nowMs - sb.createdAtMs;
    return ageMs >= graceMs ? "remove-if-dead" : "leave";
}

export type ReconcilerDeps = {
    readonly pool: Querier;
    readonly sandboxClient: Pick<SandboxClient, "listManagedSandboxes" | "teardownById" | "isAliveById" | "teardown">;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly getStatus: (workflowId: string) => Promise<{ status: string } | null>;
    /** Cancel a lease workflow whose owner ended. */
    readonly cancel: (workflowId: string) => Promise<void>;
    /** Creation-time grace before an unattributable machine is even probed. */
    readonly graceMs?: number;
    /** Wall-clock ms; injected for tests. */
    readonly nowMs?: () => number;
    readonly logger?: Logger;
};

export type ReconcileSummary = {
    readonly managedCount: number;
    readonly removedCount: number;
    readonly leftCount: number;
    /** Machines past the grace whose owner did not resolve, but which are alive. A non-zero value is a reported leak. */
    readonly liveUnattributed: number;
    readonly leasesReleased: number;
    readonly leasesCanceled: number;
};

async function sweepMachines(
    deps: ReconcilerDeps,
    logger: Logger,
    nowMs: number,
    graceMs: number,
): Promise<Omit<ReconcileSummary, "leasesReleased" | "leasesCanceled">> {
    const managed = await deps.sandboxClient.listManagedSandboxes();
    let removedCount = 0;
    let leftCount = 0;
    let liveUnattributed = 0;
    for (const sb of managed) {
        const status = sb.ownerWorkflowId ? await deps.getStatus(sb.ownerWorkflowId) : null;
        const decision = classifyManaged(sb, status, nowMs, graceMs);
        if (decision === "leave") {
            leftCount++;
            continue;
        }
        if (decision === "remove-if-dead") {
            if (sb.ownerWorkflowId) logger.warn("owner workflow id resolved to no workflow", { sandboxId: sb.sandboxId, ownerWorkflowId: sb.ownerWorkflowId });
            let liveness;
            try {
                liveness = await deps.sandboxClient.isAliveById(sb.sandboxId);
            } catch (failure) {
                // A probe that cannot answer is not a dead machine. The next sweep probes again.
                logger.warn("liveness probe threw — leaving this machine", { sandboxId: sb.sandboxId, ...logger.errorFields(failure) });
                leftCount++;
                continue;
            }
            if (liveness.alive) {
                logger.warn("machine has no resolvable owner but is still alive — left standing", {
                    sandboxId: sb.sandboxId,
                    ownerWorkflowId: sb.ownerWorkflowId,
                });
                leftCount++;
                liveUnattributed++;
                continue;
            }
        }
        try {
            await deps.sandboxClient.teardownById(sb.sandboxId);
            recordMachineReplaced({ cause: "release" });
            removedCount++;
        } catch (failure) {
            logger.warn("removal failed — skipping this round", { sandboxId: sb.sandboxId, ...logger.errorFields(failure) });
        }
    }
    return { managedCount: managed.length, removedCount, leftCount, liveUnattributed };
}

async function sweepLeases(deps: ReconcilerDeps, logger: Logger): Promise<{ leasesReleased: number; leasesCanceled: number }> {
    let leasesReleased = 0;
    let leasesCanceled = 0;
    for (const lease of unwrapOrThrow(await openLeases(deps.pool))) {
        const status = await deps.getStatus(lease.leaseWorkflowId);
        const leaseActive = status !== null && ACTIVE_WORKFLOW_STATUSES.has(status.status);
        if (!leaseActive) {
            // A lease row with no workflow: its acquire stopped before the enqueue. The owner reruns its acquire when it
            // still runs, thus the row stays until the owner ends.
            if (status === null) {
                const owner = await deps.getStatus(lease.ownerWorkflowId);
                if (owner !== null && ACTIVE_WORKFLOW_STATUSES.has(owner.status)) continue;
            }
            try {
                const released = unwrapOrThrow(await releaseLease(deps.pool, lease.leaseWorkflowId, "lease-workflow-ended"));
                if (released?.machine !== undefined) await deps.sandboxClient.teardown(released.machine);
                const dir = tailWritePrefix({ workspaceRoot: await deps.resolveWorkspaceRoot(lease.analysisId), tail: leaseRecordTail(lease.leaseKey) });
                await rm(dir, { recursive: true, force: true });
                leasesReleased++;
            } catch (failure) {
                logger.warn("the release of an ended lease failed — skipping this round", {
                    leaseWorkflowId: lease.leaseWorkflowId,
                    ...logger.errorFields(failure),
                });
            }
            continue;
        }
        const owner = await deps.getStatus(lease.ownerWorkflowId);
        if (owner !== null && ACTIVE_WORKFLOW_STATUSES.has(owner.status)) continue;
        try {
            await deps.cancel(lease.leaseWorkflowId);
            leasesCanceled++;
        } catch (failure) {
            logger.warn("the cancel of a lease whose owner ended failed", { leaseWorkflowId: lease.leaseWorkflowId, ...logger.errorFields(failure) });
        }
    }
    return { leasesReleased, leasesCanceled };
}

/** One sweep. A failure on one machine or one lease is logged and skipped, and the next sweep tries again. */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<ReconcileSummary> {
    const logger = (deps.logger ?? createNoopLogger()).named("sandbox-reconciler");
    const nowMs = (deps.nowMs ?? (() => Date.now()))();
    const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
    const machines = await sweepMachines(deps, logger, nowMs, graceMs);
    const leases = await sweepLeases(deps, logger);
    const summary: ReconcileSummary = { ...machines, ...leases };
    logger.info("sweep completed", { ...summary });
    return summary;
}

export type RegisterReconcilerDeps = Omit<ReconcilerDeps, "getStatus" | "nowMs">;

/** Register the scheduled reconciler: one unsharded workflow, whose whole sweep is one step. */
export function registerSandboxReconciler(deps: RegisterReconcilerDeps): void {
    const reconciler = DBOS.registerWorkflow(
        async () => {
            // One step for the whole sweep: the machine list is live cluster state, and it sets how many status reads
            // run. In the body each status read takes a function id, thus a different list on a replay would diverge.
            await DBOS.runStep(() => reconcileOnce({ ...deps, getStatus: async (workflowId) => await DBOS.getWorkflowStatus(workflowId) }), {
                name: "sandbox-reconciler-sweep",
            });
        },
        { name: RECONCILER_WORKFLOW },
    );
    untracedWorkflow(RECONCILER_WORKFLOW);
    scheduleWorkflow({ scheduleName: RECONCILER_WORKFLOW, workflowFn: reconciler, schedule: RECONCILER_CRON });
}
