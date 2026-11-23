/**
 * The rows of `cortex_sandbox_leases` and their migration: one active lease for each key, the strict order of the
 * grants against the budget, and the clears that keep the machine of an exec that starts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import { z } from "zod";

import { withSchema } from "../../__tests__/setup/postgres.js";
import type { ResourceSpec } from "../../config/resource-limits.js";
import {
    activeLease,
    clearIdleMachine,
    clearMachine,
    latestGeneration,
    oldestWaiting,
    openLeases,
    leasesOwnedBy,
    readLease,
    releaseLease,
    requestLease,
    setMachine,
    touchLease,
    tryGrant,
    wakeIdleLease,
} from "../sandbox-leases.js";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("sandbox-leases"));
});

afterEach(async () => {
    await drop();
});

const MACHINE = { sandboxId: "sbx-1", host: "127.0.0.1", port: 8765, backend: "docker" as const };

async function request(leaseWorkflowId: string, leaseKey: string, requested: ResourceSpec, generation = 1): Promise<void> {
    (
        await requestLease(pool, {
            leaseWorkflowId,
            leaseKey,
            generation,
            analysisId: "a1",
            ownerWorkflowId: leaseKey,
            workKind: "run",
            workId: "run-1",
            requested,
        })
    )._unsafeUnwrap();
}

/** Move the request time of a lease, thus a test sets the order of the queue. */
async function requestedAt(leaseWorkflowId: string, iso: string): Promise<void> {
    await pool.query({ text: "UPDATE cortex_sandbox_leases SET requested_at = $2::timestamptz WHERE lease_workflow_id = $1", values: [leaseWorkflowId, iso] });
}

describe("the migration", () => {
    it("drops sandbox_ref from the step rows", async () => {
        const { rows } = await pool.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'cortex_step_executions'",
        );
        expect(rows.map((row) => row.column_name)).not.toContain("sandbox_ref");
    });
});

describe("one active lease for each key", () => {
    it("keeps the first request of a key, and a second request of the same key writes nothing", async () => {
        await request("lw-1", "k", { cpu: 1, memoryGb: 2 });
        await request("lw-2", "k", { cpu: 4, memoryGb: 8 }, 2);

        expect((await activeLease(pool, "k"))._unsafeUnwrap()?.leaseWorkflowId).toBe("lw-1");
        expect((await readLease(pool, "lw-2"))._unsafeUnwrap()).toBeUndefined();
    });

    it("admits the next generation after a release", async () => {
        await request("lw-1", "k", { cpu: 1, memoryGb: 2 });
        (await releaseLease(pool, "lw-1", "released"))._unsafeUnwrap();
        await request("lw-2", "k", { cpu: 1, memoryGb: 2 }, 2);

        expect((await activeLease(pool, "k"))._unsafeUnwrap()?.leaseWorkflowId).toBe("lw-2");
        expect((await latestGeneration(pool, "k"))._unsafeUnwrap()).toBe(2);
    });

    it("gives each generation its own exec salt", async () => {
        await request("lw-1", "k", { cpu: 1, memoryGb: 2 });
        (await releaseLease(pool, "lw-1", "released"))._unsafeUnwrap();
        await request("lw-2", "k", { cpu: 1, memoryGb: 2 }, 2);

        const first = (await readLease(pool, "lw-1"))._unsafeUnwrap()?.execSalt;
        const second = (await readLease(pool, "lw-2"))._unsafeUnwrap()?.execSalt;
        expect(z.uuid().safeParse(first).success).toBe(true);
        expect(z.uuid().safeParse(second).success).toBe(true);
        expect(second).not.toBe(first);
    });
});

describe("the leases of an owner", () => {
    it("gives each lease of the owners that is not released", async () => {
        await request("lw-a", "owner-a", { cpu: 1, memoryGb: 2 });
        await request("lw-b", "owner-b", { cpu: 1, memoryGb: 2 });
        await request("lw-c", "owner-c", { cpu: 1, memoryGb: 2 });
        (await releaseLease(pool, "lw-b", "released"))._unsafeUnwrap();

        const owned = (await leasesOwnedBy(pool, ["owner-a", "owner-b"]))._unsafeUnwrap();

        expect(owned.map((lease) => lease.leaseWorkflowId)).toEqual(["lw-a"]);
    });
});

describe("the grant", () => {
    it("grants each request at once with no budget", async () => {
        await request("lw-1", "k1", { cpu: 64, memoryGb: 512 });
        expect((await tryGrant(pool, "lw-1", undefined))._unsafeUnwrap()).toEqual({ kind: "granted", size: { cpu: 64, memoryGb: 512 } });
    });

    it("holds a request that does not fit beside the granted leases", async () => {
        const budget = { cpu: 4, memoryGb: 16 };
        await request("lw-a", "ka", { cpu: 4, memoryGb: 16 });
        await request("lw-b", "kb", { cpu: 1, memoryGb: 2 });
        await requestedAt("lw-a", "2026-10-30T10:00:00Z");
        await requestedAt("lw-b", "2026-10-30T10:00:01Z");

        expect((await tryGrant(pool, "lw-a", budget))._unsafeUnwrap().kind).toBe("granted");
        expect((await tryGrant(pool, "lw-b", budget))._unsafeUnwrap()).toEqual({ kind: "waiting" });

        (await releaseLease(pool, "lw-a", "released"))._unsafeUnwrap();
        expect((await tryGrant(pool, "lw-b", budget))._unsafeUnwrap().kind).toBe("granted");
    });

    it("grants in the order of the requests: a later small request does not pass an older large one", async () => {
        const budget = { cpu: 4, memoryGb: 16 };
        await request("lw-held", "kh", { cpu: 2, memoryGb: 8 });
        await request("lw-r1", "k1", { cpu: 4, memoryGb: 16 });
        await request("lw-r2", "k2", { cpu: 1, memoryGb: 2 });
        await requestedAt("lw-held", "2026-10-30T10:00:00Z");
        await requestedAt("lw-r1", "2026-10-30T10:00:01Z");
        await requestedAt("lw-r2", "2026-10-30T10:00:02Z");
        expect((await tryGrant(pool, "lw-held", budget))._unsafeUnwrap().kind).toBe("granted");

        expect((await oldestWaiting(pool))._unsafeUnwrap()).toBe("lw-r1");
        expect((await tryGrant(pool, "lw-r2", budget))._unsafeUnwrap()).toEqual({ kind: "waiting" });
        expect((await tryGrant(pool, "lw-r1", budget))._unsafeUnwrap()).toEqual({ kind: "waiting" });
    });

    it("answers released for a lease that ended before its grant", async () => {
        await request("lw-1", "k", { cpu: 1, memoryGb: 2 });
        (await releaseLease(pool, "lw-1", "released"))._unsafeUnwrap();
        expect((await tryGrant(pool, "lw-1", undefined))._unsafeUnwrap()).toEqual({ kind: "released" });
    });
});

describe("an idle lease", () => {
    const budget = { cpu: 4, memoryGb: 16 };

    async function idleHolder(): Promise<void> {
        await request("lw-idle", "ki", { cpu: 4, memoryGb: 16 });
        await requestedAt("lw-idle", "2026-10-30T10:00:00Z");
        (await tryGrant(pool, "lw-idle", budget))._unsafeUnwrap();
        (await setMachine(pool, "lw-idle", MACHINE, 1))._unsafeUnwrap();
        await pool.query("UPDATE cortex_sandbox_leases SET last_used_at = now() - interval '1 hour'");
        (await clearIdleMachine(pool, "lw-idle", 1, 60_000))._unsafeUnwrap();
    }

    it("holds no capacity and no place in the queue, and asks for no grant", async () => {
        await idleHolder();
        await request("lw-next", "kn", { cpu: 4, memoryGb: 16 });
        await requestedAt("lw-next", "2026-10-30T10:00:05Z");

        expect((await oldestWaiting(pool))._unsafeUnwrap()).toBe("lw-next");
        expect((await tryGrant(pool, "lw-idle", undefined))._unsafeUnwrap()).toEqual({ kind: "waiting" });
        expect((await tryGrant(pool, "lw-next", budget))._unsafeUnwrap().kind).toBe("granted");
    });

    it("goes to the front of the queue with its first request time when an exec wakes it", async () => {
        await idleHolder();
        await request("lw-later", "kl", { cpu: 1, memoryGb: 2 });
        await requestedAt("lw-later", "2026-10-30T10:00:05Z");

        expect((await wakeIdleLease(pool, "lw-idle"))._unsafeUnwrap()).toBe(true);
        expect((await wakeIdleLease(pool, "lw-idle"))._unsafeUnwrap()).toBe(false);
        expect((await readLease(pool, "lw-idle"))._unsafeUnwrap()?.state).toBe("requested");
        expect((await oldestWaiting(pool))._unsafeUnwrap()).toBe("lw-idle");
        expect((await tryGrant(pool, "lw-later", budget))._unsafeUnwrap()).toEqual({ kind: "waiting" });
        expect((await tryGrant(pool, "lw-idle", budget))._unsafeUnwrap()).toEqual({ kind: "granted", size: { cpu: 4, memoryGb: 16 } });
    });

    it("releases with no machine", async () => {
        await idleHolder();

        expect((await releaseLease(pool, "lw-idle", "released"))._unsafeUnwrap()).toEqual({ machine: undefined });
        expect((await openLeases(pool))._unsafeUnwrap()).toEqual([]);
    });
});

describe("the machine of a lease", () => {
    async function granted(): Promise<void> {
        await request("lw-1", "k", { cpu: 1, memoryGb: 2 });
        (await tryGrant(pool, "lw-1", undefined))._unsafeUnwrap();
        (await setMachine(pool, "lw-1", MACHINE, 1))._unsafeUnwrap();
    }

    it("clears an idle machine, and moves the lease to idle", async () => {
        await granted();
        await pool.query("UPDATE cortex_sandbox_leases SET last_used_at = now() - interval '1 hour'");

        expect((await clearIdleMachine(pool, "lw-1", 1, 60_000))._unsafeUnwrap()).toEqual({ machine: MACHINE });
        const lease = (await readLease(pool, "lw-1"))._unsafeUnwrap();
        expect(lease?.machine).toBeUndefined();
        expect(lease?.state).toBe("idle");
        expect((await touchLease(pool, "lw-1"))._unsafeUnwrap()).toBeUndefined();
        expect((await openLeases(pool))._unsafeUnwrap().map((row) => row.state)).toEqual(["idle"]);
    });

    it("moves a granted lease whose machine died to idle after the idle period", async () => {
        await granted();
        (await clearMachine(pool, "lw-1", 1))._unsafeUnwrap();
        expect((await clearIdleMachine(pool, "lw-1", 1, 60_000))._unsafeUnwrap()).toBeUndefined();
        await pool.query("UPDATE cortex_sandbox_leases SET last_used_at = now() - interval '1 hour'");

        expect((await clearIdleMachine(pool, "lw-1", 1, 60_000))._unsafeUnwrap()).toEqual({ machine: undefined });
        expect((await readLease(pool, "lw-1"))._unsafeUnwrap()?.state).toBe("idle");
    });

    it("keeps the machine of a lease that an exec touched", async () => {
        await granted();
        await pool.query("UPDATE cortex_sandbox_leases SET last_used_at = now() - interval '1 hour'");
        expect((await touchLease(pool, "lw-1"))._unsafeUnwrap()).toEqual({ machine: MACHINE, machineGeneration: 1 });

        expect((await clearIdleMachine(pool, "lw-1", 1, 60_000))._unsafeUnwrap()).toBeUndefined();
        expect((await readLease(pool, "lw-1"))._unsafeUnwrap()?.machine).toEqual(MACHINE);
    });

    it("keeps the exec token of a machine, and reads a machine from before the token with no token", async () => {
        await granted();
        (await setMachine(pool, "lw-1", { ...MACHINE, execToken: "d".repeat(64) }, 2))._unsafeUnwrap();
        expect((await readLease(pool, "lw-1"))._unsafeUnwrap()?.machine?.execToken).toBe("d".repeat(64));

        await pool.query({ text: "UPDATE cortex_sandbox_leases SET machine = $1::jsonb", values: [JSON.stringify(MACHINE)] });
        const old = (await readLease(pool, "lw-1"))._unsafeUnwrap()?.machine;
        expect(old?.sandboxId).toBe("sbx-1");
        expect(old?.execToken).toBeUndefined();
    });

    it("clears nothing for a report of an old machine generation", async () => {
        await granted();
        (await setMachine(pool, "lw-1", { ...MACHINE, sandboxId: "sbx-2" }, 2))._unsafeUnwrap();

        expect((await clearMachine(pool, "lw-1", 1))._unsafeUnwrap()).toBeUndefined();
        expect((await readLease(pool, "lw-1"))._unsafeUnwrap()?.machine?.sandboxId).toBe("sbx-2");
    });

    it("gives the machine at the release, one time, and the lease leaves the open leases", async () => {
        await granted();

        expect((await releaseLease(pool, "lw-1", "released"))._unsafeUnwrap()).toEqual({ machine: MACHINE });
        expect((await releaseLease(pool, "lw-1", "released"))._unsafeUnwrap()).toBeUndefined();
        expect((await openLeases(pool))._unsafeUnwrap()).toEqual([]);
        expect((await touchLease(pool, "lw-1"))._unsafeUnwrap()).toBeUndefined();
    });
});
