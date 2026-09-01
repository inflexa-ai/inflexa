/**
 * `edit_file` — workspace edit, confined to the agent's writable working
 * directory. Composes the read seam (fetch current content) with a
 * search/replace and the `WorkspaceMutator` seam (write the result) — same
 * resolution + confinement contract as `write_file`, no path logic of its own
 * (see the harness-workspace-tools spec).
 *
 * Edit semantics: replace `old_string` with `new_string`. `old_string` MUST
 * occur in the file; when `replace_all` is false (default) it MUST occur
 * exactly once. With `regex=true`, `old_string` is a JS RegExp pattern
 * (compiled with the `gm` flags — multiline anchors), `new_string` may use
 * capture-group references, and exactly one of `replace_all=true` or
 * `expected_matches` gates the write. Provenance hashes the post-edit
 * content — recorded by the mutator.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { WorkspaceMutator, WriteFileResult } from "./mutator.js";

/** Outcome of an `edit_file` call — expected outcomes are data variants, never throws. */
export type EditFileResult =
    | { readonly status: "file_not_found"; readonly path: string }
    | { readonly status: "not_found"; readonly path: string }
    | { readonly status: "not_unique"; readonly path: string; readonly occurrences: number }
    | { readonly status: "invalid_pattern"; readonly path: string; readonly pattern: string; readonly error: string }
    | { readonly status: "invalid_arguments"; readonly path: string; readonly reason: string }
    | {
          readonly status: "match_count_mismatch";
          readonly path: string;
          readonly expected: number;
          readonly actual: number;
          readonly lines: readonly number[];
      }
    | Exclude<WriteFileResult, { status: "ok" }>
    | {
          readonly status: "ok";
          readonly path: string;
          readonly replacements: number;
          readonly bytesWritten: number;
          /** Regex mode only: 1-based line numbers where the matches started. */
          readonly lines?: readonly number[];
      };

const EditFileInputSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "File path (relative to your working directory, or absolute " + "'/<analysisId>/...'). Read the file first to get the exact text to replace.",
        ),
    old_string: z
        .string()
        .min(1)
        .describe(
            "The exact text to find and replace — or, when regex=true, a " +
                "JavaScript regular expression pattern. In exact mode with " +
                "replace_all=false (default), it must occur exactly once — include " +
                "enough surrounding context to make it unique.",
        ),
    new_string: z.string().describe("The replacement text. When regex=true it may use capture-group references such as $1."),
    replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "If true, replace every occurrence. If false (default), old_string " + "must occur exactly once or the edit returns a `not_unique` data variant.",
        ),
    regex: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "If true, old_string is a JavaScript regular expression compiled with " +
                "the `gm` flags (^ and $ match line boundaries). Requires exactly one " +
                "of replace_all=true or expected_matches.",
        ),
    expected_matches: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            "Regex mode only: the exact number of matches you expect. On a " +
                "mismatch the edit writes nothing and returns the actual count with " +
                "the matching line numbers.",
        ),
});

export interface EditFileDeps {
    readonly mutator: WorkspaceMutator;
    /** Read seam used to fetch current file content for search/replace. */
    readonly workspaceFilesystem: WorkspaceFilesystem;
    /**
     * Absolute host working directory — relative read paths resolve here. Omit
     * for the conversation agent: the read seam then defaults to the analysis
     * root, matching the session-scoped mutator's write prefix.
     */
    readonly workingDir?: string;
}

function replaceString(
    content: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
): { kind: "ok"; content: string; replacements: number; lines?: number[] } | { kind: "not_found" } | { kind: "not_unique"; count: number } {
    if (!content.includes(oldString)) return { kind: "not_found" };
    if (replaceAll) {
        const parts = content.split(oldString);
        return { kind: "ok", content: parts.join(newString), replacements: parts.length - 1 };
    }
    const first = content.indexOf(oldString);
    const last = content.lastIndexOf(oldString);
    if (first !== last) {
        let count = 0;
        let idx = -1;
        while ((idx = content.indexOf(oldString, idx + 1)) !== -1) count++;
        return { kind: "not_unique", count };
    }
    return {
        kind: "ok",
        content: content.slice(0, first) + newString + content.slice(first + oldString.length),
        replacements: 1,
    };
}

/** 1-based line numbers of the given start offsets (ascending), deduplicated. */
function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
    const lines: number[] = [];
    let line = 1;
    let cursor = 0;
    for (const offset of offsets) {
        for (; cursor < offset; cursor++) {
            if (content.charCodeAt(cursor) === 10) line++;
        }
        if (lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines;
}

function replaceRegex(
    content: string,
    pattern: string,
    replacement: string,
    expected: number | undefined,
):
    | { kind: "ok"; content: string; replacements: number; lines: number[] }
    | { kind: "not_found" }
    | { kind: "invalid_pattern"; error: string }
    | { kind: "count_mismatch"; expected: number; actual: number; lines: number[] } {
    let compiled: RegExp;
    try {
        compiled = new RegExp(pattern, "gm");
    } catch (err) {
        return { kind: "invalid_pattern", error: err instanceof Error ? err.message : String(err) };
    }
    const matches = [...content.matchAll(compiled)];
    if (matches.length === 0) return { kind: "not_found" };
    const lines = lineNumbersAt(
        content,
        matches.map((match) => match.index),
    );
    if (expected !== undefined && matches.length !== expected) {
        return { kind: "count_mismatch", expected, actual: matches.length, lines };
    }
    return { kind: "ok", content: content.replace(compiled, replacement), replacements: matches.length, lines };
}

export function createEditFileTool(deps: EditFileDeps) {
    return defineTool({
        id: "edit_file",
        // The mutator wraps the disk mutation in `ctx.runStep` itself, so the
        // body runs unwrapped in the workflow body (see the harness-tools spec).
        executionMode: "workflow",
        description:
            "Edit a file in your working directory by replacing specific text. " +
            "Read the file first to get the exact text. When replace_all is false " +
            "(default), old_string must occur exactly once. For a bulk pattern " +
            "edit set regex=true: old_string is a JS regex, new_string may use $1 " +
            "references, and exactly one of replace_all=true or expected_matches " +
            "gates the write. Returns `out_of_prefix` / `out_of_scope` / " +
            "`file_not_found` / `not_found` / `not_unique` / `match_count_mismatch` " +
            "data variants — never throws on expected outcomes.",
        inputSchema: EditFileInputSchema,
        // The path only. The replaced text is file content, not a description.
        describeCall: ({ path }) => path,
        execute: async ({ path, old_string, new_string, replace_all, regex, expected_matches }, ctx): Promise<Result<EditFileResult, ToolError>> => {
            const replaceAll = replace_all === true;
            const useRegex = regex === true;
            if (!useRegex && expected_matches !== undefined) {
                return ok({ status: "invalid_arguments" as const, path, reason: "expected_matches requires regex=true." });
            }
            if (useRegex && (expected_matches !== undefined) === replaceAll) {
                return ok({
                    status: "invalid_arguments" as const,
                    path,
                    reason: "regex=true requires exactly one of replace_all=true or expected_matches.",
                });
            }

            const read = unwrapOrThrow(
                await deps.workspaceFilesystem.readFile({
                    session: ctx.session,
                    path,
                    ...(deps.workingDir !== undefined ? { workingDir: deps.workingDir } : {}),
                }),
            );
            if (read.kind === "not_found") return ok({ status: "file_not_found" as const, path });
            if (read.kind === "out_of_scope") return ok({ status: "out_of_scope" as const, path });

            const content = read.content.toString("utf8");
            const replaced = useRegex
                ? replaceRegex(content, old_string, new_string, expected_matches)
                : replaceString(content, old_string, new_string, replaceAll);
            if (replaced.kind === "not_found") return ok({ status: "not_found" as const, path });
            if (replaced.kind === "not_unique") {
                return ok({ status: "not_unique" as const, path, occurrences: replaced.count });
            }
            if (replaced.kind === "invalid_pattern") {
                return ok({ status: "invalid_pattern" as const, path, pattern: old_string, error: replaced.error });
            }
            if (replaced.kind === "count_mismatch") {
                return ok({
                    status: "match_count_mismatch" as const,
                    path,
                    expected: replaced.expected,
                    actual: replaced.actual,
                    lines: replaced.lines,
                });
            }

            const result = await deps.mutator.writeFile({
                path,
                content: replaced.content,
                toolName: "edit_file",
                runStep: ctx.runStep,
                session: ctx.session,
            });
            if (result.status !== "ok") return ok(result);
            const lines: readonly number[] | undefined = replaced.lines;
            return ok({
                status: "ok" as const,
                path: result.path,
                replacements: replaced.replacements,
                bytesWritten: result.bytesWritten,
                ...(lines === undefined ? {} : { lines }),
            });
        },
    });
}
