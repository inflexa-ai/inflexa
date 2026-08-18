import { beforeEach, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { acquireInstanceLock, instanceLockPath, liveInstanceLockHolds, releaseInstanceLock, releaseHeldInstanceLocks } from "./lock.ts";
import { env } from "./env.ts";
import { assertTestSandbox } from "../test_support/sandbox.ts";

// preload.ts (bunfig [test].preload) already redirects XDG_DATA_HOME to a per-suite temp sandbox
// before any import, so env.locksDir resolves into it. We deliberately do NOT touch process.env
// here: the suite runs in one process and the e2e harness's runCli spawns children with the live
// env, so clobbering XDG_DATA_HOME would leak and break those tests.

// Every test writes/deletes lock files under env.locksDir (directly, and via acquire/release). At the
// monorepo root that is the developer's REAL ~/.local/share/inflexa/locks; refuse to run there rather
// than seed/delete real lock files (data-loss guard — see test_support/sandbox.ts). beforeEach runs
// first, so a root run throws before any lock op fires.
beforeEach(() => {
    assertTestSandbox(env.locksDir);
});

// Write a lock file for `key` owned by `pid`, faking another instance's hold.
function seedForeignLock(key: string, pid: number): void {
    mkdirSync(dirname(instanceLockPath(key)), { recursive: true });
    writeFileSync(instanceLockPath(key), String(pid));
}

test("acquires a free key and records our pid", () => {
    const key = "lock-test-free";
    expect(acquireInstanceLock(key)).toEqual({ acquired: true });
    expect(readFileSync(instanceLockPath(key), "utf8").trim()).toBe(String(process.pid));
    releaseInstanceLock(key);
    expect(existsSync(instanceLockPath(key))).toBe(false);
});

test("re-acquiring our own lock is re-entrant (a same-key re-acquire)", () => {
    const key = "lock-test-reentrant";
    expect(acquireInstanceLock(key).acquired).toBe(true);
    expect(acquireInstanceLock(key).acquired).toBe(true); // ours → success, never a conflict
    releaseInstanceLock(key);
});

test("a live foreign holder is a conflict", async () => {
    const key = "lock-test-live";
    const proc = Bun.spawn(["sleep", "60"]);
    seedForeignLock(key, proc.pid);
    expect(acquireInstanceLock(key)).toEqual({ acquired: false, holderPid: proc.pid });
    proc.kill();
    await proc.exited;
});

test("the per-analysis run/profile/chat guard refuses a live holder and surfaces its pid", async () => {
    // The instance lock the deliberate `run`/`profile`/`chat` commands take before
    // booting is keyed by the analysis id (a UUIDv7 — never colliding with the runtime
    // sentinel). A second command against an analysis a live process already holds is a
    // conflict, and the holderPid it returns is exactly what those commands print in
    // their stderr conflict line. This is the lock-level contract those guards rely on;
    // exercising the commands themselves would require booting the runtime.
    const analysisId = randomUUIDv7();
    const proc = Bun.spawn(["sleep", "60"]);
    seedForeignLock(analysisId, proc.pid);
    expect(acquireInstanceLock(analysisId)).toEqual({ acquired: false, holderPid: proc.pid });
    proc.kill();
    await proc.exited;
});

test("a dead holder's lock is reclaimed", async () => {
    const key = "lock-test-dead";
    const proc = Bun.spawn(["sleep", "60"]);
    const deadPid = proc.pid;
    proc.kill();
    await proc.exited; // awaited so the child is reaped and process.kill(pid,0) yields ESRCH
    seedForeignLock(key, deadPid);
    expect(acquireInstanceLock(key).acquired).toBe(true);
    expect(readFileSync(instanceLockPath(key), "utf8").trim()).toBe(String(process.pid));
    releaseInstanceLock(key);
});

test("release leaves a lock we don't own untouched", async () => {
    const key = "lock-test-foreign";
    const proc = Bun.spawn(["sleep", "60"]);
    seedForeignLock(key, proc.pid);
    releaseInstanceLock(key);
    expect(existsSync(instanceLockPath(key))).toBe(true); // not ours → not deleted
    proc.kill();
    await proc.exited;
});

test("the live holds of a key family are reported, and a record of a dead process is swept", async () => {
    // The reclamation of the package store reads a family this way: it waits for each live farm
    // composition, and it cannot name the analysis ids itself.
    const prefix = "lock-test-family-";
    const live = Bun.spawn(["sleep", "60"]);
    const dead = Bun.spawn(["sleep", "60"]);
    const deadPid = dead.pid;
    dead.kill();
    await dead.exited; // awaited so the child is reaped and process.kill(pid,0) yields ESRCH
    seedForeignLock(`${prefix}live`, live.pid);
    seedForeignLock(`${prefix}dead`, deadPid);

    try {
        expect(liveInstanceLockHolds(prefix)).toEqual([{ key: `${prefix}live`, pid: live.pid }]);
        expect(existsSync(instanceLockPath(`${prefix}dead`))).toBe(false); // the sweep removed it
        expect(existsSync(instanceLockPath(`${prefix}live`))).toBe(true);
    } finally {
        live.kill();
        await live.exited;
        rmSync(instanceLockPath(`${prefix}live`), { force: true });
    }
});

test("releaseHeldInstanceLocks drops every lock this process holds", () => {
    acquireInstanceLock("lock-test-held-a");
    acquireInstanceLock("lock-test-held-b");
    releaseHeldInstanceLocks();
    expect(existsSync(instanceLockPath("lock-test-held-a"))).toBe(false);
    expect(existsSync(instanceLockPath("lock-test-held-b"))).toBe(false);
});
