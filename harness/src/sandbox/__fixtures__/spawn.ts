/**
 * Spawn arguments for sandbox tests. A test writes the ids of a spawn beside
 * its spec in one literal, and `splitSpawn` gives the session and the spec
 * that `createSandbox` takes.
 */

import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { SpawnSession } from "../../auth/types.js";
import type { SandboxSpec } from "../types.js";

/** The ids of a test spawn beside its spec. */
export type TestSpawn = SandboxSpec & { readonly analysisId: string; readonly runId: string; readonly stepId: string };

/** The session of a spawn for the given ids. */
export function spawnSession(ids: { readonly analysisId: string; readonly runId: string; readonly stepId: string }): SpawnSession {
    return {
        identity: { user: "u-test" },
        scope: { kind: "analysis", analysisId: ids.analysisId },
        provenance: { agentId: "test-agent", callPath: ["test-agent"] },
        runFrame: { runId: ids.runId, stepId: ids.stepId },
        auth: makeLocalAuth(),
    };
}

/** Split a test spawn into the session and the spec of `createSandbox`. */
export function splitSpawn({ analysisId, runId, stepId, ...spec }: TestSpawn): [SpawnSession, SandboxSpec] {
    return [spawnSession({ analysisId, runId, stepId }), spec];
}
