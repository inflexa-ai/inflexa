import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { env } from "./env.ts";
import { getLogger } from "./log.ts";

// A keyed advisory instance lock so a resource is held by at most one `inflexa` process at a time.
// Modeled on the auth refresh lock (src/modules/auth/auth.ts) — an O_EXCL lock file under the data dir —
// but with one deliberate divergence: liveness is PID-based, not time-based. The auth lock is held
// for ~seconds during one token refresh, so an age threshold is a fine "crashed holder" proxy. These
// locks are held for a long time (an interactive chat session, a data-profile run — possibly hours,
// mostly idle), where an age threshold would falsely free a live, idle instance and let a second one
// in. So a held lock records its holder's pid and a contender reclaims only when that pid is dead
// (process.kill(pid,0) throws ESRCH). Two keys are in use today: an analysis id (one analysis open per
// instance) and a fixed sentinel for the embedded harness runtime (one DBOS engine — executor "local"
// — per machine, or a second process's launch-time recovery would adopt this one's in-flight
// workflows). The key is any collision-free string; analysis ids are UUIDv7, so they never collide
// with the runtime sentinel.

/** Keys this process currently holds locks for, so the exit hook can release them without re-deriving. A process may hold several at once (e.g. an open analysis and the harness runtime). */
const heldKeys = new Set<string>();

/** Outcome of an acquire attempt. `acquired:false` is an expected, non-error branch (the resource is live elsewhere) — not a thrown failure — so it is a plain union, not a neverthrow `Result`. */
export type LockOutcome = { acquired: true } | { acquired: false; holderPid: number };

/** Absolute path of a lock file for `key`. Exported for the unit test, which seeds and inspects it directly. */
export function instanceLockPath(key: string): string {
    return join(env.locksDir, `${key}.lock`);
}

/** Read the holding pid from a lock file, or null if it is missing or its contents aren't a finite integer (a truncated/corrupt write counts as no live holder, so it gets reclaimed). */
function readHolderPid(path: string): number | null {
    try {
        const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
        return Number.isFinite(pid) ? pid : null;
    } catch {
        return null; // ENOENT (gone) or any read error → treat as no holder
    }
}

/**
 * Whether a pid belongs to a live process. `process.kill(pid, 0)` sends no signal — it only probes
 * existence. ESRCH is the one unambiguous "dead" answer; EPERM (exists but owned by another user) and
 * any other error are treated as ALIVE, because the dangerous direction is declaring a live holder
 * dead (that would let two instances share the resource). When in doubt, keep the lock.
 */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (cause) {
        return (cause as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/**
 * Claim the lock for `key`. Atomic create (`wx` = O_EXCL) wins outright; on contention the holder's
 * pid decides: ours → re-entrant success (a same-key re-acquire), a live foreign pid → conflict, a
 * dead/corrupt pid → reclaim.
 *
 * Fails OPEN: if the lock file genuinely can't be written (broken/unwritable data dir), we log and
 * report success rather than block the user — this is an advisory UX guard, and an unwritable data
 * dir is a larger failure surfaced where the SQLite DB lives, not here.
 */
export function acquireInstanceLock(key: string): LockOutcome {
    const path = instanceLockPath(key);
    const mine = String(process.pid);
    try {
        mkdirSync(env.locksDir, { recursive: true });
        writeFileSync(path, mine, { flag: "wx" });
        heldKeys.add(key);
        return { acquired: true };
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
            getLogger("lock").warn({ err: cause, key }, "lock write failed; proceeding without lock");
            return { acquired: true };
        }
    }

    const holderPid = readHolderPid(path);
    if (holderPid === process.pid) {
        heldKeys.add(key); // already ours (re-entrant)
        return { acquired: true };
    }
    if (holderPid !== null && isPidAlive(holderPid)) {
        return { acquired: false, holderPid };
    }

    // Dead or corrupt holder: reclaim. Remove then re-create exclusively so that, in the narrow
    // window after a holder crash where two contenders race, the loser sees EEXIST and yields
    // instead of both believing they won.
    rmSync(path, { force: true });
    try {
        writeFileSync(path, mine, { flag: "wx" });
        heldKeys.add(key);
        return { acquired: true };
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
            return { acquired: false, holderPid: readHolderPid(path) ?? -1 };
        }
        getLogger("lock").warn({ err: cause, key }, "lock reclaim failed; proceeding without lock");
        return { acquired: true };
    }
}

/**
 * Whether THIS process currently holds `key`'s lock. Reads the in-process ledger (`heldKeys`), not the
 * lock file, so it answers "did we acquire it" without a stat — the question a caller that must run
 * under an already-held lock is asking (e.g. the in-process input-management tool asserting the open
 * chat holds the analysis, per the provenance single-writer discipline).
 */
export function holdsInstanceLock(key: string): boolean {
    return heldKeys.has(key);
}

/**
 * Release `key`'s lock, but only if this process still owns the file. The ownership check matters
 * because a crashed holder's lock may have been reclaimed (and rewritten with another pid) by a
 * different instance — we must never delete a lock we no longer hold.
 */
export function releaseInstanceLock(key: string): void {
    if (readHolderPid(instanceLockPath(key)) === process.pid) {
        rmSync(instanceLockPath(key), { force: true });
    }
    heldKeys.delete(key);
}

/**
 * Release every lock this process holds. Synchronous and self-contained so it can run from the
 * `process.on("exit")` hook (src/index.ts), which only runs sync work and is the broadest exit path —
 * it fires on graceful quit (App.quit → shutdown → process.exit) and on every other process.exit.
 * A hard kill (SIGKILL) bypasses it; those stale files are reclaimed by the pid check on the next open.
 */
export function releaseHeldInstanceLocks(): void {
    for (const key of [...heldKeys]) releaseInstanceLock(key);
}
