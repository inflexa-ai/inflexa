/**
 * Per-modulator polypharmacology — fan-out item schemas.
 *
 * The DBOS-driven implementation lives in `target-assessment/fanout/index.ts`
 * (`polypharmForOneModulator`); this module is retained for its input/output
 * schemas and inferred item types.
 */

import { z } from "zod";

export const PolypharmInputItemSchema = z.object({
    moleculeChemblId: z.string(),
    preferredName: z.string(),
    primaryTargetChemblId: z.string().nullable(),
});
export type PolypharmInputItem = z.infer<typeof PolypharmInputItemSchema>;

export const PerModulatorPolypharmItemSchema = z.object({
    moleculeChemblId: z.string(),
    preferredName: z.string(),
    /** Median pChEMBL of the modulator against the primary assessment target. */
    primaryPchembl: z.number().nullable(),
    hits: z.array(
        z.object({
            targetChemblId: z.string(),
            targetName: z.string().nullable(),
            pchemblValue: z.number().nullable(),
            standardType: z.string().nullable(),
            standardValue: z.number().nullable(),
            standardUnits: z.string().nullable(),
        }),
    ),
});
export type PerModulatorPolypharmItem = z.infer<typeof PerModulatorPolypharmItemSchema>;
