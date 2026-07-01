/**
 * Provenance collector seam — the mutate surface records a SHA-256 content
 * snapshot at each write. Construction-time dependency (see the harness-durable-runtime spec): the
 * composition root builds a `ProvenanceCollector` and passes it to the
 * mutate tool factories.
 *
 * Captured here are *harness-side* writes (`write_file`, `edit_file`). The
 * harness does NOT hash in-sandbox writes produced by `execute_command`'s
 * arbitrary commands — sandbox-server emits its own provenance frames per
 * `sandbox-provenance-tracking` and artifact registration reconciles them.
 *
 * `recordSnapshot` is best-effort metadata: collector failures SHALL NOT
 * fail the write. The mutate tools catch and log internally; this contract
 * does not require the collector to be non-throwing.
 */

export interface ProvenanceSnapshot {
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    /**
     * The resolved workspace path of the written file — the sandbox-visible
     * path (e.g. `/{analysisId}/runs/{runId}/{stepId}/output/x.csv`), which is
     * the same path the read surface uses.
     */
    readonly path: string;
    /** Lowercase hex SHA-256 of the *written* content (post-edit for edit_file). */
    readonly sha256: string;
    readonly bytes: number;
    /** Unix milliseconds at the time of recording. */
    readonly timestamp: number;
}

export interface ProvenanceCollector {
    recordSnapshot(snapshot: ProvenanceSnapshot): Promise<void>;
}
