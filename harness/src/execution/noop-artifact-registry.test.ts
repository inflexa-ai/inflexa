/**
 * Unit test for the cloud-free `createNoopArtifactRegistry`: `register` returns
 * a zero-failure result with no external ids for any input, and `sync`
 * resolves. No disk, no DB, no external artifact store.
 */

import { describe, expect, test } from "bun:test";

import { ProvenanceCollector } from "../provenance/collector.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { AgentSession } from "../auth/types.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import { createNoopArtifactRegistry } from "./noop-artifact-registry.js";

// The noop registry ignores the session; a minimal valid one suffices.
const session: AgentSession = {
    identity: { user: "u-1" },
    scope: { kind: "analysis", analysisId: "a1" },
    provenance: { agentId: "x", callPath: ["x"] },
    auth: makeLocalAuth(),
};

const artifacts: ArtifactManifestEntry[] = [
    { stepId: "tmm", runId: "run-001", path: "scripts/tmm.py", size: 200, type: "script", hash: "h1" },
    { stepId: "tmm", runId: "run-001", path: "output/tmm.csv", size: 4096, type: "output", hash: "h2" },
];

describe("createNoopArtifactRegistry", () => {
    test("register reports zero failures and no external ids", async () => {
        const registry = createNoopArtifactRegistry();

        const result = await registry.register(
            {
                resourceId: "a1",
                runId: "run-001",
                stepId: "tmm",
                artifacts,
                collector: new ProvenanceCollector({ stepId: "tmm", runId: "run-001" }),
            },
            session,
        );

        expect(result).toEqual({ registered: [], failed: [], failedCount: 0 });
    });

    test("sync resolves without effect", async () => {
        const registry = createNoopArtifactRegistry();

        await expect(registry.sync({ resourceId: "a1", runId: "run-001", stepId: "tmm" }, session)).resolves.toBeUndefined();
    });
});
