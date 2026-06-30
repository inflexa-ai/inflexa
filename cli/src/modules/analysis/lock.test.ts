import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { acquireAnalysisLock, analysisLockPath, releaseAnalysisLock, releaseHeldAnalysisLock } from "./lock.ts";

// preload.ts (bunfig [test].preload) already redirects XDG_DATA_HOME to a per-suite temp sandbox
// before any import, so env.locksDir resolves into it. We deliberately do NOT touch process.env
// here: the suite runs in one process and the e2e harness's runCli spawns children with the live
// env, so clobbering XDG_DATA_HOME would leak and break those tests.

// Write a lock file for `id` owned by `pid`, faking another instance's hold.
function seedForeignLock(id: string, pid: number): void {
    mkdirSync(dirname(analysisLockPath(id)), { recursive: true });
    writeFileSync(analysisLockPath(id), String(pid));
}

test("acquires a free analysis and records our pid", () => {
    const id = "lock-test-free";
    expect(acquireAnalysisLock(id)).toEqual({ acquired: true });
    expect(readFileSync(analysisLockPath(id), "utf8").trim()).toBe(String(process.pid));
    releaseAnalysisLock(id);
    expect(existsSync(analysisLockPath(id))).toBe(false);
});

test("re-acquiring our own lock is re-entrant (a same-analysis session switch)", () => {
    const id = "lock-test-reentrant";
    expect(acquireAnalysisLock(id).acquired).toBe(true);
    expect(acquireAnalysisLock(id).acquired).toBe(true); // ours → success, never a conflict
    releaseAnalysisLock(id);
});

test("a live foreign holder is a conflict", async () => {
    const id = "lock-test-live";
    const proc = Bun.spawn(["sleep", "60"]);
    seedForeignLock(id, proc.pid);
    expect(acquireAnalysisLock(id)).toEqual({ acquired: false, holderPid: proc.pid });
    proc.kill();
    await proc.exited;
});

test("a dead holder's lock is reclaimed", async () => {
    const id = "lock-test-dead";
    const proc = Bun.spawn(["sleep", "60"]);
    const deadPid = proc.pid;
    proc.kill();
    await proc.exited; // awaited so the child is reaped and process.kill(pid,0) yields ESRCH
    seedForeignLock(id, deadPid);
    expect(acquireAnalysisLock(id).acquired).toBe(true);
    expect(readFileSync(analysisLockPath(id), "utf8").trim()).toBe(String(process.pid));
    releaseAnalysisLock(id);
});

test("release leaves a lock we don't own untouched", async () => {
    const id = "lock-test-foreign";
    const proc = Bun.spawn(["sleep", "60"]);
    seedForeignLock(id, proc.pid);
    releaseAnalysisLock(id);
    expect(existsSync(analysisLockPath(id))).toBe(true); // not ours → not deleted
    proc.kill();
    await proc.exited;
});

test("releaseHeldAnalysisLock drops the currently held lock", () => {
    const id = "lock-test-held";
    acquireAnalysisLock(id);
    releaseHeldAnalysisLock();
    expect(existsSync(analysisLockPath(id))).toBe(false);
});
