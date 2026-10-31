/**
 * read_file tool — reads a workspace file via the workspace read seam.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures the `WorkspaceFilesystem`
 * at construction. Expected outcomes are data variants — a missing path is
 * `not_found`, a path that escapes the analysis tree is `out_of_scope`, an
 * oversize read is `truncated`. Only unexpected I/O errors throw; the loop
 * wraps them as `is_error`.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { WorkspaceReadLineage, WorkspaceReadRecord } from "../../provenance/workspace-reads.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";

/** Default cap — large enough for typical CSV/MD/JSON, small enough to keep tool results out of context-blowing territory. */
const DEFAULT_MAX_BYTES = 256 * 1024;

type ReadFileOutput =
    | { status: "invalid_input"; path: string; reason: string }
    | { status: "ok"; path: string; mode: "head" | "tail" | "full"; content: string }
    | {
          status: "truncated";
          path: string;
          mode: "head" | "tail" | "full";
          content: string;
          totalSize: number;
          returnedBytes: number;
      }
    | { status: "not_found"; path: string }
    | { status: "out_of_scope"; path: string }
    // `totalSize` rides only on an oversize binary read, where the real file size
    // is a signal the agent can act on (e.g. reach for `execute_command` instead);
    // a fully-read binary omits it, exactly as the text `ok` variant carries no size.
    | { status: "binary"; path: string; mode: "head" | "tail" | "full"; totalSize?: number };

/**
 * Treat returned content as binary when it contains a NUL byte — `grep`'s
 * `looksBinary` heuristic, applied here to the whole returned window rather than
 * a 1 KiB probe. These exact bytes are what would be UTF-8-decoded into the
 * transcript, and a NUL both renders that decode as lossy garbage (useless to
 * the model) and cannot be persisted into the JSONB message store — Postgres
 * rejects U+0000 with 22P05, failing the whole turn's append. Reporting the
 * read as `binary` keeps a NUL out of both.
 */
function looksBinary(content: Buffer): boolean {
    return content.includes(0);
}

const ReadFileInputSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Workspace path. Relative paths resolve against your working directory; " +
                "an absolute '/<analysisId>/...' path is resolved against the analysis " +
                "root (use absolute to read input data or other steps' outputs).",
        ),
    headLines: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe(
            "Read only the first N lines (head). Use for inspecting CSV/TSV " +
                "headers, step summaries, or the top of any large file. Mutually " +
                "exclusive with tailLines.",
        ),
    tailLines: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe(
            "Read only the last N complete lines (tail). Use for logs and any " + "file where the tail is what matters. Mutually exclusive with headLines.",
        ),
});

type ReadFileToolOutput = ReadFileOutput | WithToolCallRecord<ReadFileOutput, WorkspaceReadRecord>;

/** `lineage` records each read that gave text to the agent in the lineage of a step. */
export function createReadFileTool(
    fs: WorkspaceFilesystem,
    workingDir?: string,
    lineage?: WorkspaceReadLineage,
): Tool<z.infer<typeof ReadFileInputSchema>, ReadFileToolOutput> {
    /** The output, with the read of `path` as its call record when a lineage records it. */
    function withRead(output: ReadFileOutput, path: string, wholeFile: Buffer | null): ReadFileToolOutput {
        const read = lineage?.readOf(path, wholeFile);
        return read === undefined ? output : withToolCallRecord(output, { reads: [read] });
    }

    return defineTool({
        id: "read_file",
        description:
            "Read a workspace file: input data, prior-run outputs, current-run " +
            "outputs, step summaries, or run syntheses. It reads the workspace directly and runs no sandbox command. Returns the file content " +
            "as UTF-8 text. Output is capped at " +
            `${DEFAULT_MAX_BYTES} bytes; pass headLines or tailLines to read a ` +
            "specific window of a large file (typical for bio CSV/TSV/log files). " +
            "An oversize read returns status `truncated` with the bytes that fit (the start of the file, or " +
            "the end for tailLines), `totalSize`, and `returnedBytes`. This tool is for " +
            "text; a binary file (one holding NUL bytes, e.g. a .gz or image) comes " +
            "back as a `binary` data variant rather than decoded garbage. Missing " +
            "paths and paths outside the analysis tree return a data variant — not an error.",
        inputSchema: ReadFileInputSchema,
        view: {
            input: (input) => input,
            error: true,
        },
        describeCall: ({ path, headLines, tailLines }) => {
            if (headLines !== undefined) return `${path} (first ${headLines} lines)`;
            if (tailLines !== undefined) return `${path} (last ${tailLines} lines)`;
            return path;
        },
        foldCallRecord: lineage === undefined ? undefined : (record: WorkspaceReadRecord) => lineage.track(record.reads),
        execute: async ({ path, headLines, tailLines }, ctx): Promise<Result<ReadFileToolOutput, ToolError>> => {
            if (headLines !== undefined && tailLines !== undefined) {
                return ok({
                    status: "invalid_input" as const,
                    path,
                    reason: "headLines and tailLines are mutually exclusive",
                });
            }

            const result = unwrapOrThrow(
                await fs.readFile({
                    session: ctx.session,
                    path,
                    maxBytes: DEFAULT_MAX_BYTES,
                    headLines,
                    tailLines,
                    workingDir,
                }),
            );

            const mode = headLines !== undefined ? ("head" as const) : tailLines !== undefined ? ("tail" as const) : ("full" as const);

            switch (result.kind) {
                case "ok":
                    if (looksBinary(result.content)) return ok({ status: "binary" as const, path, mode });
                    return ok(
                        withRead(
                            { status: "ok" as const, path, mode, content: result.content.toString("utf8") },
                            path,
                            // A line window is a part of the file, even when the window holds each line.
                            mode === "full" ? result.content : null,
                        ),
                    );
                case "truncated":
                    if (looksBinary(result.content)) return ok({ status: "binary" as const, path, mode, totalSize: result.totalSize });
                    return ok(
                        withRead(
                            {
                                status: "truncated" as const,
                                path,
                                mode,
                                content: result.content.toString("utf8"),
                                totalSize: result.totalSize,
                                returnedBytes: result.content.length,
                            },
                            path,
                            null,
                        ),
                    );
                case "not_found":
                    return ok({ status: "not_found" as const, path });
                case "out_of_scope":
                    return ok({ status: "out_of_scope" as const, path });
            }
        },
    });
}
