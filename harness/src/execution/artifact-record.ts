/**
 * Artifact record — the shape post-step deps and the provenance collector
 * read for each file the step produced (hash + size + tool provenance).
 * Pure data type; lives in its own file because it is shared across
 * `execution/` and `provenance/`.
 */

export interface ArtifactRecord {
    path: string;
    hash: string;
    size: number;
    /**
     * The filesystem operation that created this artifact (`write_file`,
     * `edit_file`). Undefined for files discovered by disk scan —
     * their provenance comes from the collector.
     */
    toolName?: string;
    /**
     * The loop's tool-call id of the write — replay-stable (the durably
     * cached model turn minted it), so the provenance bridge can key a
     * deterministic call-activity identifier on it.
     */
    invocationId: string;
}
