/**
 * Artifact manifest schema — defines entries tracked in working memory.
 *
 * The manifest is updated deterministically by the workflow runner
 * after each step completes, not by the LLM.
 */

import { z } from "zod";

/** Artifact type inferred from the file extension. */
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
    /** Artifact type inferred from the file extension. */
    type: ArtifactTypeSchema,
    /** SHA-256 content hash for integrity verification (e.g., sha256:abcdef...). */
    hash: z.string().optional(),
});

export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;

/**
 * The type of a file by its extension. The agent of a step gives its work directory its own structure, thus no
 * folder name states the type. Each other extension is an output.
 */
const EXTENSION_TYPES: ReadonlyMap<string, ArtifactType> = new Map([
    ...[".png", ".jpg", ".jpeg", ".gif", ".svg", ".tif", ".tiff", ".webp", ".pdf"].map((extension) => [extension, "figure"] as const),
    ...[".py", ".r", ".sh", ".js", ".ts", ".jl"].map((extension) => [extension, "script"] as const),
    ...[".ipynb", ".rmd", ".qmd"].map((extension) => [extension, "notebook"] as const),
    [".log", "log"] as const,
]);

/** Infer artifact type from a file path, by the extension of its file name. */
export function inferArtifactType(filePath: string): ArtifactType {
    const name = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "output" : (EXTENSION_TYPES.get(name.slice(dot)) ?? "output");
}
