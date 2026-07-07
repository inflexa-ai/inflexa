/**
 * `list_files` tool — directory listing over the workspace read seam.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures the `WorkspaceFilesystem`
 * and the optional working directory relative paths resolve against (see the harness-workspace-tools spec).
 * Expected outcomes are data variants — a missing path is `not_found`, a path
 * escaping the analysis tree is `out_of_scope`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { ListEntry, WorkspaceFilesystem } from "../../workspace/filesystem.js";

type ListFilesOutput =
    { status: "ok"; path: string; entries: readonly ListEntry[] } | { status: "not_found"; path: string } | { status: "out_of_scope"; path: string };

const ListFilesInputSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Directory path. Relative paths resolve against your working directory; " + "an absolute '/<analysisId>/...' path against the analysis root.",
        ),
});

export function createListFilesTool(fs: WorkspaceFilesystem, workingDir?: string) {
    return defineTool({
        id: "list_files",
        description:
            "List the entries (files and directories, with file sizes) in a " +
            "workspace directory. Faster than `ls` via execute_command. Missing " +
            "and out-of-scope paths return a data variant, not an error.",
        inputSchema: ListFilesInputSchema,
        execute: async ({ path }, ctx): Promise<Result<ListFilesOutput, ToolError>> => {
            const result = unwrapOrThrow(await fs.list({ session: ctx.session, path, workingDir }));
            switch (result.kind) {
                case "ok":
                    return ok({ status: "ok" as const, path, entries: result.entries });
                case "not_found":
                    return ok({ status: "not_found" as const, path });
                case "out_of_scope":
                    return ok({ status: "out_of_scope" as const, path });
            }
        },
    });
}
