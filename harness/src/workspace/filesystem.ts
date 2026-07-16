/**
 * The workspace read seam — `{ readFile, list, stat }` over the analysis
 * workspace tree. A construction-time dependency (see the harness-durable-runtime spec): the composition
 * root builds one `WorkspaceFilesystem` and passes it to tool factories.
 *
 * Reads resolve from the analysis's workspace root when the file is present and
 * fall back to an embedder-supplied presigned URL otherwise. The seam writes no
 * provenance — reads don't produce lineage — and does not depend on any
 * sandbox.
 *
 * Scoping is enforced once, here, by `resolveWorkspacePath`: any path that
 * escapes the analysis's resolved workspace root is rejected before any I/O.
 * `read_file` / `grep` / any future reader share the chokepoint.
 *
 * Reads roam the whole tree read-only, so the seam never confines. Relative
 * paths resolve against the caller-supplied `workingDir` (frame-local, per
 * the harness-workspace-tools spec);
 * when omitted they resolve against the analysis root, which is the
 * conversation-agent behaviour. Sandbox read tools pass the step working
 * directory so a relative path reads back what a relative write wrote.
 *
 * Failure is modelled as values (see `lib/fs-result.ts`): the public methods
 * return `ResultAsync<…, FsError>`. The `not_found` / `out_of_scope` /
 * `truncated` outcomes are NOT failures — they ride the OK channel as `.kind`
 * data variants. `err(FsError)` is reserved for a genuine I/O failure
 * (permission, `EISDIR`, a presigned-fetch throw). An `AbortError` raised
 * inside a streamed read is control-flow — the streaming/iteration body is kept
 * OUTSIDE `tryFs`, so only the discrete `fs.open` / `fs.read` / `fs.readFile`
 * calls become `err`.
 */

import { lstat as fsLstat, open as fsOpen, readdir as fsReaddir, stat as fsStat, type FileHandle } from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { ResultAsync, err, errAsync, ok, type Result } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import { scopeResource } from "../auth/types.js";
import { type FsError, tryFetch, tryFs } from "../lib/fs-result.js";
import { classifyWithinRoot } from "../lib/fs-helpers.js";
import { resolveWorkspacePath, type ResolvedPath, type ResolveWorkspaceRoot } from "./paths.js";

// ── Result types ──────────────────────────────────────────────────────────

export type ReadFileResult =
    | { readonly kind: "ok"; readonly content: Buffer; readonly truncated: false }
    | {
          readonly kind: "truncated";
          readonly content: Buffer;
          readonly totalSize: number;
      }
    | { readonly kind: "not_found" }
    | { readonly kind: "out_of_scope" };

export type ListEntry = {
    readonly name: string;
    readonly type: "file" | "directory";
    readonly size?: number;
};

export type ListResult = { readonly kind: "ok"; readonly entries: readonly ListEntry[] } | { readonly kind: "not_found" } | { readonly kind: "out_of_scope" };

export type StatResult =
    | {
          readonly kind: "ok";
          readonly type: "file" | "directory";
          readonly size: number;
      }
    | { readonly kind: "not_found" }
    | { readonly kind: "out_of_scope" };

// ── Seam interface ────────────────────────────────────────────────────────

export interface WorkspaceFilesystem {
    /**
     * Read a workspace file. `headLines` / `tailLines` (mutually exclusive,
     * enforced by the caller) constrain the read to the first N / last N
     * complete lines respectively. `maxBytes` is always the outer cap — when
     * it binds before the line cap, the result is `truncated`.
     *
     * `not_found` / `out_of_scope` / `truncated` are OK-channel data variants;
     * `err(FsError)` is a genuine I/O failure.
     */
    readFile(args: {
        readonly session: AgentSession;
        readonly path: string;
        readonly maxBytes?: number;
        readonly headLines?: number;
        readonly tailLines?: number;
        /** Absolute host base for relative paths. Defaults to the analysis root. */
        readonly workingDir?: string;
    }): ResultAsync<ReadFileResult, FsError>;
    list(args: { readonly session: AgentSession; readonly path: string; readonly workingDir?: string }): ResultAsync<ListResult, FsError>;
    stat(args: { readonly session: AgentSession; readonly path: string; readonly workingDir?: string }): ResultAsync<StatResult, FsError>;
}

/**
 * Adapter for fetching files that aren't present locally. The managed
 * realization downloads via object-store presigned URLs; the OSS build omits
 * the fallback (files are local) and tests pass a fake.
 */
export interface PresignedFallback {
    fetch(args: { readonly session: AgentSession; readonly relativePath: string }): Promise<Buffer | null>;
}

export interface WorkspaceFilesystemDeps {
    /** Embedder-supplied workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Optional fallback for files not present locally. */
    readonly presignedFallback?: PresignedFallback;
}

// ── Constructor ───────────────────────────────────────────────────────────

export function createWorkspaceFilesystem(deps: WorkspaceFilesystemDeps): WorkspaceFilesystem {
    const { resolveWorkspaceRoot, presignedFallback } = deps;

    /**
     * `ResolveWorkspaceRoot` signals an unresolvable resource by throwing — the contract that
     * makes a resolution failure inside a DBOS body a durably-failed step. This seam is not a
     * DBOS body: it promises `Result`, and the read tools it backs are reachable from a live
     * chat turn whose analysis folder may have been moved or deleted since the turn began.
     * Convert at the boundary so an unresolvable root is a value here, not an exception that
     * only survives because some caller happens to wrap it.
     */
    function resolveFor(session: AgentSession, path: string, workingDir?: string): Result<{ resolved: ResolvedPath; workspaceRoot: string }, FsError> {
        const { resourceId: analysisId } = scopeResource(session.scope);
        let workspaceRoot: string;
        try {
            workspaceRoot = resolveWorkspaceRoot(analysisId);
        } catch (cause) {
            return err({ type: "read_failed", op: "workspace.resolveWorkspaceRoot", path: analysisId, cause });
        }
        return ok({ resolved: resolveWorkspacePath({ workspaceRoot, analysisId, path, workingDir }), workspaceRoot });
    }

    /**
     * Lexical resolution PLUS a symlink-following confinement check — the single
     * chokepoint every read tool (`read_file`, `grep`, `list`, `stat`) funnels
     * through. `resolveWorkspacePath` is purely lexical, so a symlink an agent
     * planted in its writable step dir (pointing at a host file outside the tree)
     * would otherwise be read through by this host process. `classifyWithinRoot`
     * follows the link: an `escaped` verdict is downgraded to `out_of_scope`; an
     * `absent` path passes through unchanged so the caller's own not-found /
     * presigned-fallback handling still runs (a non-existent path leaks nothing).
     */
    function confinedResolve(session: AgentSession, path: string, workingDir?: string): ResultAsync<ResolvedPath, FsError> {
        const base = resolveFor(session, path, workingDir);
        if (base.isErr()) return errAsync(base.error);
        const { resolved, workspaceRoot } = base.value;
        if (resolved.kind === "out_of_scope") return okAsync<ResolvedPath>(resolved);
        return ResultAsync.fromPromise(classifyWithinRoot(workspaceRoot, resolved.absolute), (cause): FsError => ({
            type: "read_failed",
            op: "workspace.confineRealpath",
            path: resolved.absolute,
            cause,
        })).map((verdict): ResolvedPath => (verdict === "escaped" ? { kind: "out_of_scope" } : resolved));
    }

    return {
        readFile({ session, path, maxBytes, headLines, tailLines, workingDir }) {
            return confinedResolve(session, path, workingDir).andThen((resolved): ResultAsync<ReadFileResult, FsError> => {
                if (resolved.kind === "out_of_scope") {
                    return okAsync<ReadFileResult>({ kind: "out_of_scope" });
                }
                const absolute = resolved.absolute;
                const relative = resolved.relative;

                return safeStat(absolute).andThen((localStat): ResultAsync<ReadFileResult, FsError> => {
                    if (localStat?.isFile()) {
                        if (headLines !== undefined) {
                            return readHeadLines(absolute, headLines, maxBytes);
                        }
                        if (tailLines !== undefined) {
                            return readTailLines(absolute, localStat.size, tailLines, maxBytes);
                        }
                        return readWithCap(absolute, localStat.size, maxBytes);
                    }

                    if (presignedFallback) {
                        return tryFetch("workspace.presignedFetch", () => presignedFallback.fetch({ session, relativePath: relative }), relative).map(
                            (content): ReadFileResult => {
                                if (content !== null) {
                                    if (headLines !== undefined) return sliceHeadLines(content, headLines, maxBytes);
                                    if (tailLines !== undefined) return sliceTailLines(content, tailLines, maxBytes);
                                    return capBuffer(content, maxBytes);
                                }
                                return { kind: "not_found" };
                            },
                        );
                    }

                    return okAsync<ReadFileResult>({ kind: "not_found" });
                });
            });
        },

        list({ session, path, workingDir }) {
            return confinedResolve(session, path, workingDir).andThen((resolved): ResultAsync<ListResult, FsError> => {
                if (resolved.kind === "out_of_scope") {
                    return okAsync<ListResult>({ kind: "out_of_scope" });
                }
                const absolute = resolved.absolute;

                // `lstat` first so a symlinked directory leaf is refused, not
                // followed: a plain `readdir` would list the target's entries,
                // and a leaf swapped to an escaping symlink after the realpath
                // check would leak an off-tree directory's names. Node has no
                // fd-based readdir, so this narrows (does not fully close) the
                // readdir race — the atomic guarantee is on the content reads.
                return safeLstat(absolute).andThen((s): ResultAsync<ListResult, FsError> => {
                    if (s?.isSymbolicLink()) return okAsync<ListResult>({ kind: "out_of_scope" });
                    return tryFs<readonly { name: string; isDirectory(): boolean }[] | { notFound: true }>(
                        "workspace.list",
                        () => fsReaddir(absolute, { withFileTypes: true }),
                        { path: absolute, onAbsent: () => ({ notFound: true }) },
                    ).andThen((dirents): ResultAsync<ListResult, FsError> => {
                        if ("notFound" in dirents) return okAsync<ListResult>({ kind: "not_found" });
                        return collectEntries(absolute, dirents).map((entries): ListResult => ({ kind: "ok", entries }));
                    });
                });
            });
        },

        stat({ session, path, workingDir }) {
            return confinedResolve(session, path, workingDir).andThen((resolved): ResultAsync<StatResult, FsError> => {
                if (resolved.kind === "out_of_scope") {
                    return okAsync<StatResult>({ kind: "out_of_scope" });
                }

                // `lstat`, not `stat`: a leaf symlink is refused rather than
                // followed — same policy as the read open's `O_NOFOLLOW`.
                // Reporting a followed target's type/size would re-open the
                // metadata side of the confused-deputy leak, and it is atomic
                // (a single non-following syscall, no check/use gap).
                return safeLstat(resolved.absolute).map((s): StatResult => {
                    if (!s) return { kind: "not_found" };
                    if (s.isSymbolicLink()) return { kind: "out_of_scope" };
                    return {
                        kind: "ok",
                        type: s.isDirectory() ? "directory" : "file",
                        size: s.size,
                    };
                });
            });
        },
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** A bare `ok(value)` as a `ResultAsync`, with no `fs` call to wrap. */
function okAsync<T>(value: T): ResultAsync<T, FsError> {
    return new ResultAsync(Promise.resolve(ok(value)));
}

/** Stat a path; absence (`ENOENT`/`ENOTDIR`) → `ok(null)`, genuine I/O → `err`. */
function safeStat(absolute: string): ResultAsync<Stats | null, FsError> {
    return tryFs<Stats | null>("workspace.stat", () => fsStat(absolute), {
        path: absolute,
        onAbsent: () => null,
    });
}

/** Like {@link safeStat} but NEVER follows a leaf symlink (`lstat`) — the seam's
 *  read-side no-follow policy for the `stat`/`list` metadata surface. */
function safeLstat(absolute: string): ResultAsync<Stats | null, FsError> {
    return tryFs<Stats | null>("workspace.lstat", () => fsLstat(absolute), {
        path: absolute,
        onAbsent: () => null,
    });
}

/** Lstat each directory entry to attach a size; absence/I/O failures degrade to
 *  no size. `lstat` (not `stat`) so a symlink entry reports its own size, never
 *  its target's — a followed target could be off-tree. `d.isDirectory()` comes
 *  from the dirent, which does not follow, so a symlink is a plain `file` entry. */
function collectEntries(dir: string, dirents: readonly { name: string; isDirectory(): boolean }[]): ResultAsync<ListEntry[], FsError> {
    return ResultAsync.combine(
        dirents.map((d): ResultAsync<ListEntry, FsError> => {
            if (d.isDirectory()) return okAsync<ListEntry>({ name: d.name, type: "directory" });
            return safeLstat(join(dir, d.name)).map((s): ListEntry => ({ name: d.name, type: "file", size: s?.size ?? undefined }));
        }),
    );
}

/**
 * Read-only open flags that REFUSE to follow a final-component symlink.
 * `classifyWithinRoot` validated a snapshot of the path; a symlink swapped into
 * the leaf between that check and the open here would otherwise be followed
 * off-tree, re-opening the read-exfiltration hole for the length of the race
 * (CWE-367). `O_NOFOLLOW` makes the leaf open atomic — a symlinked final
 * component fails `ELOOP` in the same syscall that opens it, so there is no
 * check/use gap. `?? 0` keeps the mask valid on a platform that lacks the flag.
 *
 * This refuses EVERY leaf symlink, including an in-tree one the persistent check
 * would allow: pure Node cannot express "follow only if it stays in-tree" (that
 * needs `openat2(RESOLVE_BENEATH)`), so the atomic, race-free choice is to not
 * follow the leaf at all. Hard-linked staged inputs are unaffected — a hard link
 * is not a symlink. An intermediate-directory symlink is beyond this guard (Node
 * exposes no `openat2`); the upstream realpath check still rejects the
 * persistent case of that.
 */
const READ_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

type OpenedFile = { readonly kind: "ok"; readonly fh: FileHandle } | { readonly kind: "out_of_scope" };

/**
 * Open a workspace file read-only without following a leaf symlink (see
 * {@link READ_NO_FOLLOW}). A symlinked final component surfaces as `out_of_scope`
 * — the same verdict a persistent escape gets — never as off-tree bytes. Every
 * content read (`readWithCap`, `readHeadLines`, `readTailLines`) opens through
 * here so the bytes it streams come from a non-symlink leaf. Absence /
 * permission / other I/O throws flow the `FsError` channel unchanged.
 */
function openReadNoFollow(absolute: string): ResultAsync<OpenedFile, FsError> {
    return tryFs<OpenedFile>(
        "workspace.openNoFollow",
        async () => {
            try {
                return { kind: "ok", fh: await fsOpen(absolute, READ_NO_FOLLOW) };
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === "ELOOP") return { kind: "out_of_scope" };
                throw cause;
            }
        },
        { path: absolute },
    );
}

function readWithCap(absolute: string, totalSize: number, maxBytes: number | undefined): ResultAsync<ReadFileResult, FsError> {
    return openReadNoFollow(absolute).andThen((opened): ResultAsync<ReadFileResult, FsError> => {
        if (opened.kind === "out_of_scope") return okAsync<ReadFileResult>({ kind: "out_of_scope" });
        const fh = opened.fh;
        if (maxBytes !== undefined && totalSize > maxBytes) {
            return tryFs<ReadFileResult>(
                "workspace.readCapped",
                async () => {
                    try {
                        const buf = Buffer.alloc(maxBytes);
                        await fh.read(buf, 0, maxBytes, 0);
                        return { kind: "truncated", content: buf, totalSize };
                    } finally {
                        await fh.close();
                    }
                },
                { path: absolute },
            );
        }
        return tryFs<ReadFileResult>(
            "workspace.readFile",
            async () => {
                try {
                    return { kind: "ok", content: await fh.readFile(), truncated: false };
                } finally {
                    await fh.close();
                }
            },
            { path: absolute },
        );
    });
}

function capBuffer(content: Buffer, maxBytes: number | undefined): ReadFileResult {
    if (maxBytes !== undefined && content.length > maxBytes) {
        return {
            kind: "truncated",
            content: content.subarray(0, maxBytes),
            totalSize: content.length,
        };
    }
    return { kind: "ok", content, truncated: false };
}

/**
 * Stream the first `headLines` lines from disk, byte-bounded by `maxBytes`.
 * Stops at whichever cap binds first; the stream is destroyed eagerly so
 * we never read past the cap into RAM.
 *
 * The streaming/iteration body is kept OUTSIDE `tryFs` — an `AbortError` raised
 * inside it is control-flow and must propagate, not become `err`. Only the
 * follow-up `safeStat` (a discrete `fs` call) flows the `FsError` channel.
 */
function readHeadLines(absolute: string, headLines: number, maxBytes: number | undefined): ResultAsync<ReadFileResult, FsError> {
    return openReadNoFollow(absolute).andThen((opened): ResultAsync<ReadFileResult, FsError> => {
        if (opened.kind === "out_of_scope") return okAsync<ReadFileResult>({ kind: "out_of_scope" });
        const fh = opened.fh;
        return new ResultAsync(
            (async () => {
                // `autoClose: false` keeps the FileHandle ours to close — destroying
                // the stream must not race a close against our own `fh.close()`.
                const stream = fh.createReadStream({ highWaterMark: 16 * 1024, autoClose: false });
                const rl = createInterface({ input: stream, crlfDelay: Infinity });
                const collected: string[] = [];
                let bytes = 0;
                let truncated = false;
                try {
                    for await (const line of rl) {
                        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
                        if (maxBytes !== undefined && bytes + lineBytes > maxBytes) {
                            truncated = true;
                            break;
                        }
                        collected.push(line);
                        bytes += lineBytes;
                        if (collected.length >= headLines) break;
                    }
                } finally {
                    rl.close();
                    stream.destroy();
                    await fh.close();
                }
                const content = Buffer.from(collected.join("\n"));
                if (truncated) {
                    // Total size is unknown without a full stat; report it as a separate read.
                    return (await safeStat(absolute)).map((s): ReadFileResult => ({
                        kind: "truncated",
                        content,
                        totalSize: s?.size ?? content.length,
                    }));
                }
                // Whether the loop exhausted the file or hit the line cap, the agent asked
                // for exactly this window, so this is `ok` not `truncated`. The tool layer
                // reports `mode: "head"` so the agent knows it's a window.
                return ok<ReadFileResult, FsError>({ kind: "ok", content, truncated: false });
            })(),
        );
    });
}

/**
 * Read the last `tailLines` lines via a windowed read from the end. The
 * window size is bounded by `maxBytes` (default cap caller-supplied), so we
 * never page in the whole file. If the window doesn't start at offset 0, the
 * first line in the window is partial and is dropped.
 *
 * The discrete `fs.open` / `fh.read` calls are wrapped in `tryFs`; the buffer
 * slicing is pure and runs inside the same `fn`.
 */
function readTailLines(absolute: string, totalSize: number, tailLines: number, maxBytes: number | undefined): ResultAsync<ReadFileResult, FsError> {
    return openReadNoFollow(absolute).andThen((opened): ResultAsync<ReadFileResult, FsError> => {
        if (opened.kind === "out_of_scope") return okAsync<ReadFileResult>({ kind: "out_of_scope" });
        const fh = opened.fh;
        return tryFs<ReadFileResult>(
            "workspace.readTail",
            async () => {
                try {
                    const windowSize = Math.min(totalSize, maxBytes ?? totalSize);
                    const offset = totalSize - windowSize;
                    const buf = Buffer.alloc(windowSize);
                    if (windowSize > 0) {
                        await fh.read(buf, 0, windowSize, offset);
                    }
                    const allLines = buf.toString("utf8").split(/\r?\n/);
                    // Drop the partial leading line if the window doesn't cover the file start.
                    const candidateLines = offset > 0 ? allLines.slice(1) : allLines;
                    const sliced = candidateLines.length > tailLines ? candidateLines.slice(-tailLines) : candidateLines;
                    const content = Buffer.from(sliced.join("\n"));

                    const gotEnoughLines = sliced.length >= tailLines || offset === 0;
                    if (!gotEnoughLines) {
                        return { kind: "truncated", content, totalSize };
                    }
                    return { kind: "ok", content, truncated: false };
                } finally {
                    await fh.close();
                }
            },
            { path: absolute },
        );
    });
}

function sliceHeadLines(content: Buffer, headLines: number, maxBytes: number | undefined): ReadFileResult {
    const capped = maxBytes !== undefined && content.length > maxBytes ? content.subarray(0, maxBytes) : content;
    const lines = capped.toString("utf8").split(/\r?\n/);
    const slice = lines.slice(0, headLines);
    const out = Buffer.from(slice.join("\n"));
    if (maxBytes !== undefined && content.length > maxBytes && slice.length < headLines) {
        return { kind: "truncated", content: out, totalSize: content.length };
    }
    return { kind: "ok", content: out, truncated: false };
}

function sliceTailLines(content: Buffer, tailLines: number, maxBytes: number | undefined): ReadFileResult {
    if (maxBytes === undefined || content.length <= maxBytes) {
        const lines = content.toString("utf8").split(/\r?\n/);
        const slice = lines.length > tailLines ? lines.slice(-tailLines) : lines;
        return { kind: "ok", content: Buffer.from(slice.join("\n")), truncated: false };
    }
    const window = content.subarray(content.length - maxBytes);
    const lines = window.toString("utf8").split(/\r?\n/).slice(1);
    const slice = lines.length > tailLines ? lines.slice(-tailLines) : lines;
    const out = Buffer.from(slice.join("\n"));
    if (slice.length < tailLines) {
        return { kind: "truncated", content: out, totalSize: content.length };
    }
    return { kind: "ok", content: out, truncated: false };
}
