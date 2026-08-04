/**
 * Phase 4 — dossier assembly.
 *
 * Calls `assembleDossier` (~3.5K LOC of aggregation over the Phase-3 bundle)
 * and returns the assembled `DossierBody`. The safety-corroboration and
 * claim-investigation sections are stamped by the workflow body between this
 * step and synthesis; the Phase-5 synthesis sections (translational commentary,
 * liability bullets, safety-flags trail) are stamped by the Phase-5 persist
 * step.
 *
 * The DBOS workflow body wraps this in `DBOS.runStep({name: "phase4-assemble"})`
 * so recovery on a fresh replica replays the cached output without re-running
 * the compute. Replay caching earns its keep here because `annotatorDeps`
 * carries the per-row clinical-consequence annotator's LLM seam: assembly makes
 * bounded model calls for off-target rows that have no cached annotation. Those
 * calls are per-row best-effort — a failure leaves the row's original fallback —
 * and their results are cached in Postgres, so a repeat assessment of the same
 * target reaches them without an LLM call at all.
 */

import type { Pool } from "pg";

import { DossierBodySchema } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { z } from "zod";

import { assembleDossier } from "./assemblers/index.js";
import type { ClinicalConsequenceAnnotatorDeps } from "./lib/clinical-consequence-annotator.js";
import type { Phase3Bundle } from "./steps/phase3-aggregate.js";
import { Phase3BundleSchema } from "./steps/phase3-aggregate.js";

export const Phase4OutputSchema = z.object({
    assessmentId: z.string(),
    dossier: DossierBodySchema,
});

export type Phase4Output = z.infer<typeof Phase4OutputSchema>;

export { Phase3BundleSchema };
export type { Phase3Bundle };

/**
 * Run Phase 4 — assemble the dossier body from the Phase-3 bundle.
 * Safely cached on DBOS replay; the caller supplies the annotator seam.
 */
export async function phase4Assemble(pool: Pool, phase3: Phase3Bundle, annotatorDeps?: ClinicalConsequenceAnnotatorDeps): Promise<Phase4Output> {
    const dossier = await assembleDossier(pool, phase3.phase2, phase3, annotatorDeps);
    return {
        assessmentId: phase3.phase2.phase1.resolved.assessmentId,
        dossier,
    } satisfies Phase4Output;
}
