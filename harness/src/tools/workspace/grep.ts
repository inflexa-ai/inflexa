/**
 * grep tool — pattern search over the workspace read seam.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures the `WorkspaceFilesystem`.
 * JS implementation over `list` + `readFile` — no ripgrep binary required.
 * Expected outcomes are data variants: no matches → `no_matches`; over-cap →
 * `truncated` with a marker; missing path → `not_found`; escape attempt →
 * `out_of_scope`. Only unexpected I/O failures throw.
 */

import { posix as posixPath } from "node:path";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { ListEntry, ReadFileResult, WorkspaceFilesystem } from "../../workspace/filesystem.js";

const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_MATCH_BYTES = 512;
/** Files larger than this aren't grepped — keeps a stray binary blob from blocking the seam. */
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_DIR_DEPTH = 8;

const GrepInputSchema = z.object({
    pattern: z
        .string()
        .min(1)
        .describe(
            "JavaScript regular expression, tested against each line separately. It matches anywhere in the line " +
                "unless you add `^` or `$`; case-sensitive unless `ignoreCase` is true.",
        ),
    path: z
        .string()
        .min(1)
        .describe("Workspace path to a file or directory. Directories are searched " + "recursively up to a bounded depth."),
    ignoreCase: z.boolean().optional().describe("Case-insensitive match. Defaults to false."),
});

interface Match {
    readonly file: string;
    readonly line: number;
    readonly preview: string;
}

type GrepOutput =
    | { status: "invalid_pattern"; pattern: string; error: string }
    | { status: "out_of_scope"; path: string }
    | { status: "not_found"; path: string }
    | { status: "no_matches"; path: string; pattern: string }
    | {
          status: "truncated";
          path: string;
          pattern: string;
          matches: Match[];
          cap: { maxMatches: number; maxBytesPerLine: number };
      }
    | { status: "ok"; path: string; pattern: string; matches: Match[] };

export function createGrepTool(fs: WorkspaceFilesystem, workingDir?: string) {
    return defineTool({
        id: "grep",
        description:
            "Regex search over the text files of the workspace (input data, prior runs, step " +
            "outputs, summaries, syntheses). Pass a file or a " +
            `directory path; directories are walked recursively, to a depth of ${MAX_DIR_DEPTH}. Results are ` +
            `capped at ${DEFAULT_MAX_MATCHES} matches, and each preview at ${DEFAULT_MAX_MATCH_BYTES} characters of its line. ` +
            `Only the first ${MAX_GREP_FILE_BYTES / (1024 * 1024)} MiB of each file is searched, and a file with a NUL byte ` +
            "in its first KiB is skipped as binary. A `truncated` status means the match cap or the file cap cut the search; " +
            "narrow your path or pattern. No matches, missing paths, and out-of-scope paths return data variants, not errors.",
        inputSchema: GrepInputSchema,
        // Both fields, because either alone loses the call: the same pattern over
        // two trees and two patterns over one tree are both ordinary sequences.
        describeCall: ({ pattern, path }) => `${pattern} in ${path}`,
        execute: async ({ pattern, path, ignoreCase }, ctx): Promise<Result<GrepOutput, ToolError>> => {
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, ignoreCase === true ? "i" : "");
            } catch (err) {
                return ok({
                    status: "invalid_pattern" as const,
                    pattern,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            const statResult = unwrapOrThrow(await fs.stat({ session: ctx.session, path, workingDir }));
            if (statResult.kind === "out_of_scope") {
                return ok({ status: "out_of_scope" as const, path });
            }
            if (statResult.kind === "not_found") {
                return ok({ status: "not_found" as const, path });
            }

            const matches: Match[] = [];
            let truncated = false;
            const session = ctx.session;

            async function searchFile(filePath: string): Promise<void> {
                if (matches.length >= DEFAULT_MAX_MATCHES) {
                    truncated = true;
                    return;
                }
                const read: ReadFileResult = unwrapOrThrow(
                    await fs.readFile({
                        session,
                        path: filePath,
                        maxBytes: MAX_GREP_FILE_BYTES,
                        workingDir,
                    }),
                );
                if (read.kind === "not_found" || read.kind === "out_of_scope") return;
                const buf = read.content;
                if (looksBinary(buf)) return;
                const text = buf.toString("utf8");
                if (read.kind === "truncated") truncated = true;

                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (matches.length >= DEFAULT_MAX_MATCHES) {
                        truncated = true;
                        return;
                    }
                    const line = lines[i]!;
                    if (regex.test(line)) {
                        matches.push({
                            file: filePath,
                            line: i + 1,
                            preview: line.length > DEFAULT_MAX_MATCH_BYTES ? line.slice(0, DEFAULT_MAX_MATCH_BYTES) : line,
                        });
                    }
                }
            }

            async function walk(dirPath: string, depth: number): Promise<void> {
                if (depth > MAX_DIR_DEPTH) return;
                if (matches.length >= DEFAULT_MAX_MATCHES) {
                    truncated = true;
                    return;
                }
                const list = unwrapOrThrow(await fs.list({ session, path: dirPath, workingDir }));
                if (list.kind !== "ok") return;
                for (const entry of list.entries) {
                    if (matches.length >= DEFAULT_MAX_MATCHES) {
                        truncated = true;
                        return;
                    }
                    const child = posixPath.join(dirPath, entry.name);
                    if (entry.type === "directory") {
                        await walk(child, depth + 1);
                    } else {
                        await searchFile(child);
                    }
                }
            }

            if (statResult.type === "file") {
                await searchFile(path);
            } else {
                await walk(path, 0);
            }

            if (matches.length === 0) {
                return ok({ status: "no_matches" as const, path, pattern });
            }
            if (truncated) {
                return ok({
                    status: "truncated" as const,
                    path,
                    pattern,
                    matches,
                    cap: { maxMatches: DEFAULT_MAX_MATCHES, maxBytesPerLine: DEFAULT_MAX_MATCH_BYTES },
                });
            }
            return ok({ status: "ok" as const, path, pattern, matches });
        },
    });
}

/** Quick binary heuristic — skip files with NULs in the first kibibyte. */
function looksBinary(buf: Buffer): boolean {
    const probe = buf.subarray(0, Math.min(buf.length, 1024));
    return probe.includes(0);
}

/** Exposed for tests — the caps `grep` enforces. */
export const GREP_LIMITS = {
    DEFAULT_MAX_MATCHES,
    DEFAULT_MAX_MATCH_BYTES,
    MAX_GREP_FILE_BYTES,
} as const;

export type GrepListEntry = ListEntry;
