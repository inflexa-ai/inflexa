/**
 * `file_stat` tool — type + size of a workspace path over the read seam.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures the `WorkspaceFilesystem`
 * and the optional working directory relative paths resolve against (see the harness-workspace-tools spec).
 * Expected outcomes are data variants — `not_found` / `out_of_scope`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";

type FileStatOutput =
    { status: "ok"; path: string; type: "file" | "directory"; size: number } | { status: "not_found"; path: string } | { status: "out_of_scope"; path: string };

const FileStatInputSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe("Path to stat. Relative paths resolve against your working directory; " + "an absolute '/<analysisId>/...' path against the analysis root."),
});

export function createFileStatTool(fs: WorkspaceFilesystem, workingDir?: string) {
    return defineTool({
        id: "file_stat",
        description:
            "Stat a workspace path: whether it is a file or directory and its size " +
            "in bytes. Use before reading to size a file. Missing and out-of-scope " +
            "paths return a data variant, not an error.",
        inputSchema: FileStatInputSchema,
        execute: async ({ path }, ctx): Promise<Result<FileStatOutput, ToolError>> => {
            const result = unwrapOrThrow(await fs.stat({ session: ctx.session, path, workingDir }));
            switch (result.kind) {
                case "ok":
                    return ok({ status: "ok" as const, path, type: result.type, size: result.size });
                case "not_found":
                    return ok({ status: "not_found" as const, path });
                case "out_of_scope":
                    return ok({ status: "out_of_scope" as const, path });
            }
        },
    });
}
