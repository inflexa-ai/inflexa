/**
 * Artifact registration — registers a step's artifacts in the local ledger
 * (cortex_artifacts) and with an injected provenance-agnostic
 * `ArtifactRegistry`.
 *
 * The harness owns the local ledger: it builds the `cortex_artifacts` rows, upserts
 * them, then calls `registry.register(...)` for external provenance and writes
 * the returned external ids back onto the ledger rows. Which registry is wired
 * (an external provenance ledger, or a filesystem index) is a composition-root
 * decision — this module never names one.
 */

import type { Pool, PoolClient } from "pg";
import type { AgentSession } from "../auth/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { RegisterArtifactInput } from "../state/index.js";
import { upsertArtifacts, updateArtifactId } from "../state/index.js";
import type { ArtifactRegistry, ArtifactRegistrationInput } from "./artifact-registry.js";

export type { ArtifactRegistrationInput };

export interface ArtifactRegistrationResult {
    /** Number of artifacts written to the local ledger. */
    localCount: number;
    /** Number of artifacts registered externally and given external IDs. */
    externalRegistered: number;
    /** Number of external registration failures. */
    externalFailed: number;
    /** Per-artifact failure details from the registry (if any). */
    failureDetails: Array<{ path: string; error: string }>;
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register step-level artifacts (paths under `runs/{runId}/{stepId}/`).
 *
 * Builds the `cortex_artifacts` rows from the manifest, upserts them, then
 * delegates external provenance registration to the injected `ArtifactRegistry`
 * and applies any returned external ids back onto the local rows.
 */
export async function registerStepArtifacts(
    db: Pool | PoolClient,
    registry: ArtifactRegistry,
    input: ArtifactRegistrationInput,
    session: AgentSession,
    // A parameter rather than a field on `ArtifactRegistrationInput`: that type is
    // the seam's payload, handed verbatim to `registry.register`, and an
    // embedder's registry has no business receiving the host's logger.
    logger: Logger = createNoopLogger(),
): Promise<ArtifactRegistrationResult> {
    const { resourceId, runId, stepId, artifacts } = input;
    const log = logger.named("artifact-registration").with({ runId, stepId });

    if (artifacts.length === 0) {
        return { localCount: 0, externalRegistered: 0, externalFailed: 0, failureDetails: [] };
    }

    const dbPathPrefix = `runs/${runId}/${stepId}/`;
    const emptyHash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const localEntries: RegisterArtifactInput[] = artifacts.map((a) => {
        if (a.size === 0 || a.hash === emptyHash) {
            log.warn("empty artifact", { path: `${dbPathPrefix}${a.path}`, hash: a.hash?.slice(0, 16), size: a.size });
        }
        return {
            resourceId,
            path: `${dbPathPrefix}${a.path}`,
            hash: a.hash ?? "",
            size: a.size,
            role: "step_output" as const,
            sourceStep: stepId,
            sourceRun: runId,
            fileType: a.type,
        };
    });

    await upsertArtifacts(db, localEntries);

    const localPaths = new Set(localEntries.map((e) => e.path));
    const result = await registry.register(input, session);

    let externalRegistered = 0;
    for (const reg of result.registered) {
        // Skip files the registry also returned that we didn't upsert locally
        // (e.g., data inputs that were already born-synced).
        if (!localPaths.has(reg.path)) continue;
        await updateArtifactId(db, resourceId, reg.path, reg.externalId);
        externalRegistered++;
    }

    return {
        localCount: localEntries.length,
        externalRegistered,
        externalFailed: result.failedCount,
        failureDetails: result.failed,
    };
}
