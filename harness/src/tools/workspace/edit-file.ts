/**
 * `edit_file` — sandbox-gated workspace edit, confined to the agent's writable
 * working directory. Composes the read seam (fetch current content) with a
 * search/replace and the `WorkspaceMutator` seam (write the result) — same
 * resolution + confinement contract as `write_file`, no path logic of its own
 * (see the harness-workspace-tools spec).
 *
 * Edit semantics: replace `old_string` with `new_string`. `old_string` MUST
 * occur in the file; when `replace_all` is false (default) it MUST occur
 * exactly once. Provenance hashes the post-edit content — recorded by the
 * mutator.
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
    | Exclude<WriteFileResult, { status: "ok" }>
    | {
          readonly status: "ok";
          readonly path: string;
          readonly replacements: number;
          readonly bytesWritten: number;
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
            "The exact text to find and replace. Must occur in the file. When " +
                "replace_all=false (default), must occur exactly once — include " +
                "enough surrounding context to make it unique.",
        ),
    new_string: z.string().describe("The replacement text."),
    replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "If true, replace every occurrence. If false (default), old_string " + "must occur exactly once or the edit returns a `not_unique` data variant.",
        ),
});

export interface EditFileDeps {
    readonly mutator: WorkspaceMutator;
    /** Read seam used to fetch current file content for search/replace. */
    readonly workspaceFilesystem: WorkspaceFilesystem;
    /** Absolute host working directory — relative read/write paths resolve here. */
    readonly workingDir: string;
}

function replaceString(
    content: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
): { kind: "ok"; content: string; replacements: number } | { kind: "not_found" } | { kind: "not_unique"; count: number } {
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

export function createEditFileTool(deps: EditFileDeps) {
    return defineTool({
        id: "edit_file",
        // Body-only `awaitExec`-recv → runs unwrapped in the workflow body (see the harness-tools spec).
        executionMode: "workflow",
        description:
            "Edit a file in your working directory by replacing specific text. " +
            "Read the file first to get the exact text. When replace_all is false " +
            "(default), old_string must occur exactly once. Returns `out_of_prefix` " +
            "/ `out_of_scope` / `file_not_found` / `not_found` / `not_unique` data " +
            "variants — never throws on expected outcomes.",
        inputSchema: EditFileInputSchema,
        execute: async ({ path, old_string, new_string, replace_all }, ctx): Promise<Result<EditFileResult, ToolError>> => {
            const read = unwrapOrThrow(
                await deps.workspaceFilesystem.readFile({
                    session: ctx.session,
                    path,
                    workingDir: deps.workingDir,
                }),
            );
            if (read.kind === "not_found") return ok({ status: "file_not_found" as const, path });
            if (read.kind === "out_of_scope") return ok({ status: "out_of_scope" as const, path });

            const replaced = replaceString(read.content.toString("utf8"), old_string, new_string, replace_all);
            if (replaced.kind === "not_found") return ok({ status: "not_found" as const, path });
            if (replaced.kind === "not_unique") {
                return ok({ status: "not_unique" as const, path, occurrences: replaced.count });
            }

            const result = await deps.mutator.writeFile({
                path,
                content: replaced.content,
                toolName: "edit_file",
                emit: ctx.emit,
            });
            if (result.status !== "ok") return ok(result);
            return ok({
                status: "ok" as const,
                path: result.path,
                replacements: replaced.replacements,
                bytesWritten: result.bytesWritten,
            });
        },
    });
}
