import { mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
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

/** Stat a path, wrapping `statSync` throws into `Result`. */
export function statResult(path: string, op: string): Result<Stats, FsError> {
    try {
        return ok(statSync(path));
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}
