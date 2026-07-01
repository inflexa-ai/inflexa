/**
 * `ArtifactRegistry` — provenance-agnostic seam for external artifact
 * registration.
 *
 * The harness's `registerStepArtifacts` owns the local ledger (cortex_artifacts) and
 * delegates external provenance registration to an injected `ArtifactRegistry`.
 * The seam input is the high-level step input; the result is a flat per-path
 * outcome. The seam deliberately mentions no host-managed vocabulary — a
 * filesystem adapter satisfies it just as well as a managed adapter.
 *
 * Adapters:
 *   - a managed provenance adapter (harness/compose/) — builds the structured
 *     payload and calls the host provenance ledger.
 *   - `FilesystemArtifactRegistry` (the harness, this dir) — writes a local provenance
 *     index file.
 */

import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { ProvenanceCollector } from "../provenance/collector.js";
import type { AgentSession } from "../auth/types.js";

/** High-level input for registering one step's artifacts. */
export interface ArtifactRegistrationInput {
    /** Analysis resource ID. */
    resourceId: string;
    /** Workflow run ID. */
    runId: string;
    /** Step ID that produced the artifacts. */
    stepId: string;
    /** Artifact manifest from the sandbox runner. */
    artifacts: ArtifactManifestEntry[];
    /** Provenance collector with tracked inputs/outputs. */
    collector: ProvenanceCollector;
}

/** Step coordinates for a per-step artifact sync. */
export interface ArtifactSyncInput {
    /** Analysis resource ID. */
    resourceId: string;
    /** Workflow run ID. */
    runId: string;
    /** Step ID whose registered artifacts are synced. */
    stepId: string;
}

/**
 * Outcome of external registration. Flat per-path results — no provenance-model
 * vocabulary leaks across the seam.
 */
export interface ExternalRegistrationResult {
    /**
     * Artifacts the external registry accepted, with the external identity to
     * write back onto the local ledger row. `path` is the analysis-scoped path
     * (`runs/{runId}/{stepId}/...`) matching the local ledger row.
     */
    registered: Array<{ path: string; externalId: string }>;
    /** Per-path rejections (persistent — transient errors are retried inside the adapter). */
    failed: Array<{ path: string; error: string }>;
    /**
     * Number of rows the external registry rejected. Usually `failed.length`, but
     * an adapter may report a higher count when a single transport error rolls
     * back a whole batch (`failed` then carries one summary entry).
     */
    failedCount: number;
}

export interface ArtifactRegistry {
    /**
     * Register one step's artifacts with the external provenance system.
     * Implementations MUST NOT touch the local `cortex_artifacts` ledger — that
     * is the harness's responsibility, applied around this call. The `session` carries
     * the run credential an adapter needs to address the external system.
     */
    register(input: ArtifactRegistrationInput, session: AgentSession): Promise<ExternalRegistrationResult>;
    /**
     * Push a step's registered artifacts to permanent storage. A no-op when the
     * adapter's bytes already live locally; the managed adapter uploads them.
     * Throws on a persistent failure so the caller's fail-fast boundary fires.
     */
    sync(input: ArtifactSyncInput, session: AgentSession): Promise<void>;
}
