/**
 * The sandbox module (sandbox-leases spec). A consumer holds a sandbox through a lease, and the module owns each
 * machine: the admission, the spawn, the replacement, the idle removal, and the teardown.
 *
 * Each generation of a lease has one lease workflow. A consumer enqueues it through a `DBOSClient`, thus the lease
 * workflow is not a child of the consumer: a cancel, a pause, or a crash of the consumer does not stop it, and its
 * teardown step can always run. The consumer waits for the events of the lease workflow with the same client,
 * because DBOS refuses `recv` and `getEvent` inside a step, and each tool call is a step.
 *
 * A machine of a lease is replaceable. The state of a lease is its files, the exec records in its records
 * directory, and the checkpoints of its consumer. Thus the module removes the machine of an idle lease, and the
 * next exec gets a new one.
 */

import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { DBOS, Error as DBOSErrors, StatusString, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { SpawnSession } from "../auth/types.js";
import { clampResources, type ResourcePolicy, type ResourceSpec } from "../config/resource-limits.js";
import type { PausePart, WorkKind } from "../contracts/chat-parts.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Connectable } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { recordLeaseWait, recordMachineReplaced, recordMachineStart, type MachineReplacementCause } from "../lib/metrics.js";
import { unwrapOrThrow } from "../lib/result.js";
import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import type { Querier } from "../state/db.js";
import { queryPausesOfWork } from "../state/paused-work.js";
import {
    activeLease,
    clearIdleMachine,
    leasesOwnedBy,
    clearMachine,
    latestGeneration,
    oldestWaiting,
    readLease,
    releaseLease,
    requestLease,
    setMachine,
    touchLease,
    tryGrant,
    type LeaseRecord,
} from "../state/sandbox-leases.js";
import type { PersistedSandboxRef } from "../state/schema.js";
import { pauseAtGate, workPause } from "../workflows/pause.js";
import { tailWritePrefix, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { SandboxClient } from "./client.js";
import { noteExecOutcome, summarizeExec } from "./exec-outcome.js";
import { saltedStepExecId } from "./exec.js";
import { keyedSandboxIdentity } from "./identity.js";
import { leaseRecordTail, leaseWorkflowIdOf } from "./lease-names.js";
import { registerSandboxReconciler } from "./reconciler.js";
import { SandboxFailure } from "./sandbox-error.js";
import type { ExecEmit, ExecRequest, ExecResult, SandboxRef, ToolchainSource } from "./types.js";

export const LEASE_WORKFLOW = "sandbox-lease";
export const LEASE_QUEUE = "sandbox-leases";
const LEASE_TOPIC = "lease";
const GRANTED_EVENT = "granted";

/** The tick of a lease workflow: each tick reads the owner and tests the lease for idleness. */
const DEFAULT_TICK_SECONDS = 60;

/** One slice of a wait of a consumer. Between two slices the wait reads the cancel state and mirrors a pause. */
const WAIT_SLICE_SECONDS = 10;

/** The poll of a wait for an event. A client outside the engine reads the event table, and no notification wakes it. */
const EVENT_POLL_MS = 500;

export const DEFAULT_IDLE_PERIOD_MS = 15 * 60_000;

/** The timeout of a command that gives none. A step has no deadline of its own, thus each command has one. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 3600;

/** The time that the poll of an exec waits past the timeout of its command, for the last result. */
const POLL_GRACE_MS = 120_000;

const HEALTH_TIMEOUT_MS = 10_000;

/**
 * The health answer of sandbox-server. An image that predates the count answers with no count, and the module then
 * reads the machine as busy: an idle removal on a guess could stop a command that runs.
 */
const HealthSchema = z.object({ runningExecs: z.number().int().nonnegative().optional() });

const TERMINAL_STATUSES = new Set<string>([StatusString.SUCCESS, StatusString.ERROR, StatusString.CANCELLED, StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED]);

/** The spawn settings of a consumer, beside the size. */
export type LeaseSpawnSpec = {
    readonly image?: string;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly readOnly?: boolean;
    readonly writableTail?: string;
};

/** Who holds a lease, and where its pause and its parts go. */
export type LeaseBinding = {
    /** The key of the lease. A tool gives the id of its workflow. */
    readonly leaseKey: string;
    /** The spawn session of a run step or of a data profile. It goes into the input of the lease workflow. */
    readonly session: SpawnSession;
    /** The work of the consumer. A pause of the lease workflow belongs to it. */
    readonly work: { readonly kind: WorkKind; readonly id: string };
    readonly spawn?: LeaseSpawnSpec;
    /** Writes a part to the stream of the consumer. A wait mirrors the pause of the lease workflow through it. */
    readonly emit?: (part: PausePart) => Promise<void>;
};

export type AcquireOutcome =
    | { readonly kind: "granted"; readonly size: ResourceSpec }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "failed"; readonly detail: string };

/** An exec found no lease that can run it. `detail` says why, for a lease that ended. */
export type NoLease = { readonly kind: "no_lease"; readonly detail?: string };

/** A lease bound to its consumer. A tool holds one, and gives the size and the command only. */
export type BoundLease = {
    acquire(size: ResourceSpec): Promise<AcquireOutcome>;
    release(): Promise<void>;
    exec(request: ExecRequest, emit: ExecEmit): Promise<Result<ExecResult, NoLease>>;
};

export type SandboxLeases = {
    readonly toolchainSource: ToolchainSource;
    acquire(binding: LeaseBinding, size: ResourceSpec): Promise<AcquireOutcome>;
    release(leaseKey: string): Promise<void>;
    /**
     * End each lease of the given owner workflows, and do not wait for the lease workflows. A host that cancels
     * work calls it, thus the machines go now and not at the next tick of each lease workflow.
     */
    releaseOwnedBy(ownerWorkflowIds: readonly string[]): Promise<void>;
    exec(leaseKey: string, request: ExecRequest, emit: ExecEmit, mirror?: LeaseBinding["emit"]): Promise<Result<ExecResult, NoLease>>;
    bind(binding: LeaseBinding): BoundLease;
};

export type SandboxLeasesConfig = {
    /** The application pool, which holds the lease table and the pause rows. */
    readonly pool: Querier & Connectable;
    readonly client: SandboxClient;
    /** The budget of the grant. Absent: each lease gets its grant at once. */
    readonly resourcePolicy?: ResourcePolicy;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly runAuthorizer: RunAuthorizer;
    /** Default {@link DEFAULT_IDLE_PERIOD_MS}. */
    readonly idlePeriodMs?: number;
    readonly pauseRetryDelaysMs?: readonly number[];
    readonly logger?: Logger;
    /** The DBOS client of the enqueue, the sends, and the waits of a consumer. */
    readonly dbosClient: () => Promise<DBOSClient>;
    /** The fetch of the health probe. Defaults to `globalThis.fetch`. */
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    /** The tick of a lease workflow, in seconds. Default 60. */
    readonly tickSeconds?: number;
};

type LeaseWorkflowInput = {
    readonly leaseWorkflowId: string;
    readonly leaseKey: string;
    readonly analysisId: string;
    readonly ownerWorkflowId: string;
    readonly work: { readonly kind: WorkKind; readonly id: string };
    readonly session: SpawnSession;
    readonly spawn: LeaseSpawnSpec;
    readonly size: ResourceSpec;
    /** Unix ms of the request, for the metric of the wait. */
    readonly requestedAtMs: number;
};

type LeaseMessage =
    | { readonly kind: "release"; readonly reason: string }
    | { readonly kind: "machine"; readonly after: number }
    | { readonly kind: "machine-lost"; readonly machine: PersistedSandboxRef; readonly oomKilled: boolean }
    | { readonly kind: "capacity" };

type MachineEvent = { readonly kind: "ready"; readonly ref: PersistedSandboxRef } | { readonly kind: "failed"; readonly detail: string };

type SpawnOutcome =
    | { readonly kind: "ready"; readonly ref: PersistedSandboxRef }
    | { readonly kind: "suspended"; readonly reason: string }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "failed"; readonly detail: string };

type TickOutcome = "owner-ended" | "busy" | "idle-removed" | "dead-removed" | "none";

function machineEventKey(generation: number): string {
    return `machine:${generation}`;
}

function sameSize(a: ResourceSpec, b: ResourceSpec): boolean {
    return a.cpu === b.cpu && a.memoryGb === b.memoryGb && (a.gpu?.count ?? 0) === (b.gpu?.count ?? 0);
}

/** Run `fn` as a step when the caller is a workflow body, and inline when the caller is a step or no workflow. */
function durably<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return DBOS.isInWorkflow() ? DBOS.runStep(fn, { name }) : fn();
}

/** True once the workflow of the caller is canceled. Outside a workflow, nothing can cancel the caller. */
async function callerCanceled(): Promise<boolean> {
    const workflowId = DBOS.workflowID;
    if (workflowId === undefined) return false;
    const status = await DBOS.getWorkflowStatus(workflowId);
    return status?.status === StatusString.CANCELLED;
}

export function createSandboxLeases(config: SandboxLeasesConfig): SandboxLeases {
    const logger = (config.logger ?? createNoopLogger()).named("sandbox-leases");
    const { pool, client } = config;
    const idlePeriodMs = config.idlePeriodMs ?? DEFAULT_IDLE_PERIOD_MS;
    const fetchImpl = config.fetch ?? fetch;
    const engine = config.dbosClient;
    const tickSeconds = config.tickSeconds ?? DEFAULT_TICK_SECONDS;

    let queueRegistered: Promise<unknown> | undefined;
    const registerQueue = (dbos: DBOSClient): Promise<unknown> => {
        queueRegistered ??= dbos.registerQueue(LEASE_QUEUE, { onConflict: "never_update" }).catch((cause: unknown) => {
            queueRegistered = undefined;
            throw cause;
        });
        return queueRegistered;
    };

    registerSandboxReconciler({
        pool,
        sandboxClient: client,
        resolveWorkspaceRoot: config.resolveWorkspaceRoot,
        cancel: async (workflowId) => (await engine()).cancelWorkflow(workflowId),
        logger: config.logger,
    });

    const removeRecords = async (analysisId: string, leaseKey: string): Promise<void> => {
        const dir = tailWritePrefix({ workspaceRoot: await config.resolveWorkspaceRoot(analysisId), tail: leaseRecordTail(leaseKey) });
        await rm(dir, { recursive: true, force: true });
    };

    const teardownQuietly = async (ref: SandboxRef, cause: MachineReplacementCause): Promise<void> => {
        try {
            await client.teardown(ref);
        } catch (failure) {
            // The reconciler removes a machine whose lease ended, thus a failed teardown leaks nothing for long.
            logger.warn("the teardown of a machine failed", { sandboxId: ref.sandboxId, ...logger.errorFields(failure) });
        }
        recordMachineReplaced({ cause });
    };

    // ── The lease workflow ────────────────────────────────────────────

    const leaseWorkflow = DBOS.registerWorkflow(
        async (input: LeaseWorkflowInput): Promise<void> => {
            const log = logger.with({ leaseWorkflowId: input.leaseWorkflowId, ownerWorkflowId: input.ownerWorkflowId });
            const id = input.leaseWorkflowId;
            const pause = workPause({
                pool,
                workId: input.work.id,
                workKind: input.work.kind,
                analysisId: input.analysisId,
                // A host reads the streams of the work, not of the lease workflow. The wait of the consumer mirrors the pause.
                emit: () => Promise.resolve(),
                retryDelaysMs: config.pauseRetryDelaysMs,
                run: { session: input.session, authorizer: config.runAuthorizer },
                logger: log,
            });

            const ownerEnded = (): Promise<boolean> =>
                DBOS.runStep(
                    async () => {
                        const status = await DBOS.getWorkflowStatus(input.ownerWorkflowId);
                        return status === null || TERMINAL_STATUSES.has(status.status);
                    },
                    { name: "lease.owner" },
                );

            const wakeNext = async (): Promise<void> => {
                const next = await DBOS.runStep(async () => unwrapOrThrow(await oldestWaiting(pool)), { name: "lease.next" });
                if (next !== undefined && next !== id) await DBOS.send(next, { kind: "capacity" } satisfies LeaseMessage, LEASE_TOPIC);
            };

            const end = async (reason: string): Promise<void> => {
                await DBOS.runStep(
                    async () => {
                        const released = unwrapOrThrow(await releaseLease(pool, id, reason));
                        if (released?.machine !== undefined) await teardownQuietly(released.machine, "release");
                        await removeRecords(input.analysisId, input.leaseKey);
                    },
                    { name: "lease.release" },
                );
                log.info("lease released", { reason });
                await wakeNext();
            };

            /** `grantedAtMs`: the time of the grant, given only for the first machine, whose start ends the wait of the request. */
            const spawn = (machineGeneration: number, grantedAtMs?: number): Promise<SpawnOutcome> =>
                DBOS.runStep(
                    async (): Promise<SpawnOutcome> => {
                        const identity = keyedSandboxIdentity(input.session.runFrame.runId, `${id}#${machineGeneration}`);
                        const startedAt = Date.now();
                        const created = await client.createSandbox(
                            input.session,
                            {
                                ownerWorkflowId: id,
                                recordTail: leaseRecordTail(input.leaseKey),
                                resources: input.size,
                                image: input.spawn.image,
                                extraEnv: input.spawn.extraEnv === undefined ? undefined : { ...input.spawn.extraEnv },
                                readOnly: input.spawn.readOnly,
                                writableTail: input.spawn.writableTail,
                            },
                            identity,
                        );
                        if (created.isErr()) {
                            const failure = created.error;
                            if (failure.type === "labels_refused") {
                                return failure.suspend ? { kind: "suspended", reason: failure.reason } : { kind: "refused", reason: failure.reason };
                            }
                            return { kind: "failed", detail: new SandboxFailure(failure).message };
                        }
                        unwrapOrThrow(await setMachine(pool, id, created.value, machineGeneration));
                        recordMachineStart({ backend: created.value.backend, startMs: Date.now() - startedAt });
                        if (grantedAtMs !== undefined) recordLeaseWait({ backend: created.value.backend, waitMs: grantedAtMs - input.requestedAtMs });
                        return { kind: "ready", ref: created.value };
                    },
                    { name: "lease.spawn" },
                );

            /** Start a machine. A gate refusal with the suspend flag waits in a pause under the work of the consumer. */
            const startMachine = async (machineGeneration: number, grantedAtMs?: number): Promise<SpawnOutcome> => {
                for (;;) {
                    const outcome = await spawn(machineGeneration, grantedAtMs);
                    if (outcome.kind === "suspended") {
                        await pauseAtGate(pause, outcome.reason);
                        if (await ownerEnded()) return { kind: "refused", reason: "owner-ended" };
                        continue;
                    }
                    const event: MachineEvent =
                        outcome.kind === "ready" ? outcome : { kind: "failed", detail: outcome.kind === "refused" ? outcome.reason : outcome.detail };
                    await DBOS.setEvent(machineEventKey(machineGeneration), event);
                    return outcome;
                }
            };

            // 1. The grant.
            let size: ResourceSpec | undefined;
            let grantedAtMs = 0;
            while (size === undefined) {
                const grant = await DBOS.runStep(
                    async () => ({ outcome: unwrapOrThrow(await tryGrant(pool, id, config.resourcePolicy?.budget)), atMs: Date.now() }),
                    { name: "lease.grant" },
                );
                if (grant.outcome.kind === "granted") {
                    size = grant.outcome.size;
                    grantedAtMs = grant.atMs;
                    break;
                }
                if (grant.outcome.kind === "released") {
                    await DBOS.setEvent(GRANTED_EVENT, { kind: "refused", reason: "released" } satisfies AcquireOutcome);
                    return;
                }
                const message = await DBOS.recv<LeaseMessage>(LEASE_TOPIC, tickSeconds);
                if (message?.kind === "release" || (await ownerEnded())) {
                    await DBOS.setEvent(GRANTED_EVENT, { kind: "refused", reason: "released" } satisfies AcquireOutcome);
                    await end(message?.kind === "release" ? message.reason : "owner-ended");
                    return;
                }
            }
            // A free capacity can admit the next request too.
            await wakeNext();

            // 2. The first machine.
            let machineGeneration = 1;
            const first = await startMachine(machineGeneration, grantedAtMs);
            if (first.kind !== "ready") {
                const outcome: AcquireOutcome =
                    first.kind === "failed"
                        ? { kind: "failed", detail: first.detail }
                        : { kind: "refused", reason: first.kind === "refused" ? first.reason : "suspended" };
                await DBOS.setEvent(GRANTED_EVENT, outcome);
                await end(outcome.kind === "failed" ? "spawn-failed" : `refused:${outcome.reason}`);
                return;
            }
            await DBOS.setEvent(GRANTED_EVENT, { kind: "granted", size } satisfies AcquireOutcome);

            // 3. The life of the lease.
            let reason = "released";
            for (;;) {
                const message = await DBOS.recv<LeaseMessage>(LEASE_TOPIC, tickSeconds);
                if (message === null) {
                    const generation = machineGeneration;
                    const tick = await DBOS.runStep(() => tickOnce(id, generation, input.ownerWorkflowId), { name: "lease.tick" });
                    if (tick === "owner-ended") {
                        reason = "owner-ended";
                        break;
                    }
                    continue;
                }
                if (message.kind === "release") {
                    reason = message.reason;
                    break;
                }
                if (message.kind === "machine") {
                    // A request names the generation that its exec found empty. A later generation already answers it.
                    if (message.after < machineGeneration) continue;
                    const next = await startMachine(machineGeneration + 1);
                    if (next.kind !== "ready") {
                        reason = next.kind === "failed" ? "spawn-failed" : `refused:${next.kind === "refused" ? next.reason : "suspended"}`;
                        break;
                    }
                    machineGeneration += 1;
                    continue;
                }
                if (message.kind === "machine-lost") {
                    // The exec that saw the death cleared the machine from the row. The teardown removes what remains.
                    await DBOS.runStep(() => teardownQuietly(message.machine, message.oomKilled ? "oom" : "dead"), { name: "lease.lost" });
                }
            }
            await end(reason);
        },
        { name: LEASE_WORKFLOW },
    );

    /** One tick of a granted lease: the end of the owner, a dead machine, and the idle removal. */
    const tickOnce = async (id: string, machineGeneration: number, ownerWorkflowId: string): Promise<TickOutcome> => {
        const owner = await DBOS.getWorkflowStatus(ownerWorkflowId);
        if (owner === null || TERMINAL_STATUSES.has(owner.status)) return "owner-ended";
        const lease = unwrapOrThrow(await readLease(pool, id));
        const machine = lease?.machine;
        if (machine === undefined || lease?.machineGeneration !== machineGeneration) return "none";
        const running = await runningExecs(machine);
        if (running === "unreachable") {
            const liveness = await client.isAlive(machine).catch(() => undefined);
            if (liveness?.alive !== false) return "none";
            const lost = unwrapOrThrow(await clearMachine(pool, id, machineGeneration));
            if (lost !== undefined) await teardownQuietly(lost, liveness.oomKilled ? "oom" : "dead");
            return "dead-removed";
        }
        // A command that runs keeps its machine, also when no host polls it, for example during a restart.
        if (running > 0) {
            unwrapOrThrow(await touchLease(pool, id));
            return "busy";
        }
        const idle = unwrapOrThrow(await clearIdleMachine(pool, id, machineGeneration, idlePeriodMs));
        if (idle === undefined) return "none";
        await teardownQuietly(idle, "idle");
        return "idle-removed";
    };

    const runningExecs = async (machine: SandboxRef): Promise<number | "unreachable"> => {
        try {
            const response = await fetchImpl(`http://${machine.host}:${machine.port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            if (!response.ok) return "unreachable";
            const health = HealthSchema.safeParse(await response.json());
            return health.success ? (health.data.runningExecs ?? 1) : 1;
        } catch {
            return "unreachable";
        }
    };

    // ── The waits of a consumer ───────────────────────────────────────

    /**
     * Wait for an event of a lease workflow. Between two slices, the wait reads the cancel state of its caller and
     * mirrors the pause of the lease workflow into the stream of the consumer. `ended`: the lease workflow ended with
     * no event under the key.
     */
    const waitForEvent = async <T>(lease: LeaseRecord, key: string, mirror: LeaseBinding["emit"]): Promise<T | "ended"> => {
        const dbos = await engine();
        let mirrored: string | undefined;
        for (;;) {
            const value = await dbos.getEvent<T>(lease.leaseWorkflowId, key, { timeoutSeconds: WAIT_SLICE_SECONDS, pollingIntervalMs: EVENT_POLL_MS });
            if (value !== null) {
                if (mirrored !== undefined && mirror !== undefined) {
                    await mirror({ type: "data-pause", id: lease.leaseWorkflowId, workId: lease.workId, workKind: lease.workKind, state: "running" });
                }
                return value;
            }
            if (await callerCanceled()) throw new DBOSErrors.DBOSWorkflowCancelledError(DBOS.workflowID ?? lease.leaseWorkflowId);
            const status = await dbos.getWorkflow(lease.leaseWorkflowId);
            if (status !== undefined && TERMINAL_STATUSES.has(status.status)) {
                const last = await dbos.getEvent<T>(lease.leaseWorkflowId, key, { timeoutSeconds: 0 });
                return last ?? "ended";
            }
            if (mirror !== undefined) mirrored = await mirrorPause(lease, mirror, mirrored);
        }
    };

    const mirrorPause = async (lease: LeaseRecord, mirror: NonNullable<LeaseBinding["emit"]>, mirrored: string | undefined): Promise<string | undefined> => {
        const pauses = unwrapOrThrow(await queryPausesOfWork(pool, lease.analysisId, lease.workId));
        const pause = pauses.find((row) => row.workflowId === lease.leaseWorkflowId);
        const state = pause === undefined ? undefined : `${pause.state}:${pause.attempt}`;
        if (state === mirrored) return mirrored;
        if (pause === undefined) {
            await mirror({ type: "data-pause", id: lease.leaseWorkflowId, workId: lease.workId, workKind: lease.workKind, state: "running" });
            return undefined;
        }
        await mirror({
            type: "data-pause",
            id: lease.leaseWorkflowId,
            workId: lease.workId,
            workKind: lease.workKind,
            state: pause.state,
            cause: pause.cause,
            attempt: pause.attempt,
            retryAt: pause.retryAt,
        });
        return state;
    };

    const enqueue = async (binding: LeaseBinding, lease: LeaseRecord, size: ResourceSpec): Promise<void> => {
        const dbos = await engine();
        await registerQueue(dbos);
        const input: LeaseWorkflowInput = {
            leaseWorkflowId: lease.leaseWorkflowId,
            leaseKey: lease.leaseKey,
            analysisId: lease.analysisId,
            ownerWorkflowId: lease.ownerWorkflowId,
            work: binding.work,
            session: binding.session,
            spawn: binding.spawn ?? {},
            size,
            requestedAtMs: Date.now(),
        };
        // DBOS gives back the existing workflow for an id that it holds, thus a rerun starts nothing new.
        await dbos.enqueue(
            { workflowName: leaseWorkflow.name, queueName: LEASE_QUEUE, workflowID: lease.leaseWorkflowId, appVersion: DBOS.applicationVersion },
            input,
        );
    };

    /** Tell the lease workflow to end. A lease workflow in a pause reads no message, thus this ends it here. */
    const stopLease = async (lease: LeaseRecord): Promise<"ended" | "told"> => {
        const dbos = await engine();
        const pauses = unwrapOrThrow(await queryPausesOfWork(pool, lease.analysisId, lease.workId));
        if (pauses.some((row) => row.workflowId === lease.leaseWorkflowId)) {
            // A lease workflow that waits in a pause holds no machine, and it reads no message of the lease until a
            // resume. Thus the release ends it here.
            await dbos.cancelWorkflow(lease.leaseWorkflowId);
            unwrapOrThrow(await releaseLease(pool, lease.leaseWorkflowId, "released"));
            await removeRecords(lease.analysisId, lease.leaseKey);
            const next = unwrapOrThrow(await oldestWaiting(pool));
            if (next !== undefined) await dbos.send(next, { kind: "capacity" } satisfies LeaseMessage, LEASE_TOPIC);
            return "ended";
        }
        await dbos.send(lease.leaseWorkflowId, { kind: "release", reason: "released" } satisfies LeaseMessage, LEASE_TOPIC, `${lease.leaseWorkflowId}:release`);
        return "told";
    };

    const release = async (leaseKey: string): Promise<void> => {
        const lease = unwrapOrThrow(await activeLease(pool, leaseKey));
        if (lease === undefined) return;
        if ((await stopLease(lease)) === "ended") return;
        const dbos = await engine();
        for (;;) {
            const handle = await dbos.getWorkflow(lease.leaseWorkflowId);
            if (handle === undefined || TERMINAL_STATUSES.has(handle.status)) return;
            const row = unwrapOrThrow(await readLease(pool, lease.leaseWorkflowId));
            if (row?.state === "released") return;
            if (await callerCanceled()) throw new DBOSErrors.DBOSWorkflowCancelledError(DBOS.workflowID ?? lease.leaseWorkflowId);
            await sleep(1_000);
        }
    };

    const acquire = async (binding: LeaseBinding, requested: ResourceSpec): Promise<AcquireOutcome> => {
        const size = clampResources(requested, client.resourceLimits);
        const ownerWorkflowId = DBOS.workflowID;
        if (ownerWorkflowId === undefined) throw new Error("a sandbox lease is acquired inside a DBOS workflow, and none is active");
        for (;;) {
            let lease = unwrapOrThrow(await activeLease(pool, binding.leaseKey));
            if (lease !== undefined && !sameSize(lease.requested, size)) {
                await release(binding.leaseKey);
                lease = undefined;
            }
            if (lease === undefined) {
                const generation = unwrapOrThrow(await latestGeneration(pool, binding.leaseKey)) + 1;
                unwrapOrThrow(
                    await requestLease(pool, {
                        leaseWorkflowId: leaseWorkflowIdOf(binding.session.scope.analysisId, binding.leaseKey, generation),
                        leaseKey: binding.leaseKey,
                        generation,
                        analysisId: binding.session.scope.analysisId,
                        ownerWorkflowId,
                        workKind: binding.work.kind,
                        workId: binding.work.id,
                        requested: size,
                    }),
                );
                lease = unwrapOrThrow(await activeLease(pool, binding.leaseKey));
                // A concurrent request of the same key won the insert. The loop reads its lease again.
                if (lease === undefined || !sameSize(lease.requested, size)) continue;
            }
            await enqueue(binding, lease, size);
            const outcome = await waitForEvent<AcquireOutcome>(lease, GRANTED_EVENT, binding.emit);
            if (outcome !== "ended") return outcome;
            const row = unwrapOrThrow(await readLease(pool, lease.leaseWorkflowId));
            return { kind: "failed", detail: `the lease ended before its grant (${row?.releaseReason ?? "no reason"})` };
        }
    };

    /** Get a machine for an exec that found none: ask the lease workflow, and wait for the next machine generation. */
    const requestMachine = async (lease: LeaseRecord, after: number, mirror: LeaseBinding["emit"]): Promise<Result<SandboxRef, NoLease>> => {
        const dbos = await engine();
        const key = DBOS.workflowID === undefined ? undefined : `${DBOS.workflowID}:${String(DBOS.stepID)}:machine:${after}`;
        await dbos.send(lease.leaseWorkflowId, { kind: "machine", after } satisfies LeaseMessage, LEASE_TOPIC, key);
        const event = await waitForEvent<MachineEvent>(lease, machineEventKey(after + 1), mirror);
        if (event === "ended") return err({ kind: "no_lease", detail: "the lease ended" });
        if (event.kind === "failed") return err({ kind: "no_lease", detail: `the sandbox did not start again: ${event.detail}` });
        return ok(event.ref);
    };

    const exec = (leaseKey: string, request: ExecRequest, emit: ExecEmit, mirror?: LeaseBinding["emit"]): Promise<Result<ExecResult, NoLease>> =>
        durably("sandbox.exec", async (): Promise<Result<ExecResult, NoLease>> => {
            const lease = unwrapOrThrow(await activeLease(pool, leaseKey));
            if (lease?.state !== "granted") return err({ kind: "no_lease" });
            // The use is written before the submit, thus the idle removal cannot take the machine of this exec.
            const touched = unwrapOrThrow(await touchLease(pool, lease.leaseWorkflowId));
            if (touched === undefined) return err({ kind: "no_lease" });
            let machine = touched.machine;
            let machineGeneration = touched.machineGeneration;
            if (machine === undefined) {
                const started = await requestMachine(lease, machineGeneration, mirror);
                if (started.isErr()) return err(started.error);
                machine = started.value;
                machineGeneration += 1;
            }
            const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
            const result = await client.exec(
                machine,
                { ...request, timeoutSeconds },
                emit,
                Date.now() + timeoutSeconds * 1000 + POLL_GRACE_MS,
                saltedStepExecId(lease.execSalt),
            );
            noteExecOutcome(leaseKey, summarizeExec(result));
            const failure = result.syntheticFailure;
            if (failure === undefined) return ok(result);
            if (failure.reason === "sandbox-dead" || failure.reason === "sandbox-oom-killed") {
                // The row forgets the dead machine before the exec returns, thus the next exec asks for a new one.
                const lost = unwrapOrThrow(await clearMachine(pool, lease.leaseWorkflowId, machineGeneration));
                if (lost !== undefined) {
                    const dbos = await engine();
                    await dbos.send(
                        lease.leaseWorkflowId,
                        { kind: "machine-lost", machine: lost, oomKilled: failure.reason === "sandbox-oom-killed" } satisfies LeaseMessage,
                        LEASE_TOPIC,
                        `${result.execId}:lost`,
                    );
                }
            }
            return ok({ ...result, syntheticFailure: { ...failure, memoryLimitGb: lease.granted?.memoryGb } });
        });

    const leases: SandboxLeases = {
        toolchainSource: client.toolchainSource,
        acquire: (binding, size) =>
            durably("sandbox.acquire", async () => {
                try {
                    return await acquire(binding, size);
                } catch (failure) {
                    if (failure instanceof DBOSErrors.DBOSWorkflowCancelledError) throw failure;
                    logger.error("an acquire failed", { leaseKey: binding.leaseKey, ...logger.errorFields(failure) });
                    return { kind: "failed", detail: errorMessageOf(failure) ?? textOf(failure) } satisfies AcquireOutcome;
                }
            }),
        release: (leaseKey) => durably("sandbox.release", () => release(leaseKey)),
        releaseOwnedBy: async (ownerWorkflowIds) => {
            for (const lease of unwrapOrThrow(await leasesOwnedBy(pool, ownerWorkflowIds))) await stopLease(lease);
        },
        exec,
        bind: (binding) => ({
            acquire: (size) => leases.acquire(binding, size),
            release: () => leases.release(binding.leaseKey),
            exec: (request, emit) => exec(binding.leaseKey, request, emit, binding.emit),
        }),
    };
    return leases;
}
