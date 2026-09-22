/**
 * `ArtifactRegistry` — provenance-agnostic seam for external artifact
 * registration.
 *
 * The harness's `registerStepArtifacts` owns the local ledger (cortex_artifacts) and
 * delegates external provenance registration to an injected `ArtifactRegistry`.
 * The seam input is the high-level step input; the result is a flat per-path
 * outcome. The seam deliberately mentions no host-managed vocabulary — a
 * trivial no-op adapter satisfies it just as well as a managed adapter.
 *
 * Adapters:
 *   - a managed provenance adapter (harness/compose/) — builds the structured
 *     payload and calls the host provenance ledger.
 *   - `createNoopArtifactRegistry` (the harness, this dir) — registers nothing
 *     externally; the local `cortex_artifacts` ledger is the only record.
 */

import type { ResultAsync } from "neverthrow";

import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { ProvenanceCollector } from "../provenance/collector.js";
import type { AgentSession } from "../auth/types.js";
import type { GateFailure, NoticeFailure } from "../lib/hooks.js";

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
    /**
     * Rejections the registry judged non-terminal and deliberately kept out of
     * `failed`/`failedCount`: rows it never attempted, so nothing registered and
     * no bytes are at risk. Reported rather than dropped — excluding a rejection
     * decides only that it is not worth failing a step over, never that it goes
     * unrecorded. Keeping them out of `failed` is what lets the fail-fast message
     * list only the paths that actually cost the step something; surfacing them
     * here is what keeps the registry's verdict checkable against what the
     * external system actually said.
     */
    notCounted?: ReadonlyArray<{ path: string; error: string }>;
}

export interface ArtifactRegistry {
    /**
     * Register one step's artifacts with the external provenance system.
     * Implementations MUST NOT touch the local `cortex_artifacts` ledger — that
     * is the harness's responsibility, applied around this call. The `session` carries
     * the run credential an adapter needs to address the external system.
     *
     * A partial outcome is an `ok`, with the rejections in `failed`.
     */
    register(input: ArtifactRegistrationInput, session: AgentSession): ResultAsync<ExternalRegistrationResult, GateFailure>;
    /**
     * Push a step's registered artifacts to permanent storage. A no-op when the
     * adapter's bytes already live locally; the managed adapter uploads them.
     *
     * A notice (see `lib/hooks.ts`): an `err` is logged and does not fail the
     * step. The rows stay unsynced, thus a later sync of the step selects them
     * again.
     */
    sync(input: ArtifactSyncInput, session: AgentSession): ResultAsync<void, NoticeFailure>;
}
