/**
 * Artifact manifest schema — defines entries tracked in working memory.
 *
 * The manifest is updated deterministically by the workflow runner
 * after each step completes, not by the LLM.
 */

import { z } from "zod";

/** Artifact type inferred from the step subdirectory. */
export const ArtifactTypeSchema = z.enum(["output", "figure", "script", "log", "notebook"]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

/** A single artifact manifest entry. */
export const ArtifactManifestEntrySchema = z.object({
    /** Step that produced this artifact. */
    stepId: z.string(),
    /** Workflow run ID. */
    runId: z.string(),
    /** Relative path within the workspace (e.g., runs/run-001/steps/de-analysis/output/results.csv). */
    path: z.string(),
    /** File size in bytes. */
    size: z.number(),
    /** Artifact type inferred from subdirectory. */
    type: ArtifactTypeSchema,
    /** SHA-256 content hash for integrity verification (e.g., sha256:abcdef...). */
    hash: z.string().optional(),
});

export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;

const FOLDER_TYPES = [
    ["figures", "figure"],
    ["scripts", "script"],
    ["logs", "log"],
    ["notebooks", "notebook"],
] as const satisfies ReadonlyArray<readonly [string, ArtifactType]>;

/** Infer artifact type from a file path. A folder segment at the start of the path or after a `/` gives its type. */
export function inferArtifactType(filePath: string): ArtifactType {
    for (const [folder, type] of FOLDER_TYPES) {
        if (filePath.startsWith(`${folder}/`) || filePath.includes(`/${folder}/`)) return type;
    }
    return "output";
}
