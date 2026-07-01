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
    path: z.string(),
    description: z.string(),
    dataType: z.string(),
    format: z.string(),
    rows: z.number().nullish(),
    cols: z.number().nullish(),
    tags: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
});
export type SubmittedFileDescription = z.infer<typeof SubmittedFileDescriptionSchema>;

/** Input contract for the `submit_file_metadata` tool. */
export const SubmitFileMetadataInputSchema = z.object({
    files: z.array(SubmittedFileDescriptionSchema),
});
export type SubmitFileMetadataInput = z.infer<typeof SubmitFileMetadataInputSchema>;
