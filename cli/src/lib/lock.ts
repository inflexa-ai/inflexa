import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { env } from "./env.ts";
import { errnoCode } from "./fs.ts";
import { getLogger } from "./log.ts";

// A keyed advisory instance lock so a resource is held by at most one `inflexa` process at a time.
// Modeled on the auth refresh lock (src/modules/auth/auth.ts) — an O_EXCL lock file under the data dir —
// but with one deliberate divergence: liveness is PID-based, not time-based. The auth lock is held
// for ~seconds during one token refresh, so an age threshold is a fine "crashed holder" proxy. These
// locks are held for a long time (an interactive chat session, a data-profile run — possibly hours,
// mostly idle), where an age threshold would falsely free a live, idle instance and let a second one
// in. So a held lock records its holder's identity (the pid, the host, and the start of the process) and
// a contender reclaims only when that process is gone (isProcessAlive). Two keys are in use today: an analysis id (one analysis open per
// instance) and a fixed sentinel for the embedded harness runtime (one DBOS engine — executor "local"
// — per machine, or a second process's launch-time recovery would adopt this one's in-flight
// workflows). The key is any collision-free string; analysis ids are UUIDv7, so they never collide
// with the runtime sentinel.

/** Keys this process currently holds locks for, so the exit hook can release them without re-deriving. A process may hold several at once (e.g. an open analysis and the harness runtime). */
const heldKeys = new Set<string>();

/** Outcome of an acquire attempt. `acquired:false` is an expected, non-error branch (the resource is live elsewhere) — not a thrown failure — so it is a plain union, not a neverthrow `Result`. */
export type LockOutcome =
    | { acquired: true }
    /** `holderHost` is set only when the holder runs on a different host, which shares this data folder. */
    | { acquired: false; holderPid: number; holderHost?: string };

/**
 * Advisory-lock key for the embedded harness runtime. A fixed sentinel — not an analysis id — because
 * the lock guards the single per-machine DBOS engine (executor "local"), not any one analysis. It never
 * collides with an analysis lock, because analysis ids are UUIDv7.
 *
 * It lives here rather than beside the runtime because a live runtime is a fact other commands must read.
 * A command that must not disturb a live sandbox reads the lock, and it must not import the harness
 * runtime module to learn the key.
 */
export const HARNESS_RUNTIME_LOCK_KEY = "harness-runtime";

/**
 * Advisory-lock key family of the detached transfer children — the runtime image, the provisioner
 * image, and the catalog download. The kind of the transfer follows the prefix.
 *
 * Each key does two jobs at one time. It gives single-flight: a start that finds the lock held starts
 * no second child of that kind. It also gives liveness: the child holds the key for its whole life,
 * thus a row that reports `running` with no live holder reads as `failed`. A killed child writes no
 * failure row, and this is the only sound signal that needs no heartbeat and no clock.
 */
export const TRANSFER_LOCK_KEY_PREFIX = "package-store-transfer-";

/**
 * Advisory-lock key for a reclamation of the package store.
 *
 * A reclamation is exclusive against the acquisition flights and the farm compositions: it waits for
 * zero live linkers, and it blocks a new one while it scans and deletes. This key is that block. A
 * linker yields while a live process holds it, thus a reclaim never frees a store directory that a
 * linker is about to reference.
 */
export const PACKAGE_STORE_RECLAIM_LOCK_KEY = "package-store-reclaim";

/**
 * Advisory-lock key for the store-level metadata of the package store — the dependency graph
 * `deps.json` at the store root.
 *
 * Two writers touch that record. A download with `--update` replaces the graph of the old catalog with
 * the graph of the new one. A flight commit appends the nodes that it acquired. The two must not
 * interleave, thus each takes this key for the write and releases it after.
 */
export const PACKAGE_STORE_METADATA_LOCK_KEY = "package-store-metadata";

/**
 * Advisory-lock key of a client that starts the local server in the background. The holder reads the
 * discovery file again before it spawns, thus two clients that find no server start one server, not two.
 */
export const SERVER_SPAWN_LOCK_KEY = "server-spawn";

/** The extension of every lock file, which is what turns a file name of the lock directory back into a key. */
const LOCK_SUFFIX = ".lock";

/** Absolute path of a lock file for `key`. Exported for the unit test, which seeds and inspects it directly. */
export function instanceLockPath(key: string): string {
    return join(env.locksDir, `${key}${LOCK_SUFFIX}`);
}

/**
 * Who holds a lock or a discovery file: a pid, and what makes that pid mean one process.
 *
 * A pid alone is not an identity. After a reboot the kernel gives the same pid to a different process, and a
 * lock that holds only the pid then waits for that process for ever. The start time makes a reused pid read as a
 * different process. The host name tells a record of a different machine apart: a data folder on a shared home
 * (NFS) is open to each host, and a pid of a different host cannot be probed from here.
 */
export type ProcessIdentity = {
    readonly pid: number;
    /** The host name of the machine of the process. `null` when the record does not say. */
    readonly host: string | null;
    /** An opaque token of the start of the process (see {@link processStartToken}). `null` when it is not known. */
    readonly start: string | null;
};

const lockRecordSchema = z.object({
    pid: z.number().int().positive(),
    host: z.string().nullable(),
    start: z.string().nullable(),
});

/**
 * An opaque token that changes when `pid` names a different process: the start time of the process, as the
 * operating system reports it. `null` when the process is gone or the platform does not tell.
 *
 * The token is compared for equality only, thus each platform uses the cheapest stable form. Linux reads
 * `/proc`: the boot id plus the start tick of the process, because the tick counts from the boot. macOS has
 * no `/proc`, thus it asks `ps` for the start time, under the C locale and UTC, so that a server and a client
 * with a different locale or time zone read the same text.
 */
export function processStartToken(pid: number): string | null {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            // The command name in field 2 can hold spaces and parentheses, thus the fields count from its last `)`.
            // After it, field 3 (the state) is index 0, and field 22 (the start tick) is index 19.
            const startTick = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
            const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
            return startTick === undefined ? null : `${bootId}:${startTick}`;
        } catch {
            return null; // ENOENT: the process is gone. Any other read error: the start is not known.
        }
    }
    if (process.platform === "darwin") {
        try {
            const ps = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
                env: { LC_ALL: "C", TZ: "UTC" },
                stdout: "pipe",
                stderr: "ignore",
            });
            const start = ps.stdout.toString().trim();
            return ps.exitCode === 0 && start !== "" ? start : null;
        } catch {
            return null; // The spawn failed: the start is not known.
        }
    }
    return null;
}

let ownIdentity: ProcessIdentity | null = null;

/** The identity of this process. Read one time, because the start of a process does not change. */
export function ownProcessIdentity(): ProcessIdentity {
    ownIdentity ??= { pid: process.pid, host: hostname(), start: processStartToken(process.pid) };
    return ownIdentity;
}

/** The identity of the process `pid` of this host, as a lock file records it. */
export function processIdentity(pid: number): ProcessIdentity {
    return pid === process.pid ? ownProcessIdentity() : { pid, host: hostname(), start: processStartToken(pid) };
}

/** The host of a record when it is a different host than this one, else `null`. */
export function foreignHost(holder: ProcessIdentity): string | null {
    return holder.host !== null && holder.host !== hostname() ? holder.host : null;
}

/**
 * Whether the process of a record still lives. A pid of this host that now has a different start time names a
 * process that is gone.
 *
 * The danger is in one direction only: to read a live holder as dead lets two instances share the resource.
 * Thus each doubt keeps the holder alive: a record of a different host, whose process this host cannot probe,
 * EPERM from the pid probe (a process of a different user), and a start time that cannot be read now. A record
 * of a host that is gone stays until the person removes it.
 */
export function isProcessAlive(holder: ProcessIdentity): boolean {
    if (foreignHost(holder) !== null) return true;
    if (!isPidAlive(holder.pid)) return false;
    if (holder.start === null) return true;
    const now = processStartToken(holder.pid);
    return now === null || now === holder.start;
}

/** Whether a record names this process: the same pid on the same host. */
function isOwnRecord(holder: ProcessIdentity): boolean {
    return holder.pid === process.pid && (holder.host === null || holder.host === hostname());
}

/** Read the holder from a lock file, or null if it is missing or its contents aren't a lock record (a truncated/corrupt write counts as no live holder, so it gets reclaimed). */
function readHolder(path: string): ProcessIdentity | null {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return null; // ENOENT (gone) or any read error → treat as no holder
    }
    return JSON.parseWith(raw, lockRecordSchema);
}

/**
 * Whether a pid belongs to a live process, by the pid alone. `process.kill(pid, 0)` sends no signal — it only
 * probes existence. ESRCH is the one unambiguous "dead" answer; EPERM (exists but owned by another user) and
 * any other error are treated as ALIVE. A record that this code writes uses {@link isProcessAlive}, because a
 * pid alone cannot see a reused pid.
 *
 * Exported for the second holder-of-record in the codebase: an acquisition flight records its owner pid
 * on its own row rather than in a lock file, because a flight key is minted at runtime and a file for
 * each key would carry no more truth than that column.
 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (cause) {
        return errnoCode(cause) !== "ESRCH";
    }
}

/**
 * Claim the lock for `key`. Atomic create (`wx` = O_EXCL) wins outright; on contention the holder record
 * decides: ours → re-entrant success (a same-key re-acquire), a live foreign process → conflict, a
 * dead/reused/corrupt record → reclaim.
 *
 * Fails OPEN: if the lock file genuinely can't be written (broken/unwritable data dir), we log and
 * report success rather than block the user — this is an advisory UX guard, and an unwritable data
 * dir is a larger failure surfaced where the SQLite DB lives, not here.
 */
export function acquireInstanceLock(key: string): LockOutcome {
    const path = instanceLockPath(key);
    const mine = JSON.stringify(ownProcessIdentity());
    try {
        mkdirSync(env.locksDir, { recursive: true });
        writeFileSync(path, mine, { flag: "wx" });
        heldKeys.add(key);
        return { acquired: true };
    } catch (cause) {
        if (errnoCode(cause) !== "EEXIST") {
            getLogger("lock").warn({ err: cause, key }, "lock write failed; proceeding without lock");
            return { acquired: true };
        }
    }

    const holder = readHolder(path);
    if (holder !== null && isOwnRecord(holder)) {
        heldKeys.add(key); // already ours (re-entrant)
        return { acquired: true };
    }
    if (holder !== null && isProcessAlive(holder)) {
        const holderHost = foreignHost(holder);
        return holderHost === null ? { acquired: false, holderPid: holder.pid } : { acquired: false, holderPid: holder.pid, holderHost };
    }

    // Dead, reused, or corrupt holder: reclaim. Remove then re-create exclusively so that, in the narrow
    // window after a holder crash where two contenders race, the loser sees EEXIST and yields
    // instead of both believing they won.
    rmSync(path, { force: true });
    try {
        writeFileSync(path, mine, { flag: "wx" });
        heldKeys.add(key);
        return { acquired: true };
    } catch (cause) {
        if (errnoCode(cause) === "EEXIST") {
            return { acquired: false, holderPid: readHolder(path)?.pid ?? -1 };
        }
        getLogger("lock").warn({ err: cause, key }, "lock reclaim failed; proceeding without lock");
        return { acquired: true };
    }
}

/**
 * The pid of the LIVE process that holds `key`'s lock, or `null` when nothing live holds it.
 *
 * READ-ONLY, and that is the whole point. {@link acquireInstanceLock} reclaims a lock whose holder is
 * dead and it writes this process's pid, thus a reader that used it to answer "is a downloader live"
 * would take the lock and refuse the next real downloader. This probe writes nothing and creates
 * nothing.
 *
 * It reuses the two facts the acquire path already establishes: the lock path of a key, and the pid
 * test. A dead or corrupt holder answers `null`, exactly as it reads to a contender.
 */
export function instanceLockHolder(key: string): number | null {
    const holder = readHolder(instanceLockPath(key));
    return holder !== null && isProcessAlive(holder) ? holder.pid : null;
}

/** One live hold of an instance lock: the key, and the process that holds it. */
export type InstanceLockHold = { readonly key: string; readonly pid: number };

/**
 * Each LIVE hold of a lock key that starts with `prefix`, with a sweep of each record a dead process
 * left behind.
 *
 * {@link instanceLockHolder} answers one key that its caller already names. This answers a FAMILY of
 * keys, for a reader that must wait for whatever holds them right now: the reclamation of the package
 * store waits for each live farm composition, and a composition mints its key from an analysis id that
 * the reclamation never learns.
 *
 * The sweep is what makes the liveness of the holder the signal, rather than the record. A hard kill
 * (SIGKILL) leaves the lock file, thus a reader that counted files would wait for a process that is
 * gone. The sweep runs through {@link acquireInstanceLock} and {@link releaseInstanceLock}, and never
 * through a bare delete: acquire is the one writer that reclaims a dead lock, and it re-creates the file
 * exclusively, thus a contender that reclaimed the same file one moment earlier keeps it. A bare delete
 * would remove the lock of that live contender.
 */
export function liveInstanceLockHolds(prefix: string): readonly InstanceLockHold[] {
    let names: string[];
    try {
        names = readdirSync(env.locksDir);
    } catch {
        return []; // No lock directory (or none readable) means that nothing holds a lock.
    }

    const live: InstanceLockHold[] = [];
    for (const name of names.sort()) {
        if (!name.startsWith(prefix) || !name.endsWith(LOCK_SUFFIX)) continue;
        const key = name.slice(0, name.length - LOCK_SUFFIX.length);
        const holder = readHolder(instanceLockPath(key));
        if (holder !== null && isProcessAlive(holder)) {
            live.push({ key, pid: holder.pid });
            continue;
        }
        // A dead or corrupt holder is debris. The acquire reclaims it, and the release then removes the
        // file, because this process owns it at that point.
        if (acquireInstanceLock(key).acquired) releaseInstanceLock(key);
    }
    return live;
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
    const holder = readHolder(instanceLockPath(key));
    if (holder !== null && isOwnRecord(holder)) {
        rmSync(instanceLockPath(key), { force: true });
    }
    heldKeys.delete(key);
}

/**
 * Release every lock this process holds. Synchronous and self-contained so it can run from the
 * `process.on("exit")` hook (src/index.ts), which only runs sync work and is the broadest exit path —
 * it fires on graceful quit (App.quit → shutdown → process.exit) and on every other process.exit.
 * A hard kill (SIGKILL) bypasses it; those stale files are reclaimed by the holder check on the next open.
 */
export function releaseHeldInstanceLocks(): void {
    for (const key of [...heldKeys]) releaseInstanceLock(key);
}
