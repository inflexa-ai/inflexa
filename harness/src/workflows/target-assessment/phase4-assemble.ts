/**
 * Phase 4 — deterministic dossier assembly.
 *
 * Pure function over a Phase-3 bundle. Calls `assembleDossier` (~3.5K LOC
 * of pure compute) and returns the assembled `DossierV4Body`. The Phase-5
 * synthesis sections (translational commentary, liability bullets, safety-
 * flags trail) are stamped by the Phase-5 persist step after this step
 * completes.
 *
 * The DBOS workflow body wraps this in `DBOS.runStep({name: "phase4-assemble"})`
 * so recovery on a fresh replica replays the cached output without re-running
 * the ~1-3 sec compute.
 *
 * `assembleDossier` accepts an optional `ClinicalConsequenceAnnotatorDeps`
 * bundle that is threaded through to `annotateOffTargetPanel`. For the
 * DBOS workflow the parameter is undefined — the annotator falls back to
 * its DB cache + no-LLM path. Threading a real deps bundle (provider +
 * session + model) through Phase-4 is a follow-up tracked in §17 cleanup.
 */

import type { Pool } from "pg";

import { DossierV4BodySchema } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { z } from "zod";

import { assembleDossier } from "./assemblers/index.js";
import type { Phase3Bundle } from "./steps/phase3-aggregate.js";
import { Phase3BundleSchema } from "./steps/phase3-aggregate.js";

export const Phase4OutputSchema = z.object({
    assessmentId: z.string(),
    dossier: DossierV4BodySchema,
});

export type Phase4Output = z.infer<typeof Phase4OutputSchema>;

export { Phase3BundleSchema };
export type { Phase3Bundle };

/**
 * Run Phase 4 — assemble the v4 dossier body from the Phase-3 bundle.
 * Deterministic over its inputs; safely cached on DBOS replay.
 */
export async function phase4Assemble(pool: Pool, phase3: Phase3Bundle): Promise<Phase4Output> {
    const dossier = await assembleDossier(pool, phase3.phase2, phase3, undefined);
    return {
        assessmentId: phase3.phase2.phase1.resolved.assessmentId,
        dossier,
    } satisfies Phase4Output;
}
