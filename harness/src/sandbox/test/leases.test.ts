/**
 * The sandbox module inside DBOS (sandbox-leases spec), over a fake backend client.
 *
 * A test-registered consumer workflow runs one case: it binds a lease and acquires, runs, and releases through it.
 * The lease workflow, the grant, the label gate, the idle removal, and the owner test are the real ones.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { errAsync, okAsync } from "neverthrow";
import type { Pool, QueryConfig, QueryResultRow } from "pg";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { createWork } from "../../app/work.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { SpawnSession } from "../../auth/types.js";
import type { PausePart } from "../../contracts/chat-parts.js";
import { dbosClientFor } from "../../execution/dbos-workflow-purger.js";
import type { Connectable } from "../../lib/db-result.js";
import type { Querier } from "../../state/db.js";
import { queryPausesOfWork, type PauseRecord } from "../../state/paused-work.js";
import { activeLease, readLease, type LeaseRecord } from "../../state/sandbox-leases.js";
import { presentAt } from "../../lib/present.js";
import { tailWritePrefix } from "../../workspace/paths.js";
import type { SandboxClient } from "../client.js";
import { leaseRecordTail } from "../lease-names.js";
import { createSandboxLeases, type BoundLease } from "../leases.js";
import type { ExecRequest, ExecResult, SandboxRef, SandboxSpec } from "../types.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

let rig: DbosTestRig;
let root: string;

function livePool(): Pool {
    return rig.pool;
}

/** The module is made at import, before the launch, thus its pool reads the pool of the rig at each call. */
const lazyPool: Querier & Connectable = {
    query: <R extends QueryResultRow = Record<string, unknown>>(text: string | QueryConfig, values?: unknown[]) => livePool().query<R>(text, values),
    connect: () => livePool().connect(),
};

// ── The fake backend ──────────────────────────────────────────────

type Backend = {
    readonly spawned: { session: SpawnSession; spec: SandboxSpec; sandboxId: string }[];
    readonly torn: string[];
    readonly refusals: { reason: string; suspend: boolean }[];
    readonly execIds: (string | undefined)[];
    exec: (ref: SandboxRef, request: ExecRequest) => Promise<ExecResult>;
    /** The running execs that the health answer counts. A count above 0 keeps each machine from the idle removal. */
    runningExecs: number;
};

const backend: Backend = {
    spawned: [],
    torn: [],
    refusals: [],
    execIds: [],
    exec: (_ref, request) => Promise.resolve({ execId: request.command.join(" "), exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false }),
    runningExecs: 1,
};

const client: SandboxClient = {
    toolchainSource: "store",
    resourceLimits: { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 },
    createSandbox: (session, spec, identity) => {
        const refusal = backend.refusals.shift();
        if (refusal !== undefined) return errAsync({ type: "labels_refused", op: "createSandbox", reason: refusal.reason, suspend: refusal.suspend });
        backend.spawned.push({ session, spec, sandboxId: identity.sandboxId });
        return okAsync({ sandboxId: identity.sandboxId, host: "127.0.0.1", port: 8765, backend: "docker" });
    },
    exec: (ref, request, _emit, _deadline, execId) => {
        backend.execIds.push(execId);
        return backend.exec(ref, request);
    },
    isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
    isAliveById: () => Promise.resolve({ alive: true, oomKilled: false }),
    teardown: (ref) => {
        backend.torn.push(ref.sandboxId);
        return Promise.resolve();
    },
    teardownById: (sandboxId) => {
        backend.torn.push(sandboxId);
        return Promise.resolve();
    },
    listManagedSandboxes: () => Promise.resolve([]),
};

const leases = createSandboxLeases({
    pool: lazyPool,
    client,
    resourcePolicy: { perStep: { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 }, budget: { cpu: 4, memoryGb: 8 } },
    resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)),
    runAuthorizer: createLocalRunAuthorizer(),
    idlePeriodMs: 1_000,
    tickSeconds: 1,
    logger: silentLogger,
    dbosClient: () => dbosClientFor(livePool(), silentLogger),
    fetch: () => Promise.resolve(Response.json({ status: "ok", runningExecs: backend.runningExecs })),
});

// ── The consumer ──────────────────────────────────────────────────

type Case = (lease: BoundLease) => Promise<unknown>;

const cases = new Map<string, { readonly run: Case; readonly analysisId: string; readonly parts: PausePart[] }>();

const RUN_ID = "run-leases";

function sessionOf(analysisId: string): SpawnSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: "test-agent", callPath: ["test-agent"] },
        runFrame: { runId: RUN_ID, stepId: "s1" },
        auth: makeLocalAuth(),
    };
}

const consumer = DBOS.registerWorkflow(
    async (caseId: string): Promise<unknown> => {
        const current = cases.get(caseId);
        if (current === undefined) throw new Error(`no case ${caseId}`);
        const lease = leases.bind({
            leaseKey: caseId,
            session: sessionOf(current.analysisId),
            work: { kind: "run", id: RUN_ID },
            emit: (part) => {
                current.parts.push(part);
                return Promise.resolve();
            },
        });
        return current.run(lease);
    },
    { name: "lease-consumer" },
);

function start(analysisId: string, run: Case): { readonly caseId: string; readonly parts: PausePart[]; readonly result: Promise<unknown> } {
    const caseId = rig.nextWorkflowId("lease-consumer-");
    const parts: PausePart[] = [];
    cases.set(caseId, { run, analysisId, parts });
    const result = DBOS.startWorkflow(consumer, { workflowID: caseId })(caseId).then((handle) => handle.getResult());
    return { caseId, parts, result };
}

async function until<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await sleep(50);
    }
}

async function leaseOf(caseId: string): Promise<LeaseRecord | undefined> {
    return (await activeLease(livePool(), caseId))._unsafeUnwrap();
}

async function leaseRow(leaseWorkflowId: string): Promise<LeaseRecord | undefined> {
    return (await readLease(livePool(), leaseWorkflowId))._unsafeUnwrap();
}

const SMALL = { cpu: 1, memoryGb: 2 };

beforeAll(async () => {
    rig = await setupDbosForTests("sandbox_leases");
    root = await mkdtemp(join(tmpdir(), "harness-leases-"));
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
    await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
    backend.spawned.length = 0;
    backend.torn.length = 0;
    backend.refusals.length = 0;
    backend.execIds.length = 0;
    backend.runningExecs = 1;
    backend.exec = (_ref, request) =>
        Promise.resolve({ execId: request.command.join(" "), exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false });
});

describe("a lease", () => {
    it("grants, starts one machine, runs an exec on it, and a release removes the machine and the records", async () => {
        const analysisId = rig.nextWorkflowId("an-");
        const run = start(analysisId, async (lease) => {
            const first = await lease.acquire(SMALL);
            const again = await lease.acquire(SMALL);
            const exec = (await lease.exec({ command: ["echo", "hi"] }, () => {}))._unsafeUnwrap();
            await lease.release();
            return { first, again, exec };
        });

        const outcome = await run.result;

        expect(outcome).toMatchObject({
            first: { kind: "granted", size: SMALL },
            again: { kind: "granted", size: SMALL },
            exec: { exitCode: 0, stdout: "ok" },
        });
        expect(backend.spawned).toHaveLength(1);
        // The id hides the workflow id and the step, thus a command cannot count up to a later exec id.
        expect(backend.execIds).toHaveLength(1);
        expect(z.hash("sha256").safeParse(backend.execIds[0]).success).toBe(true);
        expect(backend.torn).toEqual([presentAt(backend.spawned, 0).sandboxId]);
        expect(presentAt(backend.spawned, 0).spec.recordTail).toBe(leaseRecordTail(run.caseId));
        expect(await leaseOf(run.caseId)).toBeUndefined();
        const records = tailWritePrefix({ workspaceRoot: join(root, analysisId), tail: leaseRecordTail(run.caseId) });
        expect(
            await stat(records).then(
                () => "present",
                () => "absent",
            ),
        ).toBe("absent");
    }, 60_000);

    it("gives no_lease to an exec before the acquire", async () => {
        const run = start(rig.nextWorkflowId("an-"), async (lease) => {
            const result = await lease.exec({ command: ["echo"] }, () => {});
            return result.isErr() ? result.error.kind : "ran";
        });

        expect(await run.result).toBe("no_lease");
        expect(backend.spawned).toHaveLength(0);
    }, 60_000);

    it("replaces the lease at a different size, with the next generation", async () => {
        const run = start(rig.nextWorkflowId("an-"), async (lease) => {
            await lease.acquire(SMALL);
            const larger = await lease.acquire({ cpu: 2, memoryGb: 4 });
            await lease.release();
            return larger;
        });

        expect(await run.result).toEqual({ kind: "granted", size: { cpu: 2, memoryGb: 4 } });
        expect(backend.spawned.map((each) => each.spec.resources)).toEqual([SMALL, { cpu: 2, memoryGb: 4 }]);
        expect(backend.torn).toEqual(backend.spawned.map((each) => each.sandboxId));
    }, 60_000);

    it("clamps a request to the per-step ceiling, and the grant gives the clamped size", async () => {
        const run = start(rig.nextWorkflowId("an-"), async (lease) => {
            const outcome = await lease.acquire({ cpu: 2, memoryGb: 64 });
            await lease.release();
            return outcome;
        });

        expect(await run.result).toEqual({ kind: "granted", size: { cpu: 2, memoryGb: 8 } });
    }, 60_000);
});

describe("the budget", () => {
    it("holds a request that does not fit until the holder releases", async () => {
        const holder = start(rig.nextWorkflowId("an-"), async (lease) => {
            await lease.acquire({ cpu: 4, memoryGb: 8 });
            await DBOS.recv<string>("go", 60);
            await lease.release();
            return "released";
        });
        await until(async () => ((await leaseOf(holder.caseId))?.state === "granted" ? true : undefined), "the grant of the holder");

        const waiter = start(rig.nextWorkflowId("an-"), async (lease) => {
            const outcome = await lease.acquire(SMALL);
            await lease.release();
            return outcome;
        });
        const waiting = await until(async () => leaseOf(waiter.caseId), "the request of the waiter");
        await sleep(1_500);
        expect((await leaseRow(waiting.leaseWorkflowId))?.state).toBe("requested");

        await DBOS.send(holder.caseId, "go", "go");
        expect(await holder.result).toBe("released");
        expect(await waiter.result).toEqual({ kind: "granted", size: SMALL });
    }, 60_000);
});

describe("the label gate", () => {
    async function pauseOf(analysisId: string): Promise<PauseRecord | undefined> {
        const rows = (await queryPausesOfWork(livePool(), analysisId, RUN_ID))._unsafeUnwrap();
        return rows.find((row) => row.state === "paused");
    }

    it("pauses the lease workflow under the work of the consumer, mirrors the pause, and a resume of the work spawns", async () => {
        const analysisId = rig.nextWorkflowId("an-");
        backend.refusals.push({ reason: "account_frozen", suspend: true });
        const run = start(analysisId, async (lease) => {
            const outcome = await lease.acquire(SMALL);
            await lease.release();
            return outcome;
        });

        const pause = await until(() => pauseOf(analysisId), "the pause of the lease workflow");
        expect(pause.workflowId.startsWith("sandboxlease:")).toBe(true);
        expect(pause).toMatchObject({ workId: RUN_ID, workKind: "run", cause: { kind: "host", reason: "account_frozen" } });
        expect(backend.spawned).toHaveLength(0);
        await until(() => Promise.resolve(run.parts.some((part) => part.state === "paused") ? true : undefined), "the mirrored pause part");

        const work = createWork({
            pool: livePool(),
            runAuthorizer: createLocalRunAuthorizer(),
            stopTurn: () => Promise.reject(new Error("no turn stops in this file")),
            runCanceler: { cancel: () => Promise.reject(new Error("no run stops in this file")) },
            stopProfile: () => Promise.reject(new Error("no profile stops in this file")),
        });
        const session = { identity: { user: "u-1" }, scope: { kind: "analysis" as const, analysisId }, auth: makeLocalAuth() };
        expect(await work.resume(session, RUN_ID)).toEqual({ kind: "resumed", workflows: 1 });

        expect(await run.result).toEqual({ kind: "granted", size: SMALL });
        expect(backend.spawned).toHaveLength(1);
        expect(run.parts.map((part) => part.state)).toEqual(["paused", "running"]);
        expect(run.parts.every((part) => part.id === pause.workflowId && part.workId === RUN_ID)).toBe(true);
    }, 60_000);

    it("ends the lease at a refusal with no suspend flag, and acquire gives the reason", async () => {
        backend.refusals.push({ reason: "no_quota", suspend: false });
        const run = start(rig.nextWorkflowId("an-"), (lease) => lease.acquire(SMALL));

        expect(await run.result).toEqual({ kind: "refused", reason: "no_quota" });
        expect(backend.spawned).toHaveLength(0);
        expect(await leaseOf(run.caseId)).toBeUndefined();
    }, 60_000);
});

describe("the machine of a lease", () => {
    it("gives the cause and the memory limit of a death during an exec, and the next exec runs on a new machine", async () => {
        let execs = 0;
        backend.exec = (_ref, request) => {
            execs += 1;
            if (execs === 1) {
                return Promise.resolve({
                    execId: "e1",
                    exitCode: null,
                    stdout: "",
                    stderr: "",
                    durationMs: null,
                    timedOut: false,
                    syntheticFailure: { reason: "sandbox-oom-killed" },
                });
            }
            return Promise.resolve({ execId: request.command.join(" "), exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false });
        };
        const run = start(rig.nextWorkflowId("an-"), async (lease) => {
            await lease.acquire(SMALL);
            const dead = (await lease.exec({ command: ["python", "big.py"] }, () => {}))._unsafeUnwrap();
            const next = (await lease.exec({ command: ["ls"] }, () => {}))._unsafeUnwrap();
            await lease.release();
            return { dead, next };
        });

        const outcome = await run.result;

        expect(outcome).toMatchObject({ dead: { syntheticFailure: { reason: "sandbox-oom-killed", memoryLimitGb: 2 } }, next: { exitCode: 0 } });
        expect(execs).toBe(2);
        expect(backend.spawned).toHaveLength(2);
        expect(backend.torn).toContain(presentAt(backend.spawned, 0).sandboxId);
    }, 60_000);

    it("removes the machine of an idle lease and keeps the grant, and the next exec gets a new machine", async () => {
        backend.runningExecs = 0;
        const run = start(rig.nextWorkflowId("an-"), async (lease) => {
            await lease.acquire(SMALL);
            await DBOS.recv<string>("go", 60);
            const exec = (await lease.exec({ command: ["ls"] }, () => {}))._unsafeUnwrap();
            await lease.release();
            return exec;
        });
        const lease = await until(async () => {
            const row = await leaseOf(run.caseId);
            return row?.state === "granted" && row.machine !== undefined ? row : undefined;
        }, "the first machine");

        await until(async () => ((await leaseRow(lease.leaseWorkflowId))?.machine === undefined ? true : undefined), "the idle removal");
        expect((await leaseRow(lease.leaseWorkflowId))?.state).toBe("granted");
        expect(backend.torn).toEqual([presentAt(backend.spawned, 0).sandboxId]);

        backend.runningExecs = 1;
        await DBOS.send(run.caseId, "go", "go");
        expect(await run.result).toMatchObject({ exitCode: 0 });
        expect(backend.spawned).toHaveLength(2);
    }, 60_000);

    it("releases the lease of an owner that ended without a release", async () => {
        const run = start(rig.nextWorkflowId("an-"), (lease) => lease.acquire(SMALL));
        await run.result;
        const lease = await until(async () => leaseOf(run.caseId), "the lease").catch(() => undefined);

        await until(async () => ((await leaseOf(run.caseId)) === undefined ? true : undefined), "the release at the owner end");
        if (lease !== undefined) expect((await leaseRow(lease.leaseWorkflowId))?.releaseReason).toBe("owner-ended");
        expect(backend.torn).toEqual([presentAt(backend.spawned, 0).sandboxId]);
    }, 60_000);
});
