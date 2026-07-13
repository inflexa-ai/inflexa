/**
 * Artifact record — the shape post-step deps and the provenance collector
 * read for each file the step produced (hash + size + tool provenance +
 * write timestamp). Pure data type; lives in its own file because it is
 * shared across `execution/` and `provenance/`.
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
    /** ISO 8601 timestamp captured at write time. */
    timestamp: string;
}
