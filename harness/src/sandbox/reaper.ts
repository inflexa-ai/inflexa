/**
 * Sandbox reaper — the sole cleanup for orphaned sandboxes and stale registry
 * rows (see the harness-sandbox-exec spec, CONTEXT.md "Sandbox reaper").
 *
 * Distinct from the liveness watchdog (`sandbox/watchdog.ts`): the watchdog
 * sweeps registry→cluster and unblocks stuck recvs; the reaper sweeps
 * cluster→registry and garbage-collects. It lists every Cortex-managed sandbox
 * machine in the configured namespace, resolves each machine's recorded owner
 * workflow, and reaps the ones whose owner is terminal — tearing the machine
 * down and reconciling its step row. A machine whose owner does not resolve at
 * all is torn down only once a liveness probe says it is dead.
 *
 * Why a sweep and not teardown-on-cancel: DBOS forbids running a step in a
 * cancelled workflow, so the body cannot tear down on the cancel path; and only
 * a cluster-side sweep catches permanent scale-down orphans (see the harness-durable-runtime spec), whose
 * workflows never recover to run any cleanup.
 *
 * The pure decision logic (`classifyManaged`) and the sweep (`reapOnce`) are
 * hoisted for unit testing without a DBOS runtime; `registerSandboxReaper` is
 * the thin production wiring.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { reconcileReapedSandbox } from "../state/active-sandboxes.js";
import type { SandboxClient } from "./client.js";
import type { ManagedSandbox } from "./types.js";

const REAPER_CRON = "0 */5 * * * *";
const DEFAULT_GRACE_MS = 10 * 60_000;

/**
 * Workflow statuses that mean "still owns its sandbox — never reap". Must
 * include every non-terminal DBOS state (`mapDbosToRunStatus` in
 * `routes/run-status.ts` is the canonical active set): `RUNNING` especially —
 * an actively-executing step's workflow is RUNNING, and omitting it would reap
 * a live sandbox out from under a running step.
 */
const ACTIVE_WORKFLOW_STATUSES = new Set(["PENDING", "ENQUEUED", "RUNNING"]);

export type ReapDecision = "leave" | "reap" | "reap-if-dead";

/**
 * Decide whether a managed machine is reapable. A resolved owner status is
 * authoritative in both directions — DBOS records it at enqueue, *before* the
 * machine exists, so an in-flight workflow's machine is always observably
 * in-flight and a terminal one's is always reapable.
 *
 * A missing status is authoritative for neither. It means the machine records
 * no owner, or the id it records did not resolve, or DBOS pruned the row —
 * and age cannot separate those from a genuine orphan. So the decision defers
 * to a liveness probe: only an observably dead machine is torn down. Reaping a
 * live machine on age alone is what this branch exists to prevent.
 */
export function classifyManaged(sb: ManagedSandbox, status: { status: string } | null, nowMs: number, graceMs: number): ReapDecision {
    if (status) return ACTIVE_WORKFLOW_STATUSES.has(status.status) ? "leave" : "reap";
    const ageMs = sb.createdAtMs == null ? Number.POSITIVE_INFINITY : nowMs - sb.createdAtMs;
    return ageMs >= graceMs ? "reap-if-dead" : "leave";
}

/** Map the owning workflow's terminal status to the step row's terminal status. */
export function terminalStepStatus(workflowStatus: string | null): "canceled" | "failed" | "completed" {
    switch (workflowStatus) {
        case "CANCELLED":
            return "canceled";
        case "SUCCESS":
            return "completed";
        default:
            // ERROR, MAX_RECOVERY_ATTEMPTS_EXCEEDED, or no workflow at all.
            return "failed";
    }
}

export interface ReaperDeps {
    pool: Pool;
    sandboxClient: Pick<SandboxClient, "listManagedSandboxes" | "teardownById" | "isAliveById">;
    getStatus: (workflowId: string) => Promise<{ status: string } | null>;
    /** Creation-time grace before an unattributable machine is even probed. */
    graceMs?: number;
    /** Wall-clock ms; injected for tests. */
    nowMs?: () => number;
    logger?: Logger;
}

export interface ReapSummary {
    managedCount: number;
    reapedCount: number;
    rowsReconciled: number;
    leftCount: number;
    /**
     * Machines past the grace whose owner did not resolve but which are still
     * alive, so they were left standing. A non-zero value is a standing leak
     * *and* a bug signal — it means owner ids are not round-tripping.
     */
    liveUnattributed: number;
}

/**
 * One cluster→registry sweep. Lists managed machines, classifies each against
 * its owner workflow's status, and reaps the terminal/orphaned ones. A reap
 * failure on one machine is logged and skipped — the next sweep retries.
 */
export async function reapOnce(deps: ReaperDeps): Promise<ReapSummary> {
    const logger = (deps.logger ?? createNoopLogger()).named("sandbox-reaper");
    const nowMs = (deps.nowMs ?? (() => Date.now()))();
    const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;

    const managed = await deps.sandboxClient.listManagedSandboxes();
    let reapedCount = 0;
    let rowsReconciled = 0;
    let leftCount = 0;
    let liveUnattributed = 0;

    for (const sb of managed) {
        const status = sb.ownerWorkflowId ? await deps.getStatus(sb.ownerWorkflowId) : null;
        const decision = classifyManaged(sb, status, nowMs, graceMs);

        if (decision === "leave") {
            leftCount++;
            continue;
        }

        if (decision === "reap-if-dead") {
            // A verbatim id that resolves to nothing is an anomaly worth naming: either
            // DBOS pruned the row or the id never reached the machine intact.
            if (sb.ownerWorkflowId && sb.ownerIsVerbatim) {
                logger.warn("owner workflow id resolved to no workflow", { sandboxId: sb.sandboxId, ownerWorkflowId: sb.ownerWorkflowId });
            }

            let liveness;
            try {
                liveness = await deps.sandboxClient.isAliveById(sb.sandboxId);
            } catch (err) {
                // A probe that cannot answer is not a dead machine. Leave it; the next
                // sweep re-probes.
                logger.warn("liveness probe threw — leaving this machine", { sandboxId: sb.sandboxId, ...logger.errorFields(err) });
                leftCount++;
                continue;
            }

            if (liveness.alive) {
                logger.warn("machine has no resolvable owner but is still alive — left standing", {
                    sandboxId: sb.sandboxId,
                    ownerWorkflowId: sb.ownerWorkflowId,
                    ownerIsVerbatim: sb.ownerIsVerbatim,
                });
                leftCount++;
                liveUnattributed++;
                continue;
            }
        }

        try {
            await deps.sandboxClient.teardownById(sb.sandboxId);
            reapedCount++;
            const reconciled = unwrapOrThrow(await reconcileReapedSandbox(deps.pool, sb.sandboxId, terminalStepStatus(status?.status ?? null)));
            if (reconciled) rowsReconciled++;
        } catch (err) {
            logger.warn("reap failed — skipping this round", {
                sandboxId: sb.sandboxId,
                ...logger.errorFields(err),
            });
        }
    }

    const summary: ReapSummary = {
        managedCount: managed.length,
        reapedCount,
        rowsReconciled,
        leftCount,
        liveUnattributed,
    };
    // Spread: an interface has no implicit index signature, so it needs widening to `LogFields`.
    logger.info("sweep completed", { ...summary });
    return summary;
}

export interface RegisterReaperDeps {
    pool: Pool;
    sandboxClient: Pick<SandboxClient, "listManagedSandboxes" | "teardownById" | "isAliveById">;
    graceMs?: number;
    logger?: Logger;
}

/** Production registration: a single (unsharded) `@DBOS.scheduled` workflow. */
export function registerSandboxReaper(deps: RegisterReaperDeps): void {
    const reaper = DBOS.registerWorkflow(
        async () => {
            // The whole sweep is ONE step: `listManagedSandboxes` is live cluster
            // state (set membership + order vary across runs) and it gates how many
            // per-machine `getWorkflowStatus` reads happen. In the workflow body
            // `getWorkflowStatus` is a function-ID-counting op, so a differing list
            // on replay would diverge the recorded sequence. Inside a step the sweep
            // is checkpointed wholesale and `getWorkflowStatus` is a plain read.
            await DBOS.runStep(
                () =>
                    reapOnce({
                        pool: deps.pool,
                        sandboxClient: deps.sandboxClient,
                        getStatus: async (workflowId) => (await DBOS.getWorkflowStatus(workflowId)) as { status: string } | null,
                        graceMs: deps.graceMs,
                        logger: deps.logger,
                    }),
                { name: "sandbox-reaper-sweep" },
            );
        },
        { name: "sandbox-reaper" },
    );

    DBOS.registerScheduled(reaper, {
        name: "sandbox-reaper",
        crontab: REAPER_CRON,
    });
}
