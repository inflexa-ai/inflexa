/**
 * `submit_file_metadata` — the output tool of the file-metadata continuation of
 * a sandbox step (see the harness-sandbox-agents spec).
 *
 * Each step agent declares this tool from its first request; a mask refuses it
 * until the file-metadata continuation, because the tool set sits in the
 * prefix that the prompt cache and a signed thinking block bind to.
 *
 * The tool matches each description to its file BY PATH, never by array
 * index, so a dropped, reordered, or extra entry can never attach a
 * description to the wrong file.
 */

import { err, ok, type Result } from "neverthrow";

import { SubmitFileMetadataInputSchema, type SubmittedFileDescription } from "../../schemas/file-metadata.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

export const SUBMIT_FILE_METADATA_TOOL_ID = "submit_file_metadata";

/**
 * The per-step cell of the file-metadata continuation. The step body makes it
 * beside the blocker cell, and the agent factory binds the output tool to it.
 */
export interface FileMetadataCell {
    /** The paths that the continuation describes, or `null` before the first `expect`. */
    readonly knownPaths: ReadonlySet<string> | null;
    /** The accepted description of each described path, keyed by the path. The tool writes only a known path. */
    readonly descriptions: Map<string, SubmittedFileDescription>;
    /** Arm the cell for one continuation: set the known paths, and drop each accepted description. */
    expect(paths: readonly string[]): void;
}

export function createFileMetadataCell(): FileMetadataCell {
    let knownPaths: ReadonlySet<string> | null = null;
    const descriptions = new Map<string, SubmittedFileDescription>();
    return {
        get knownPaths() {
            return knownPaths;
        },
        descriptions,
        expect(paths) {
            knownPaths = new Set(paths);
            descriptions.clear();
        },
    };
}

/** What one call of the tool tells the model about the coverage of the files. */
interface SubmitFileMetadataOutcome {
    /** True when the call named no unknown path and each known path has a description. */
    readonly accepted: boolean;
    readonly unknownPaths: readonly string[];
    readonly remaining: readonly string[];
}

/** Build the `submit_file_metadata` tool bound to the cell of one step. */
export function createSubmitFileMetadataTool(cell: FileMetadataCell): Tool {
    return defineTool({
        id: SUBMIT_FILE_METADATA_TOOL_ID,
        description:
            "Submit the metadata of the output files of this step. The harness asks " +
            "for this tool after the task, with the list of the files. It does not " +
            "run during the task. Each entry's `path` MUST exactly match one of the " +
            "listed files. Returns {accepted, unknownPaths, remaining}: " +
            "accepted=true means every file now has metadata — STOP. Otherwise drop " +
            "the unknownPaths and describe the remaining files.",
        inputSchema: SubmitFileMetadataInputSchema,
        describeCall: "none",
        execute: async (input): Promise<Result<SubmitFileMetadataOutcome, ToolError>> => {
            const knownPaths = cell.knownPaths;
            if (knownPaths === null) {
                return err({
                    error: "No list of files is known yet. The harness asks for the file metadata after the task, with the list of the files.",
                    retryable: false,
                });
            }
            const unknownPaths: string[] = [];
            for (const entry of input.files) {
                if (!knownPaths.has(entry.path)) {
                    unknownPaths.push(entry.path);
                    continue;
                }
                cell.descriptions.set(entry.path, entry);
            }
            const remaining = [...knownPaths].filter((path) => !cell.descriptions.has(path));
            return ok({
                accepted: unknownPaths.length === 0 && remaining.length === 0,
                unknownPaths,
                remaining,
            });
        },
    });
}
