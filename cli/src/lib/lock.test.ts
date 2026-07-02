import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { acquireInstanceLock, instanceLockPath, releaseInstanceLock, releaseHeldInstanceLocks } from "./lock.ts";

// preload.ts (bunfig [test].preload) already redirects XDG_DATA_HOME to a per-suite temp sandbox
// before any import, so env.locksDir resolves into it. We deliberately do NOT touch process.env
// here: the suite runs in one process and the e2e harness's runCli spawns children with the live
// env, so clobbering XDG_DATA_HOME would leak and break those tests.

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

test("releaseHeldInstanceLocks drops every lock this process holds", () => {
    acquireInstanceLock("lock-test-held-a");
    acquireInstanceLock("lock-test-held-b");
    releaseHeldInstanceLocks();
    expect(existsSync(instanceLockPath("lock-test-held-a"))).toBe(false);
    expect(existsSync(instanceLockPath("lock-test-held-b"))).toBe(false);
});
