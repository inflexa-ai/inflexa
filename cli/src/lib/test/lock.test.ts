import { beforeEach, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import {
    acquireInstanceLock,
    instanceLockHolder,
    instanceLockPath,
    isProcessAlive,
    processIdentity,
    processStartToken,
    releaseInstanceLock,
    releaseHeldInstanceLocks,
} from "../lock.ts";
import { env } from "../env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

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
    seedLockText(key, JSON.stringify(processIdentity(pid)));
}

function seedLockText(key: string, text: string): void {
    mkdirSync(dirname(instanceLockPath(key)), { recursive: true });
    writeFileSync(instanceLockPath(key), text);
}

function lockText(key: string): string {
    return readFileSync(instanceLockPath(key), "utf8");
}

test("acquires a free key and records our pid, host, and start", () => {
    const key = "lock-test-free";
    expect(acquireInstanceLock(key)).toEqual({ acquired: true });
    expect(lockText(key)).toBe(JSON.stringify({ pid: process.pid, host: hostname(), start: processStartToken(process.pid) }));
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
    expect(lockText(key)).toBe(JSON.stringify(processIdentity(process.pid)));
    releaseInstanceLock(key);
});

test("the platform reports a start token for a live process and none for a dead one", async () => {
    const proc = Bun.spawn(["sleep", "60"]);
    expect(processStartToken(proc.pid)).not.toBeNull();
    proc.kill();
    await proc.exited;
    expect(processStartToken(proc.pid)).toBeNull();
});

test("a live pid with a different start time is a reused pid, and its lock is reclaimed", async () => {
    // After a reboot the pid of the old holder can name a different live process. The lock waited for
    // that process for ever when it held only the pid.
    const key = "lock-test-reused";
    const proc = Bun.spawn(["sleep", "60"]);
    seedLockText(key, JSON.stringify({ pid: proc.pid, host: hostname(), start: "a start before the reboot" }));
    expect(instanceLockHolder(key)).toBeNull();
    expect(acquireInstanceLock(key)).toEqual({ acquired: true });
    releaseInstanceLock(key);
    proc.kill();
    await proc.exited;
});

test("a holder on a different host is stale, and its lock is reclaimed", async () => {
    const key = "lock-test-other-host";
    const proc = Bun.spawn(["sleep", "60"]);
    seedLockText(key, JSON.stringify({ ...processIdentity(proc.pid), host: `not-${hostname()}` }));
    expect(acquireInstanceLock(key)).toEqual({ acquired: true });
    releaseInstanceLock(key);
    proc.kill();
    await proc.exited;
});

test("a record with no known start falls back to the pid probe", async () => {
    const proc = Bun.spawn(["sleep", "60"]);
    expect(isProcessAlive({ pid: proc.pid, host: null, start: null })).toBe(true);
    proc.kill();
    await proc.exited;
    expect(isProcessAlive({ pid: proc.pid, host: null, start: null })).toBe(false);
});

test("a lock file that is not a lock record is reclaimed", () => {
    const key = "lock-test-corrupt";
    seedLockText(key, String(process.ppid));
    expect(acquireInstanceLock(key)).toEqual({ acquired: true });
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
