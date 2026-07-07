/**
 * The workspace read seam — `{ readFile, list, stat }` over the analysis
 * session tree. A construction-time dependency (see the harness-durable-runtime spec): the composition
 * root builds one `WorkspaceFilesystem` and passes it to tool factories.
 *
 * Reads resolve from the host session directory when the file is present and
 * fall back to an embedder-supplied presigned URL otherwise. The seam writes no
 * provenance — reads don't produce lineage — and does not depend on any
 * sandbox.
 *
 * Scoping is enforced once, here, by `resolveWorkspacePath`: any path that
 * escapes `${sessionsBasePath}/${analysisId}/` is rejected before any I/O.
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

import { open as fsOpen, readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { ResultAsync, ok } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import { scopeResource } from "../auth/types.js";
import { type FsError, tryFetch, tryFs } from "../lib/fs-result.js";
import { resolveWorkspacePath } from "./paths.js";

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
    /** Absolute path to the host directory containing per-analysis subtrees. */
    readonly sessionsBasePath: string;
    /** Optional fallback for files not present locally. */
    readonly presignedFallback?: PresignedFallback;
}

// ── Constructor ───────────────────────────────────────────────────────────

export function createWorkspaceFilesystem(deps: WorkspaceFilesystemDeps): WorkspaceFilesystem {
    const { sessionsBasePath, presignedFallback } = deps;

    function resolveFor(session: AgentSession, path: string, workingDir?: string) {
        const { resourceId: analysisId } = scopeResource(session.scope);
        return resolveWorkspacePath({ sessionsBasePath, analysisId, path, workingDir });
    }

    return {
        readFile({ session, path, maxBytes, headLines, tailLines, workingDir }) {
            const resolved = resolveFor(session, path, workingDir);
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
        },

        list({ session, path, workingDir }) {
            const resolved = resolveFor(session, path, workingDir);
            if (resolved.kind === "out_of_scope") {
                return okAsync<ListResult>({ kind: "out_of_scope" });
            }
            const absolute = resolved.absolute;

            return tryFs<readonly { name: string; isDirectory(): boolean }[] | { notFound: true }>(
                "workspace.list",
                () => fsReaddir(absolute, { withFileTypes: true }),
                { path: absolute, onAbsent: () => ({ notFound: true }) },
            ).andThen((dirents): ResultAsync<ListResult, FsError> => {
                if ("notFound" in dirents) return okAsync<ListResult>({ kind: "not_found" });
                return collectEntries(absolute, dirents).map((entries): ListResult => ({ kind: "ok", entries }));
            });
        },

        stat({ session, path, workingDir }) {
            const resolved = resolveFor(session, path, workingDir);
            if (resolved.kind === "out_of_scope") {
                return okAsync<StatResult>({ kind: "out_of_scope" });
            }

            return safeStat(resolved.absolute).map((s): StatResult => {
                if (!s) return { kind: "not_found" };
                return {
                    kind: "ok",
                    type: s.isDirectory() ? "directory" : "file",
                    size: s.size,
                };
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

/** Stat each directory entry to attach a size; absence/I/O failures degrade to no size. */
function collectEntries(dir: string, dirents: readonly { name: string; isDirectory(): boolean }[]): ResultAsync<ListEntry[], FsError> {
    return ResultAsync.combine(
        dirents.map((d): ResultAsync<ListEntry, FsError> => {
            if (d.isDirectory()) return okAsync<ListEntry>({ name: d.name, type: "directory" });
            return safeStat(join(dir, d.name)).map((s): ListEntry => ({ name: d.name, type: "file", size: s?.size ?? undefined }));
        }),
    );
}

function readWithCap(absolute: string, totalSize: number, maxBytes: number | undefined): ResultAsync<ReadFileResult, FsError> {
    if (maxBytes !== undefined && totalSize > maxBytes) {
        return tryFs<ReadFileResult>(
            "workspace.readCapped",
            async () => {
                const fh = await fsOpen(absolute, "r");
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
    return tryFs<ReadFileResult>("workspace.readFile", async () => ({ kind: "ok", content: await fsReadFile(absolute), truncated: false }), { path: absolute });
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
    return new ResultAsync(
        (async () => {
            const stream = createReadStream(absolute, { highWaterMark: 16 * 1024 });
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
    return tryFs<ReadFileResult>(
        "workspace.readTail",
        async () => {
            const windowSize = Math.min(totalSize, maxBytes ?? totalSize);
            const offset = totalSize - windowSize;
            const fh = await fsOpen(absolute, "r");
            try {
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
