/**
 * `write_file` — workspace write, confined to the agent's writable working
 * directory.
 *
 * A thin adapter over the `WorkspaceMutator` seam (see the harness-durable-runtime / harness-workspace-tools specs): the
 * mutator owns resolve + confine + hardened host write + provenance. This tool
 * declares the input schema, forwards the write, and carries the record of the
 * write to the fold. `edit_file` rides the same seam.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, withToolCallRecord, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import type { WorkspaceMutator, WriteFileResult, WriteRecord } from "./mutator.js";

/** The result of a `write_file` call: a success carries the record of the write for the fold. */
type WriteFileToolResult = Exclude<WriteFileResult, { status: "ok" }> | WithToolCallRecord<Extract<WriteFileResult, { status: "ok" }>, WriteRecord>;

const WriteFileInputSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "File path. Relative paths resolve against your working directory " +
                "(e.g. 'output/result.csv', 'scripts/run.py'); an absolute " +
                "'/<analysisId>/...' path is resolved against the analysis root.",
        ),
    content: z.string().describe("UTF-8 file content."),
});

export interface WriteFileDeps {
    readonly mutator: WorkspaceMutator;
}

export function createWriteFileTool(deps: WriteFileDeps) {
    return defineTool({
        id: "write_file",
        description:
            "Write a UTF-8 text file in your working directory. Relative paths " +
            "resolve against it. The write replaces an existing file whole, and it makes " +
            "missing parent directories. On success it returns `status: ok`, the absolute " +
            "'/<analysisId>/...' path, and `bytesWritten`. A path outside the working directory " +
            "returns an `out_of_prefix` data variant (no I/O), one escaping the analysis tree returns " +
            "`out_of_scope`, and a symbolic link on the path returns `symlink_denied`.",
        inputSchema: WriteFileInputSchema,
        // The path only. `content` is a whole file and must never ride a display
        // channel, which the emit-site length cap enforces regardless.
        describeCall: ({ path }) => path,
        execute: async ({ path, content }, ctx): Promise<Result<WriteFileToolResult, ToolError>> => {
            const write = await deps.mutator.writeFile({
                path,
                content,
                toolName: "write_file",
                invocationId: ctx.invocationId,
                session: ctx.session,
            });
            if (write.status !== "ok") return ok(write);
            const { record, ...result } = write;
            return ok(withToolCallRecord(result, record));
        },
        foldCallRecord: (record) => deps.mutator.recordWrite(record),
    });
}
