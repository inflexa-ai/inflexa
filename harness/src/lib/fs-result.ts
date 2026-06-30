/**
 * Filesystem Result glue for cortex.
 *
 * The workspace read seam (`workspace/filesystem.ts`) and the handful of
 * modules that touch `node:fs` directly (e.g. `memory/card-builders.ts`) model
 * failure as values. The ONLY `try/catch` against `node:fs` lives here, in
 * `tryFs` — it turns a genuine I/O throw into an `err(FsError)`; everything
 * above flows `ResultAsync`.
 *
 * House rules realized here (see `lib/result.ts`):
 *  - Absence is NOT an error. A missing path stays in the OK channel as a data
 *    variant: the seam returns `ok({ kind: "not_found" })` / `ok({ kind:
 *    "out_of_scope" })`, never an `err`. The fs-level `ENOENT`/`ENOTDIR` checks
 *    that distinguish absence map to the absence sentinel the caller supplies
 *    (`onAbsent`), NOT to an `err`. `FsError` is reserved for a genuine I/O
 *    failure — a permission denial (`EACCES`/`EPERM`), an `EISDIR` where a file
 *    was expected, a disk error, a too-many-open-files (`EMFILE`), a presigned
 *    download fetch failure.
 *  - Control-flow exceptions (DBOS cancellation, `AbortError`) are NOT failures
 *    and are never captured as an `FsError`: `tryFs` only ever wraps the single
 *    `fs` call passed to it. An `AbortError` raised inside a streamed read is a
 *    control-flow signal — keep it outside the wrapped call (it propagates) or
 *    re-classify it explicitly; do NOT funnel a whole streaming body through
 *    `tryFs` such that an `AbortError` becomes an `err`.
 *
 * Consumers unwrap per their edge: tool `execute` bodies (`read_file`, `grep`,
 * `list_files`, `file_stat`, `edit_file`) `unwrapOrThrow` the Result, then
 * switch on the OK-channel `.kind`; degrade-to-null direct-fs callers
 * (`card-builders`) `.unwrapOr(null)` / `.match` to preserve their "any failure
 * → fall back to a chip" behaviour.
 */

import { ResultAsync, err, ok } from "neverthrow";

import type { DomainError } from "./result.js";

/**
 * A filesystem failure. Absence is deliberately NOT modelled here — a missing
 * file/dir rides the OK channel as the seam's `not_found` / `out_of_scope` data
 * variant (or a caller-chosen sentinel via `tryFs(..., { onAbsent })`).
 * `FsError` is reserved for a genuine, unexpected I/O failure. `op` is a stable
 * human-readable label (e.g. `"workspace.readFile"`, `"cardBuilders.subdirs"`)
 * used by `describeFsError` and in logs.
 */
export type FsError =
    | { readonly type: "read_failed"; readonly op: string; readonly path?: string; readonly cause: unknown }
    | { readonly type: "write_failed"; readonly op: string; readonly path?: string; readonly cause: unknown }
    | { readonly type: "permission_denied"; readonly op: string; readonly path?: string; readonly cause: unknown }
    | { readonly type: "is_a_directory"; readonly op: string; readonly path?: string; readonly cause: unknown }
    | { readonly type: "fetch_failed"; readonly op: string; readonly path?: string; readonly cause: unknown };

// FsError is a `DomainError` (string `type` + `cause`) — the compile-time check
// keeps it inside the cross-subsystem error vocabulary.
type _AssertDomainError = FsError extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

/** errno codes that mean "the path is absent" — the caller's concern, mapped to
 *  the supplied absence sentinel, NOT to an `err`. */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

/** errno codes that mean "permission denied". */
const PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

function errnoOf(cause: unknown): string | undefined {
    if (cause && typeof cause === "object" && "code" in cause) {
        const code = (cause as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}

/** True when the throw is a plain "this path isn't here" — `ENOENT`/`ENOTDIR`. */
export function isAbsent(cause: unknown): boolean {
    const code = errnoOf(cause);
    return code !== undefined && ABSENT_CODES.has(code);
}

/** Map an `fs` throw to a typed `FsError`. `EACCES`/`EPERM` → permission_denied;
 *  `EISDIR` → is_a_directory; everything else → read_failed (or write_failed,
 *  via `tryFsWrite`). Absence (`ENOENT`/`ENOTDIR`) is NOT routed here — `tryFs`
 *  intercepts it first and yields the absence sentinel. */
function readError(op: string, path: string | undefined, cause: unknown): FsError {
    const code = errnoOf(cause);
    if (code && PERMISSION_CODES.has(code)) return { type: "permission_denied", op, path, cause };
    if (code === "EISDIR") return { type: "is_a_directory", op, path, cause };
    return { type: "read_failed", op, path, cause };
}

function writeError(op: string, path: string | undefined, cause: unknown): FsError {
    const code = errnoOf(cause);
    if (code && PERMISSION_CODES.has(code)) return { type: "permission_denied", op, path, cause };
    return { type: "write_failed", op, path, cause };
}

/** A one-line, user-facing description of an `FsError` for logs and error bodies. */
export function describeFsError(e: FsError): string {
    const at = e.path ? ` (${e.op}: ${e.path})` : ` (${e.op})`;
    switch (e.type) {
        case "read_failed":
            return `filesystem read failed${at}`;
        case "write_failed":
            return `filesystem write failed${at}`;
        case "permission_denied":
            return `filesystem permission denied${at}`;
        case "is_a_directory":
            return `expected a file but found a directory${at}`;
        case "fetch_failed":
            return `remote file fetch failed${at}`;
    }
}

/**
 * Wrap a single `fs` read call. A genuine `fs` throw becomes `err(read_failed)`
 * — or `err(permission_denied)` / `err(is_a_directory)` for the matching errno.
 * When `onAbsent` is supplied, an `ENOENT`/`ENOTDIR` throw is intercepted and
 * its return value placed in the OK channel (absence is NOT an error).
 *
 * `fn` runs the single `fs` call and returns the already-mapped value (`T`).
 * Keep `fn` to the one `await fs.X(...)` plus trivial mapping; do NOT embed
 * control-flow that could throw a non-`fs` error (an `AbortError` raised inside
 * `fn` would be miscaptured as an `FsError` — keep abortable streaming bodies
 * out of `tryFs`).
 */
export function tryFs<T>(op: string, fn: () => Promise<T>, options: { path?: string; onAbsent?: () => T } = {}): ResultAsync<T, FsError> {
    return new ResultAsync(
        (async () => {
            try {
                return ok(await fn());
            } catch (cause) {
                if (options.onAbsent && isAbsent(cause)) return ok(options.onAbsent());
                return err(readError(op, options.path, cause));
            }
        })(),
    );
}

/** `tryFs` for a write/mkdir/open-for-write call: maps the non-permission
 *  default to `write_failed`. Absence semantics are identical. */
export function tryFsWrite<T>(op: string, fn: () => Promise<T>, options: { path?: string; onAbsent?: () => T } = {}): ResultAsync<T, FsError> {
    return new ResultAsync(
        (async () => {
            try {
                return ok(await fn());
            } catch (cause) {
                if (options.onAbsent && isAbsent(cause)) return ok(options.onAbsent());
                return err(writeError(op, options.path, cause));
            }
        })(),
    );
}

/**
 * Wrap a presigned-download fetch (the `PresignedFallback.fetch` seam call) into
 * the same error channel. A throw becomes `err(fetch_failed)`; a `null` return
 * (file genuinely not present remotely) stays in the OK channel as `null`.
 */
export function tryFetch<T>(op: string, fn: () => Promise<T>, path?: string): ResultAsync<T, FsError> {
    return new ResultAsync(
        (async () => {
            try {
                return ok(await fn());
            } catch (cause) {
                return err({ type: "fetch_failed", op, path, cause });
            }
        })(),
    );
}
