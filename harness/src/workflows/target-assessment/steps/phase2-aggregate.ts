/**
 * Phase 2 aggregator — schema definitions retained for downstream
 * type-checking. The DBOS workflow assembles the Phase-2 bundle inline.
 *
 * The `failedTrialClassifier` and `offTargetCurator` keys present in
 * earlier versions were removed as part of the
 * `target-dossier-deep-synthesis` change — those steps were no-ops; their
 * deterministic logic runs in Phase 4 (`classifyFailureReason`,
 * `aggregateOffTargetPanel`). The bundle continues to expose them as
 * coverage-tagged stubs so downstream code that still reads them
 * compiles, but nothing populates them.
 */

import { z } from "zod";
import { Phase1BundleSchema } from "../schemas.js";
import { withCoverage } from "../coverage.js";
import { ModulatorTriageOutputSchema, DrugsInClassOutputSchema } from "../decisions/index.js";

const StubFailedTrialClassifierSchema = z.object({
    classifications: z.array(z.unknown()).default([]),
});
const StubOffTargetCuratorSchema = z.object({
    panel: z.array(z.unknown()).default([]),
    total: z.number().default(0),
    truncated: z.boolean().default(false),
    notes: z.string().default(""),
});

export const Phase2AggregateInputSchema = z.object({
    "decision-modulator-triage": withCoverage(ModulatorTriageOutputSchema),
    "decision-drugs-in-class": withCoverage(DrugsInClassOutputSchema),
});

export const Phase2BundleSchema = z.object({
    phase1: Phase1BundleSchema,
    decisions: z.object({
        modulatorTriage: withCoverage(ModulatorTriageOutputSchema),
        failedTrialClassifier: withCoverage(StubFailedTrialClassifierSchema),
        offTargetCurator: withCoverage(StubOffTargetCuratorSchema),
        drugsInClass: withCoverage(DrugsInClassOutputSchema),
    }),
});
export type Phase2Bundle = z.infer<typeof Phase2BundleSchema>;
