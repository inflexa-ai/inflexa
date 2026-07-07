import type { ArtifactRegistry, ExternalRegistrationResult } from "./artifact-registry.js";

/**
 * Local/OSS artifact-registration seam: `register` records nothing externally
 * and reports zero failures; `sync` is a no-op. The harness writes the local
 * `cortex_artifacts` ledger itself around this seam (see
 * `artifact-registration.ts`), so an embedder with no external provenance
 * system genuinely has nothing to register. `failedCount: 0` is the shape the
 * post-step fail-fast gate reads as success, so the local default never trips
 * it.
 */
export function createNoopArtifactRegistry(): ArtifactRegistry {
    return {
        async register(): Promise<ExternalRegistrationResult> {
            return { registered: [], failed: [], failedCount: 0 };
        },
        async sync(): Promise<void> {},
    };
}
