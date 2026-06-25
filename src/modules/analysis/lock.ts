import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { env } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";

// Per-analysis advisory lock so an analysis is open in at most one `inflexa` instance. Modeled on the
// auth refresh lock (src/modules/auth/auth.ts:357-428) — an O_EXCL lock file under the data dir —
// but with one deliberate divergence: liveness is PID-based, not time-based. The auth lock is held
// for ~seconds during one token refresh, so an age threshold is a fine "crashed holder" proxy. An
// analysis lock is held for an entire interactive chat session (possibly hours, mostly idle), where
// an age threshold would falsely free a live, idle instance and let a second one in. So a held lock
// records its holder's pid and a contender reclaims only when that pid is dead (process.kill(pid,0)
// throws ESRCH). The lock is keyed by analysis id, not session id, because one analysis owns many
// sessions and the analysis is the unit of work.

/** The analysis id this process currently holds a lock for, so the exit hook can release without re-deriving it. At most one — the lock is re-keyed on every in-process switch. */
let heldAnalysisId: string | null = null;

/** Outcome of an acquire attempt. `acquired:false` is an expected, non-error branch (the analysis is live elsewhere) — not a thrown failure — so it is a plain union, not a neverthrow `Result`. */
export type LockOutcome = { acquired: true } | { acquired: false; holderPid: number };

/** Absolute path of an analysis's lock file. Exported for the unit test, which seeds and inspects it directly. */
export function analysisLockPath(analysisId: string): string {
    return join(env.locksDir, `${analysisId}.lock`);
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
 * dead (that would let two instances share the analysis). When in doubt, keep the lock.
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
 * Claim the lock for `analysisId`. Atomic create (`wx` = O_EXCL) wins outright; on contention the
 * holder's pid decides: ours → re-entrant success (a same-analysis session switch re-acquires), a
 * live foreign pid → conflict, a dead/corrupt pid → reclaim.
 *
 * Fails OPEN: if the lock file genuinely can't be written (broken/unwritable data dir), we log and
 * report success rather than block the user — this is an advisory UX guard, and an unwritable data
 * dir is a larger failure surfaced where the SQLite DB lives, not here.
 */
export function acquireAnalysisLock(analysisId: string): LockOutcome {
    const path = analysisLockPath(analysisId);
    const mine = String(process.pid);
    try {
        mkdirSync(env.locksDir, { recursive: true });
        writeFileSync(path, mine, { flag: "wx" });
        heldAnalysisId = analysisId;
        return { acquired: true };
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
            getLogger("analysis").warn({ err: cause, analysisId }, "lock write failed; proceeding without lock");
            return { acquired: true };
        }
    }

    const holderPid = readHolderPid(path);
    if (holderPid === process.pid) {
        heldAnalysisId = analysisId; // already ours (re-entrant)
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
        heldAnalysisId = analysisId;
        return { acquired: true };
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
            return { acquired: false, holderPid: readHolderPid(path) ?? -1 };
        }
        getLogger("analysis").warn({ err: cause, analysisId }, "lock reclaim failed; proceeding without lock");
        return { acquired: true };
    }
}

/**
 * Release `analysisId`'s lock, but only if this process still owns the file. The ownership check
 * matters because a crashed holder's lock may have been reclaimed (and rewritten with another pid)
 * by a different instance — we must never delete a lock we no longer hold.
 */
export function releaseAnalysisLock(analysisId: string): void {
    if (readHolderPid(analysisLockPath(analysisId)) === process.pid) {
        rmSync(analysisLockPath(analysisId), { force: true });
    }
    if (heldAnalysisId === analysisId) heldAnalysisId = null;
}

/**
 * Release whatever lock this process holds. Synchronous and self-contained so it can run from the
 * `process.on("exit")` hook (src/index.ts), which only runs sync work and is the broadest exit path —
 * it fires on graceful quit (App.quit → shutdown → process.exit) and on every other process.exit.
 * A hard kill (SIGKILL) bypasses it; that stale file is reclaimed by the pid check on the next open.
 */
export function releaseHeldAnalysisLock(): void {
    if (heldAnalysisId) releaseAnalysisLock(heldAnalysisId);
}
