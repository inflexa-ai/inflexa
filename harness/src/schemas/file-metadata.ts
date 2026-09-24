import { z } from "zod";

export const FileMetadataSchema = z
    .object({
        role: z.enum(["input", "step_output"]),
        dataType: z.string(),
        format: z.string(),
        rows: z.number().optional(),
        cols: z.number().optional(),
        producerStep: z.string().optional(),
        producerRun: z.string().optional(),
        producerAgent: z.string().optional(),
        omicsType: z.string().optional(),
        organism: z.string().optional(),
        featureType: z.string().optional(),
        tags: z.array(z.string()).optional(),
        warnings: z.array(z.string()).optional(),
    })
    .passthrough();
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

/**
 * One file's metadata as submitted by the describer agent through the
 * `submit_file_metadata` tool. Keyed by `path` — the tool validates each
 * path against the known artifact set, so descriptions are matched to files
 * by path, never by array position.
 */
export const SubmittedFileDescriptionSchema = z.object({
    /** Exact path of the file being described, copied from the prompt's list. */
    path: z.string().describe("The path of the file, copied exactly from the list of files that the harness gave."),
    description: z.string().describe("One sentence that says what the file contains. A semantic search of the workspace later finds the file by this text."),
    dataType: z.string().describe('The semantic type of the data, for example "count matrix" or "QC report".'),
    format: z.string().describe('The file format, for example "csv", "tsv", "h5ad", or "png".'),
    rows: z.number().nullish().describe("The count of rows, when you know it."),
    cols: z.number().nullish().describe("The count of columns, when you know it."),
    tags: z.array(z.string()).optional().describe("Short labels that help a search find the file."),
    warnings: z.array(z.string()).optional().describe("Known problems of the file that a reader must know before use."),
});
export type SubmittedFileDescription = z.infer<typeof SubmittedFileDescriptionSchema>;

/** Input contract for the `submit_file_metadata` tool. */
export const SubmitFileMetadataInputSchema = z.object({
    files: z.array(SubmittedFileDescriptionSchema).describe("One entry per output file. You can cover the files in one call or in several."),
});
export type SubmitFileMetadataInput = z.infer<typeof SubmitFileMetadataInputSchema>;
