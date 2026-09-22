import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { SpawnSession } from "../../auth/types.js";
import type { SandboxSpec } from "../types.js";

export type TestSpawn = SandboxSpec & { readonly analysisId: string; readonly runId: string; readonly stepId: string };

export function spawnSession(ids: { readonly analysisId: string; readonly runId: string; readonly stepId: string }): SpawnSession {
    return {
        identity: { user: "u-test" },
        scope: { kind: "analysis", analysisId: ids.analysisId },
        provenance: { agentId: "test-agent", callPath: ["test-agent"] },
        runFrame: { runId: ids.runId, stepId: ids.stepId },
        auth: makeLocalAuth(),
    };
}

export function splitSpawn({ analysisId, runId, stepId, ...spec }: TestSpawn): [SpawnSession, SandboxSpec] {
    return [spawnSession({ analysisId, runId, stepId }), spec];
}
