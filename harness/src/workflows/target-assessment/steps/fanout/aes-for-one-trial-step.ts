/**
 * Per-trial AE — fan-out item schemas.
 *
 * The DBOS-driven implementation lives in `target-assessment/fanout/index.ts`
 * (`aesForOneTrial`); this module is retained for its input/output schemas
 * and inferred item types.
 */

import { z } from "zod";

export const TrialItemSchema = z.object({
    nctId: z.string(),
    title: z.string(),
});
export type TrialItem = z.infer<typeof TrialItemSchema>;

const OutcomeEffectSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("quantitative"),
        value: z.number(),
        units: z.string(),
        ci_low: z.number().optional(),
        ci_high: z.number().optional(),
    }),
    z.object({
        kind: z.literal("not_extracted"),
        reason: z.enum(["ctgov_no_numeric_result", "ctgov_no_result_groups"]),
    }),
]);

export const PerTrialAEsItemSchema = z.object({
    nctId: z.string(),
    title: z.string(),
    whyStopped: z.string().nullable(),
    outcomes: z
        .array(
            z.object({
                type: z.enum(["primary", "secondary", "other"]),
                measure: z.string(),
                description: z.string().nullable(),
                timeFrame: z.string().nullable(),
                effect: OutcomeEffectSchema,
            }),
        )
        .default([]),
    groups: z.array(
        z.object({
            groupId: z.string(),
            title: z.string(),
            description: z.string().nullable(),
        }),
    ),
    events: z.array(
        z.object({
            serious: z.boolean(),
            term: z.string(),
            organSystem: z.string().nullable(),
            counts: z.array(
                z.object({
                    groupId: z.string(),
                    numAffected: z.number().nullable(),
                    numAtRisk: z.number().nullable(),
                }),
            ),
        }),
    ),
});
export type PerTrialAEsItem = z.infer<typeof PerTrialAEsItemSchema>;
