/**
 * The sandbox reconciler: the decision on a managed machine, the machine sweep, and the lease sweep over a real
 * lease table.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { readLease, requestLease, setMachine, tryGrant } from "../../state/sandbox-leases.js";
import { tailWritePrefix } from "../../workspace/paths.js";
import { leaseRecordTail } from "../lease-names.js";
import { classifyManaged, reconcileOnce, type ReconcilerDeps } from "../reconciler.js";
import type { ManagedSandbox, SandboxLiveness, SandboxRef } from "../types.js";

const GRACE = 10 * 60_000;
const NOW = 1_000_000_000;

function managed(sandboxId: string, ownerWorkflowId: string | null, createdAtMs: number | null = NOW): ManagedSandbox {
    return { sandboxId, ownerWorkflowId, createdAtMs };
}

describe("classifyManaged", () => {
    test("leaves a machine whose lease workflow still runs", () => {
        for (const status of ["PENDING", "ENQUEUED", "RUNNING"]) {
            expect(classifyManaged(managed("s", "lw-1"), { status }, NOW, GRACE)).toBe("leave");
        }
    });

    test("removes a machine whose lease workflow is terminal, whatever its age", () => {
        for (const status of ["SUCCESS", "ERROR", "CANCELLED"]) {
            expect(classifyManaged(managed("s", "lw-1", NOW), { status }, NOW, GRACE)).toBe("remove");
        }
    });

    test("a machine with no resolved owner waits out the grace, and then only a dead one goes", () => {
        expect(classifyManaged(managed("s", null, NOW - 1000), null, NOW, GRACE)).toBe("leave");
        expect(classifyManaged(managed("s", "lw-gone", NOW - GRACE * 10), null, NOW, GRACE)).toBe("remove-if-dead");
        expect(classifyManaged(managed("s", null, null), null, NOW, GRACE)).toBe("remove-if-dead");
    });
});

let pool: Pool;
let drop: () => Promise<void>;
let root: string;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("sandbox-reconciler"));
    root = await mkdtemp(join(tmpdir(), "harness-reconciler-"));
});

afterEach(async () => {
    await drop();
    await rm(root, { recursive: true, force: true });
});

const MACHINE: SandboxRef = { sandboxId: "sbx-lw-1", host: "127.0.0.1", port: 8765, backend: "docker" };

type Sweep = {
    readonly deps: ReconcilerDeps;
    readonly removed: string[];
    readonly canceled: string[];
};

function sweep(
    statuses: Readonly<Record<string, string>>,
    machines: readonly ManagedSandbox[] = [],
    liveness: SandboxLiveness = { alive: false, oomKilled: false },
): Sweep {
    const removed: string[] = [];
    const canceled: string[] = [];
    return {
        removed,
        canceled,
        deps: {
            pool,
            sandboxClient: {
                listManagedSandboxes: () => Promise.resolve([...machines]),
                isAliveById: () => Promise.resolve(liveness),
                teardownById: (sandboxId) => {
                    removed.push(sandboxId);
                    return Promise.resolve();
                },
                teardown: (ref) => {
                    removed.push(ref.sandboxId);
                    return Promise.resolve();
                },
            },
            resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)),
            getStatus: (workflowId) => {
                const status = statuses[workflowId];
                return Promise.resolve(status === undefined ? null : { status });
            },
            cancel: (workflowId) => {
                canceled.push(workflowId);
                return Promise.resolve();
            },
            nowMs: () => NOW,
            graceMs: GRACE,
        },
    };
}

async function grantedLease(leaseWorkflowId: string, leaseKey: string, ownerWorkflowId: string): Promise<void> {
    (
        await requestLease(pool, {
            leaseWorkflowId,
            leaseKey,
            generation: 1,
            analysisId: "a1",
            ownerWorkflowId,
            workKind: "run",
            workId: "run-1",
            requested: { cpu: 1, memoryGb: 2 },
        })
    )._unsafeUnwrap();
    (await tryGrant(pool, leaseWorkflowId, undefined))._unsafeUnwrap();
    (await setMachine(pool, leaseWorkflowId, MACHINE, 1))._unsafeUnwrap();
}

describe("reconcileOnce — the machines", () => {
    test("removes the machine of an ended lease workflow, leaves a live one, and keeps a live unattributed one", async () => {
        const { deps, removed } = sweep(
            { "lw-ended": "CANCELLED", "lw-live": "PENDING" },
            [managed("sbx-ended", "lw-ended"), managed("sbx-live", "lw-live"), managed("sbx-unknown", "lw-gone", NOW - GRACE * 2)],
            { alive: true, oomKilled: false },
        );

        const summary = await reconcileOnce(deps);

        expect(removed).toEqual(["sbx-ended"]);
        expect(summary).toMatchObject({ managedCount: 3, removedCount: 1, liveUnattributed: 1 });
    });

    test("removes an unattributed machine past the grace when the probe finds it dead", async () => {
        const { deps, removed } = sweep({}, [managed("sbx-dead", null, NOW - GRACE * 2)]);

        await reconcileOnce(deps);

        expect(removed).toEqual(["sbx-dead"]);
    });
});

describe("reconcileOnce — the leases", () => {
    test("releases a lease whose lease workflow ended, removes its machine, and deletes its records", async () => {
        await grantedLease("lw-1", "k1", "owner-1");
        const records = tailWritePrefix({ workspaceRoot: join(root, "a1"), tail: leaseRecordTail("k1") });
        await mkdir(records, { recursive: true });
        const { deps, removed } = sweep({ "lw-1": "CANCELLED", "owner-1": "SUCCESS" });

        const summary = await reconcileOnce(deps);

        expect(summary.leasesReleased).toBe(1);
        expect((await readLease(pool, "lw-1"))._unsafeUnwrap()).toMatchObject({ state: "released", releaseReason: "lease-workflow-ended" });
        expect(removed).toEqual([MACHINE.sandboxId]);
        expect(
            await stat(records).then(
                () => "present",
                () => "absent",
            ),
        ).toBe("absent");
    });

    test("cancels a live lease workflow whose owner ended", async () => {
        await grantedLease("lw-1", "k1", "owner-1");
        const { deps, canceled } = sweep({ "lw-1": "PENDING", "owner-1": "ERROR" });

        const summary = await reconcileOnce(deps);

        expect(canceled).toEqual(["lw-1"]);
        expect(summary.leasesCanceled).toBe(1);
        expect((await readLease(pool, "lw-1"))._unsafeUnwrap()?.state).toBe("granted");
    });

    test("keeps a request with no workflow while its owner runs, and releases it after the owner ends", async () => {
        (
            await requestLease(pool, {
                leaseWorkflowId: "lw-2",
                leaseKey: "k2",
                generation: 1,
                analysisId: "a1",
                ownerWorkflowId: "owner-2",
                workKind: "run",
                workId: "run-1",
                requested: { cpu: 1, memoryGb: 2 },
            })
        )._unsafeUnwrap();

        await reconcileOnce(sweep({ "owner-2": "PENDING" }).deps);
        expect((await readLease(pool, "lw-2"))._unsafeUnwrap()?.state).toBe("requested");

        await reconcileOnce(sweep({ "owner-2": "SUCCESS" }).deps);
        expect((await readLease(pool, "lw-2"))._unsafeUnwrap()?.state).toBe("released");
    });
});
