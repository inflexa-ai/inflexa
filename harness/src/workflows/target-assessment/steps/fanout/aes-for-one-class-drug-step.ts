/**
 * Per-class-drug AE — fan-out item schemas.
 *
 * The DBOS-driven implementation lives in `target-assessment/fanout/index.ts`
 * (`aesForOneClassDrug`); this module is retained for its input/output
 * schemas and inferred item types.
 */

import { z } from "zod";

export const ClassDrugItemSchema = z.object({
    moleculeChemblId: z.string(),
    preferredName: z.string(),
    maxPhase: z.number().nullable(),
    firstApproval: z.number().nullable(),
});
export type ClassDrugItem = z.infer<typeof ClassDrugItemSchema>;

export const PerClassDrugAEsItemSchema = z.object({
    moleculeChemblId: z.string(),
    preferredName: z.string(),
    totalReports: z.number().nullable(),
    topReactions: z.array(z.object({ reaction: z.string(), count: z.number() })),
    seriousness: z
        .object({
            totalReports: z.number(),
            fatalCount: z.number(),
            hospitalizationCount: z.number(),
            lifeThreateningCount: z.number(),
            disablingCount: z.number(),
            congenitalAnomalyCount: z.number().default(0),
            otherSeriousCount: z.number().default(0),
        })
        .nullable(),
});
export type PerClassDrugAEsItem = z.infer<typeof PerClassDrugAEsItemSchema>;
