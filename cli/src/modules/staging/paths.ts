import { join } from "node:path";
import { env } from "../../lib/env.ts";

// Per-analysis derivations over the ONE global session base (`env.sessionsDir` — see
// its JSDoc for why the base cannot be per-analysis). The harness performs the same
// `join(sessionsBasePath, analysisId, …)` internally when it pre-creates step dirs and
// plans sandbox mounts; these helpers exist for the CLI side of the same tree —
// staging targets and host-side reads — so the layout is spelled out in exactly one
// place per party.

/** Root of an analysis's session tree: `{sessionsDir}/{analysisId}`. */
export function sessionTreeRoot(analysisId: string): string {
    return join(env.sessionsDir, analysisId);
}

/**
 * The `data/` root of an analysis's session tree — the `targetDir` contract of
 * `stageInputs`, which writes `inputs/local/{key}` beneath it. Passing anything
 * deeper (e.g. an `…/inputs` path) doubles the segment.
 */
export function sessionTreeDataDir(analysisId: string): string {
    return join(sessionTreeRoot(analysisId), "data");
}
