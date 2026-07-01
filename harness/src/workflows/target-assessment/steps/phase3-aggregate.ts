/**
 * Phase 3 aggregator — schema definitions retained for downstream
 * type-checking. The DBOS workflow assembles the Phase-3 bundle inline.
 */

import { z } from "zod";
import { Phase2BundleSchema } from "./phase2-aggregate.js";
import {
    PerModulatorFaersResultsSchema,
    PerTrialAEsResultsSchema,
    PerModulatorPolypharmResultsSchema,
    PerClassDrugAEsResultsSchema,
} from "../sub-workflows/index.js";

export const Phase3AggregateInputSchema = z.object({
    "per-modulator-faers": PerModulatorFaersResultsSchema,
    "per-trial-aes": PerTrialAEsResultsSchema,
    "per-modulator-polypharm": PerModulatorPolypharmResultsSchema,
    "per-class-drug-aes": PerClassDrugAEsResultsSchema,
});

export const Phase3BundleSchema = z.object({
    phase2: Phase2BundleSchema,
    fanout: z.object({
        perModulatorFaers: PerModulatorFaersResultsSchema,
        perTrialAes: PerTrialAEsResultsSchema,
        perModulatorPolypharm: PerModulatorPolypharmResultsSchema,
        perClassDrugAes: PerClassDrugAEsResultsSchema,
    }),
});
export type Phase3Bundle = z.infer<typeof Phase3BundleSchema>;
