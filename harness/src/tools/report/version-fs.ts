/**
 * In-process workspace surface for the report-builder agent.
 *
 * Tight read/write/mkdir surface scoped to the version directory.
 * Agent-supplied paths are relative to `versionDir`; an absolute path, or one
 * that escapes the directory, is rejected as `out_of_scope`. Constructed
 * inside the iterate-report runner so it always shares the same `versionDir`
 * as the rest of the report tools.
 */

import { mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";

type WriteFileOutput = { status: "out_of_scope"; reason: string } | { status: "too_large"; reason: string } | { status: "ok"; bytesWritten: number };

type EditFileOutput =
    | { status: "out_of_scope"; reason: string }
    | { status: "not_found" }
    | { status: "no_match" }
    | { status: "too_large"; reason: string }
    | { status: "ok"; bytesWritten: number };

type ReadFileOutput =
    { status: "out_of_scope"; reason: string } | { status: "not_found" } | { status: "ok"; content: string; truncated: boolean; totalBytes: number };

type MkdirOutput = { status: "out_of_scope"; reason: string } | { status: "ok" };

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1 * 1024 * 1024;

export interface VersionFsToolsState {
    /** Absolute path to the version directory. All paths resolve under this. */
    readonly versionDir: string;
}

/** Resolve an agent-supplied path against `versionDir`, rejecting escapes. */
function resolveAgentPath(agentPath: string, versionDir: string): { kind: "ok"; absolute: string } | { kind: "out_of_scope"; reason: string } {
    if (agentPath.length === 0 || agentPath.includes("\0")) {
        return { kind: "out_of_scope", reason: "empty or null-byte path" };
    }
    // A leading slash is refused rather than trimmed. Trimming it makes the
    // containment check below unreachable for absolute paths: a deep one such
    // as "/previews/abc/v1/report.html.j2" would land a real file several
    // directories below versionDir and report success, and the builder — which
    // has no directory-listing tool — cannot find where its template went.
    if (agentPath.startsWith("/")) {
        return { kind: "out_of_scope", reason: `absolute path rejected, use one relative to the version dir: ${agentPath}` };
    }
    const absolute = resolvePath(versionDir, agentPath);
    if (absolute !== versionDir && !absolute.startsWith(versionDir + sep)) {
        return { kind: "out_of_scope", reason: `path escapes version dir: ${agentPath}` };
    }
    return { kind: "ok", absolute };
}

export function createVersionFsTools(state: VersionFsToolsState): Tool[] {
    const writeFile = defineTool({
        id: "write_file",
        description:
            "Write a UTF-8 text file under the report's version directory. Paths " +
            "are relative to it (e.g. `report.html.j2`, `assets/foo.csv`); an " +
            "absolute path, or one that escapes the version dir, returns " +
            "`out_of_scope` and writes nothing.",
        inputSchema: z.object({
            path: z.string().min(1),
            content: z.string(),
        }),
        execute: async ({ path, content }): Promise<Result<WriteFileOutput, ToolError>> => {
            const resolved = resolveAgentPath(path, state.versionDir);
            if (resolved.kind === "out_of_scope") {
                return ok({ status: "out_of_scope" as const, reason: resolved.reason });
            }
            const bytes = Buffer.byteLength(content, "utf8");
            if (bytes > MAX_WRITE_BYTES) {
                return ok({
                    status: "too_large" as const,
                    reason: `write rejected: ${bytes} bytes exceeds ${MAX_WRITE_BYTES} cap`,
                });
            }
            await fsMkdir(dirname(resolved.absolute), { recursive: true });
            await fsWriteFile(resolved.absolute, content, "utf8");
            return ok({ status: "ok" as const, bytesWritten: bytes });
        },
    });

    const editFile = defineTool({
        id: "edit_file",
        description:
            "Surgical edit of an existing UTF-8 file inside the report's version " +
            "directory: replace the first occurrence of `oldText` with `newText`. " +
            "Paths are relative to that directory; an absolute or escaping path " +
            "returns `out_of_scope`. Returns `not_found` if the file doesn't " +
            "exist, `no_match` if `oldText` isn't present.",
        inputSchema: z.object({
            path: z.string().min(1),
            oldText: z.string().min(1),
            newText: z.string(),
        }),
        execute: async ({ path, oldText, newText }): Promise<Result<EditFileOutput, ToolError>> => {
            const resolved = resolveAgentPath(path, state.versionDir);
            if (resolved.kind === "out_of_scope") {
                return ok({ status: "out_of_scope" as const, reason: resolved.reason });
            }
            let content: string;
            try {
                content = await fsReadFile(resolved.absolute, "utf8");
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                    return ok({ status: "not_found" as const });
                }
                throw err;
            }
            const idx = content.indexOf(oldText);
            if (idx === -1) {
                return ok({ status: "no_match" as const });
            }
            const next = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
            const bytes = Buffer.byteLength(next, "utf8");
            if (bytes > MAX_WRITE_BYTES) {
                return ok({
                    status: "too_large" as const,
                    reason: `post-edit size ${bytes} bytes exceeds ${MAX_WRITE_BYTES} cap`,
                });
            }
            await fsWriteFile(resolved.absolute, next, "utf8");
            return ok({ status: "ok" as const, bytesWritten: bytes });
        },
    });

    const readFile = defineTool({
        id: "read_file",
        description:
            "Read a UTF-8 file inside the report's version directory. Paths are " +
            "relative to it; an absolute or escaping path returns `out_of_scope`. " +
            "Returns truncated content (capped at 256 KiB) for large files.",
        inputSchema: z.object({
            path: z.string().min(1),
        }),
        execute: async ({ path }): Promise<Result<ReadFileOutput, ToolError>> => {
            const resolved = resolveAgentPath(path, state.versionDir);
            if (resolved.kind === "out_of_scope") {
                return ok({ status: "out_of_scope" as const, reason: resolved.reason });
            }
            let st;
            try {
                st = await fsStat(resolved.absolute);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                    return ok({ status: "not_found" as const });
                }
                throw err;
            }
            if (!st.isFile()) {
                return ok({ status: "not_found" as const });
            }
            const buf = await fsReadFile(resolved.absolute);
            const truncated = buf.length > MAX_READ_BYTES;
            const sliced = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
            return ok({
                status: "ok" as const,
                content: sliced.toString("utf8"),
                truncated,
                totalBytes: st.size,
            });
        },
    });

    const mkdir = defineTool({
        id: "mkdir",
        description:
            "Create a directory (recursive) inside the report's version directory. " +
            "Paths are relative to it; an absolute or escaping path returns `out_of_scope`.",
        inputSchema: z.object({
            path: z.string().min(1),
        }),
        execute: async ({ path }): Promise<Result<MkdirOutput, ToolError>> => {
            const resolved = resolveAgentPath(path, state.versionDir);
            if (resolved.kind === "out_of_scope") {
                return ok({ status: "out_of_scope" as const, reason: resolved.reason });
            }
            await fsMkdir(resolved.absolute, { recursive: true });
            return ok({ status: "ok" as const });
        },
    });

    return [writeFile, editFile, readFile, mkdir];
}
