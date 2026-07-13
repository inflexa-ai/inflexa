/**
 * `write_file` — sandbox-gated workspace write, confined to the agent's
 * writable working directory.
 *
 * A thin adapter over the `WorkspaceMutator` seam (see the harness-durable-runtime / harness-workspace-tools specs): the
 * mutator owns resolve + confine + sandbox write + provenance. This tool only
 * declares the input schema and forwards. `edit_file` rides the same seam.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import type { WorkspaceMutator } from "./mutator.js";

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
        // Body-only `awaitExec`-recv → runs unwrapped in the workflow body (see the harness-tools spec).
        executionMode: "workflow",
        description:
            "Write a UTF-8 text file in your working directory. Relative paths " +
            "resolve against it; a path outside it returns an `out_of_prefix` data " +
            "variant (no I/O), and one escaping the analysis tree returns " +
            "`out_of_scope`.",
        inputSchema: WriteFileInputSchema,
        execute: async ({ path, content }, ctx) => ok(await deps.mutator.writeFile({ path, content, toolName: "write_file", emit: ctx.emit })),
    });
}
