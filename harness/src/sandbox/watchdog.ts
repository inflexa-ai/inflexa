/**
 * Per-sandbox-machine liveness watchdog (CONTEXT.md "Sandbox exec").
 *
 * A `@DBOS.scheduled` parent fires every minute, lists the active-sandbox
 * registry, shards by `hash(sandboxId) % SHARD_COUNT`, and `startWorkflow`s
 * one child check workflow per non-empty shard. The fan-out invariant —
 * "no single invocation polls every sandbox" — is the user's explicit
 * constraint.
 *
 * Each child workflow walks its shard, calls `isAlive`, and on `false`
 * gates on `DBOS.getWorkflowStatus`: if the owning workflow is still
 * `PENDING` or `ENQUEUED`, the child sends a `synthetic-failure`
 * done-marker on `exec-event:${execId}` to unblock `awaitExec`. The
 * marker carries `signature: null` and `kind: "synthetic-failure"` so the
 * recv loop accepts it from the trusted in-process sender (see the harness-sandbox-exec spec).
 *
 * The pure sharding and check logic is hoisted so it can be unit-tested
 * without spinning a DBOS runtime; `registerWatchdog` is the thin
 * production wiring.
 */

import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ResultAsync } from "neverthrow";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { DbError } from "../lib/db-result.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { ActiveSandboxRow } from "../state/index.js";
import type { SandboxClient } from "./client.js";
import { workflowIdFromExec } from "./exec-id.js";
import { syntheticFailureReason, syntheticFailureResult } from "./liveness.js";
import type { ExecEventMessage, ExecResult, SandboxLiveness, SandboxRef } from "./types.js";

export const SHARD_COUNT = 8;
const WATCHDOG_CRON = "*/60 * * * * *";

/** Stable hash → shard mapping, exported for tests. */
export function shardIndex(sandboxId: string, shardCount = SHARD_COUNT): number {
    const digest = createHash("sha1").update(sandboxId).digest();
    const slice = digest.readUInt32BE(0);
    return slice % shardCount;
}

/** Partition the active-sandbox set into `shardCount` lists. */
export function shardActiveSandboxes(rows: ActiveSandboxRow[], shardCount = SHARD_COUNT): ActiveSandboxRow[][] {
    const shards: ActiveSandboxRow[][] = Array.from({ length: shardCount }, () => []);
    for (const row of rows) {
        shards[shardIndex(row.sandboxRef.sandboxId, shardCount)]!.push(row);
    }
    return shards;
}

export interface CheckShardDeps {
    isAlive: (ref: SandboxRef) => Promise<SandboxLiveness>;
    getStatus: (workflowId: string) => Promise<{ status: string } | null>;
    /**
     * Send a synthetic-failure marker on the per-exec topic. In production
     * this is `DBOS.send`; injected here for testability.
     */
    sendSynthetic: (workflowId: string, execId: string, failure: ExecResult, reason: string) => Promise<void>;
    logger?: Logger;
}

export interface CheckShardSummary {
    activeCount: number;
    deadCount: number;
    syntheticSends: number;
    liveWorkflowsSkipped: number;
}

const ACTIVE_WORKFLOW_STATUSES = new Set(["PENDING", "ENQUEUED"]);

/**
 * Pure check logic over a shard: enumerate, call `isAlive`, and on
 * dead-and-still-in-flight send a synthetic-failure. The in-flight guard
 * is critical — without it a real `complete` arriving microseconds before
 * the watchdog would race with the synthetic and produce a duplicate
 * notification.
 */
export async function checkShard(rows: ActiveSandboxRow[], deps: CheckShardDeps): Promise<CheckShardSummary> {
    const logger = (deps.logger ?? createNoopLogger()).named("sandbox-watchdog");
    let deadCount = 0;
    let syntheticSends = 0;
    let liveWorkflowsSkipped = 0;

    for (const row of rows) {
        // We don't know the secret from here; reconstruct a minimal in-memory
        // SandboxRef from the persisted shape. `isAlive` does not consult
        // the secret, so this is safe.
        const ref: SandboxRef = {
            ...row.sandboxRef,
            callbackSecret: "",
        };

        let liveness: SandboxLiveness;
        try {
            liveness = await deps.isAlive(ref);
        } catch (err) {
            logger.warn("isAlive threw — skipping this round", {
                sandboxId: row.sandboxRef.sandboxId,
                err: err instanceof Error ? err.message : String(err),
            });
            continue;
        }
        if (liveness.alive) continue;
        deadCount++;

        const workflowId = row.execId ? workflowIdFromExec(row.execId) : null;
        if (!workflowId || !row.execId) {
            // No exec was in flight when this row was tagged; nothing to
            // unblock. Future change: clear the registry row separately.
            continue;
        }

        const status = await deps.getStatus(workflowId);
        if (!status || !ACTIVE_WORKFLOW_STATUSES.has(status.status)) {
            liveWorkflowsSkipped++;
            continue;
        }

        const reason = syntheticFailureReason(liveness);
        const failure = syntheticFailureResult(row.execId, reason);
        await deps.sendSynthetic(workflowId, row.execId, failure, reason);
        syntheticSends++;
    }

    const summary: CheckShardSummary = {
        activeCount: rows.length,
        deadCount,
        syntheticSends,
        liveWorkflowsSkipped,
    };
    // Spread: an interface has no implicit index signature, so it needs widening to `LogFields`.
    logger.info("shard check completed", { ...summary });
    return summary;
}

/** Encodes the synthetic-failure marker on the per-exec topic envelope. */
export function syntheticFailureMessage(execId: string, failure: ExecResult, reason: string, nowSec: number): ExecEventMessage {
    return {
        payload: {
            done: true,
            result: failure,
            kind: "synthetic-failure",
            reason,
        },
        signature: null,
        timestamp: nowSec,
    };
}

export interface WatchdogDeps {
    queryActiveSandboxes: () => ResultAsync<ActiveSandboxRow[], DbError>;
    sandboxClient: SandboxClient;
    shardCount?: number;
    logger?: Logger;
}

/**
 * Production registration. Builds the parent + child registered workflows
 * and the scheduled trigger. The parent fans out via `startWorkflow` so
 * each child is durable in its own right (and recovers independently).
 */
export function registerWatchdog(deps: WatchdogDeps): void {
    const shardCount = deps.shardCount ?? SHARD_COUNT;

    const childCheckShard = DBOS.registerWorkflow(
        async (rows: ActiveSandboxRow[]) => {
            return checkShard(rows, {
                isAlive: (ref) => deps.sandboxClient.isAlive(ref),
                getStatus: async (workflowId) => (await DBOS.getWorkflowStatus(workflowId)) as { status: string } | null,
                sendSynthetic: async (workflowId, execId, failure, reason) => {
                    const msg = syntheticFailureMessage(execId, failure, reason, Math.floor((await DBOS.now()) / 1000));
                    await DBOS.send(workflowId, msg, `exec-event:${execId}`);
                },
                logger: deps.logger,
            });
        },
        { name: "sandbox-watchdog-shard" },
    );

    // The scheduled target must itself be a registered workflow — DBOS's
    // scheduler loop skips (and errors on) any `@scheduled` function that lacks
    // a workflow registration. Register, then schedule the same callable.
    const watchdogParent = DBOS.registerWorkflow(
        async () => {
            // Checkpoint the live registry read: the row set gates how many
            // `startWorkflow` calls fire below, so a differing set on replay would
            // drift the recorded function-ID sequence (see the harness-durable-runtime spec).
            const rows = await DBOS.runStep(async () => unwrapOrThrow(await deps.queryActiveSandboxes()), { name: "query-active-sandboxes" });
            if (rows.length === 0) return;
            const shards = shardActiveSandboxes(rows, shardCount);
            for (const shard of shards) {
                if (shard.length === 0) continue;
                await DBOS.startWorkflow(childCheckShard)(shard);
            }
        },
        { name: "sandbox-watchdog-parent" },
    );

    DBOS.registerScheduled(watchdogParent, {
        name: "sandbox-watchdog-parent",
        crontab: WATCHDOG_CRON,
    });
}
