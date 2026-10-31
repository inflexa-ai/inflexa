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

import { SubmitFileMetadataInputSchema } from "../../schemas/file-metadata.js";
import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";

export const SUBMIT_FILE_METADATA_TOOL_ID = "submit_file_metadata";

/**
 * The per-step cell of the file-metadata follow-up request. The step body makes
 * it beside the step agent, and the agent factory binds the output tool to it.
 * The descriptions themselves live in the inputs of the calls: the post-step
 * code reads them from the recorded calls.
 */
export type FileMetadataCell = {
    /** The paths that the follow-up request describes, or `null` before the first `expect`. */
    readonly knownPaths: ReadonlySet<string> | null;
    /** The known paths that the earlier calls described. The loop folds each call record into it. */
    readonly described: ReadonlySet<string>;
    /** Arm the cell for one follow-up request: set the known paths, and forget each described path. */
    expect(paths: readonly string[]): void;
    /** Add the paths of one call record. */
    fold(paths: readonly string[]): void;
};

export function createFileMetadataCell(): FileMetadataCell {
    let knownPaths: ReadonlySet<string> | null = null;
    const described = new Set<string>();
    return {
        get knownPaths() {
            return knownPaths;
        },
        described,
        expect(paths) {
            knownPaths = new Set(paths);
            described.clear();
        },
        fold(paths) {
            for (const path of paths) described.add(path);
        },
    };
}

/** What one call of the tool tells the model about the coverage of the files. */
type SubmitFileMetadataOutcome = {
    /** True when the call named no unknown path and each known path has a description. */
    readonly accepted: boolean;
    readonly unknownPaths: readonly string[];
    readonly remaining: readonly string[];
};

/** The known paths that one call described. */
type DescribedPaths = { readonly described: readonly string[] };

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
        view: "none",
        describeCall: "none",
        execute: (input): Promise<Result<WithToolCallRecord<SubmitFileMetadataOutcome, DescribedPaths>, ToolError>> => {
            const knownPaths = cell.knownPaths;
            if (knownPaths === null) {
                return Promise.resolve(
                    err({
                        error: "No list of files is known yet. The harness asks for the file metadata after the task, with the list of the files.",
                        retryable: false,
                    }),
                );
            }
            const unknownPaths = input.files.map((entry) => entry.path).filter((path) => !knownPaths.has(path));
            const described = input.files.map((entry) => entry.path).filter((path) => knownPaths.has(path));
            const covered = new Set([...cell.described, ...described]);
            const remaining = [...knownPaths].filter((path) => !covered.has(path));
            const outcome: SubmitFileMetadataOutcome = { accepted: unknownPaths.length === 0 && remaining.length === 0, unknownPaths, remaining };
            return Promise.resolve(ok(withToolCallRecord(outcome, { described })));
        },
        foldCallRecord: (record) => cell.fold(record.described),
    });
}
