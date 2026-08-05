import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { type Result, ok, err } from "neverthrow";

/**
 * Filesystem error for operations that can fail with an OS-level I/O error.
 * `op` names the logical operation so callers can distinguish "which read
 * failed" without inspecting the cause.
 */
export type FsError = { type: "io_failed"; op: string; cause: unknown };

/** Read a UTF-8 text file, wrapping `readFileSync` throws into `Result`. */
export function readFileResult(path: string, op: string): Result<string, FsError> {
    try {
        return ok(readFileSync(path, "utf8"));
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/** Write a text file, wrapping `writeFileSync` throws into `Result`. */
export function writeFileResult(path: string, data: string, op: string, opts?: Parameters<typeof writeFileSync>[2]): Result<void, FsError> {
    try {
        writeFileSync(path, data, opts);
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/** Create directories recursively, wrapping `mkdirSync` throws into `Result`. */
export function mkdirResult(path: string, op: string): Result<void, FsError> {
    try {
        mkdirSync(path, { recursive: true });
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/** Move/rename a path, wrapping `renameSync` throws into `Result`. */
export function renameResult(from: string, to: string, op: string): Result<void, FsError> {
    try {
        renameSync(from, to);
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/** Recursively remove a path, wrapping `rmSync` throws into `Result`. An absent path is a success. */
export function rmResult(path: string, op: string): Result<void, FsError> {
    try {
        rmSync(path, { recursive: true, force: true });
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/** Stat a path, wrapping `statSync` throws into `Result`. */
export function statResult(path: string, op: string): Result<Stats, FsError> {
    try {
        return ok(statSync(path));
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/**
 * The identity a readability decision is made against: this process's effective user, its effective
 * group, and every supplementary group it belongs to. Read ONCE per listing (the ids cannot change
 * mid-render) and passed down, so {@link isReadableBy} stays a pure function of two inputs.
 */
export type ProcessIdentity = { uid: number; gid: number; groups: readonly number[] };

/**
 * This process's identity, or `null` on a platform without POSIX ids.
 *
 * `process.getuid` is undefined on Windows, where Node also synthesizes mode bits that describe no
 * real permission — so "no identity" is the honest answer there, not a fabricated one, and every
 * caller must render no readability signal rather than a wrong one.
 */
export function processIdentity(): ProcessIdentity | null {
    // Feature-detected rather than branched on `process.platform`: these are documented as
    // POSIX-only, and the presence of the function is the exact condition that makes the read safe.
    if (!process.getuid || !process.getgid || !process.getgroups) return null;
    return { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() };
}

/**
 * Whether `identity` can read the file `stats` describes, decided from the mode bits and the owning
 * ids alone — NO syscall.
 *
 * This exists to avoid an `accessSync(R_OK)` pass over a directory listing. A `stat` is already
 * taken for the size and the mtime, and it carries everything this needs; measured over a 468-entry
 * directory, the extra `access` pass cost 2.5–4.7ms against `stat`'s 0.69ms, for an answer the
 * `Stats` object already implies.
 *
 * ACCEPTED IMPRECISION: mode bits are not the whole access story. A POSIX ACL, a macOS TCC rule, or
 * a file flag can deny a read this reports as permitted. A directory is a second such case, and one
 * this deliberately does not model: `r` lists its names but `x` is what reaches the entries inside,
 * so a directory with `r` and no `x` reports readable and still refuses every path through it. Both
 * bits would answer "can I browse it", which is a different question from the one asked here.
 *
 * The result is therefore advisory — it colors a row, and never refuses a selection. The
 * authoritative refusal stays where the file is actually opened (staging), which already reports a
 * failure the user can act on.
 */
export function isReadableBy(stats: Stats, identity: ProcessIdentity): boolean {
    // Root bypasses the permission bits for reads, so the mode check below would report false for a
    // 0600 file owned by someone else — a "you cannot read this" that is simply untrue as root.
    if (identity.uid === 0) return true;
    if (stats.uid === identity.uid) return (stats.mode & 0o400) !== 0;
    // Supplementary groups count, not just the effective gid: a file group-readable by `staff` is
    // readable by a user who merely belongs to `staff`, which `getgid()` alone would miss.
    if (stats.gid === identity.gid || identity.groups.includes(stats.gid)) return (stats.mode & 0o040) !== 0;
    return (stats.mode & 0o004) !== 0;
}
