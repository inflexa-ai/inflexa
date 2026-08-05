/**
 * Shared coverage discriminator for target-assessment workflow steps.
 *
 * Per design §6, every collector / decision / fan-out / synthesis step
 * MUST wrap its body in try/catch and return a `{ coverage, ... }` shape
 * instead of throwing. Only Phase 0 (target resolution) is allowed to
 * throw — that legitimately aborts the workflow.
 *
 * `CoverageSchema` in `contracts/target-dossier.ts` is the one enumeration of
 * the coverage states, and the helpers below emit its members. A step envelope
 * carries the three states a step can reach on its own; `filtered` is a
 * judgement one of our own filters makes, so only the assembler helpers below
 * produce it.
 */

import { z } from "zod";

export const SerializedErrorSchema = z.object({
    message: z.string(),
    name: z.string().optional(),
    stack: z.string().optional(),
});
export type SerializedError = z.infer<typeof SerializedErrorSchema>;

/**
 * Build the schema for a `{ coverage, data, error? }` step output.
 *
 * Use as: `outputSchema: withCoverage(MyDataSchema)` where `MyDataSchema`
 * is the shape of the Phase-1 / Phase-2 / etc. payload for this step.
 */
export function withCoverage<TData extends z.ZodTypeAny>(dataSchema: TData) {
    return z.discriminatedUnion("coverage", [
        z.object({
            coverage: z.literal("available"),
            data: dataSchema,
        }),
        z.object({
            coverage: z.literal("queried_no_data"),
            error: SerializedErrorSchema.optional(),
        }),
        z.object({
            coverage: z.literal("not_loaded"),
            reason: z.string().optional(),
        }),
    ]);
}

/**
 * Convenience wrapper for `{ rows: T[] }` payloads. Maps an empty rows
 * array to `coverage: "queried_no_data"` so the dossier discriminator's
 * "available ≡ we have data" invariant holds without per-callsite
 * length checks. Use at any assembler callsite that emits a `rows`
 * shape from a query that may legitimately return zero items.
 */
export function coverageFromRows<T>(
    rows: T[],
    opts?: { reason?: string },
): { coverage: "available"; data: { rows: T[] } } | { coverage: "queried_no_data"; error: SerializedError } {
    if (rows.length === 0) {
        return {
            coverage: "queried_no_data",
            error: { message: opts?.reason ?? "no rows returned" },
        };
    }
    return { coverage: "available", data: { rows } };
}

/**
 * Build a dossier-section envelope for a row list one of our own filters
 * narrowed.
 *
 * A filter is not the same as an empty upstream, and the difference is the
 * whole point of the four-state contract. Deciding coverage from the source
 * and then filtering the payload loses it: a section whose every row our
 * threshold discarded reports a clean `available` holding nothing, which reads
 * as "the source had nothing to say".
 *
 * So the decision is made once, from both counts:
 *   - nothing survived and something was dropped → `filtered`, naming the
 *     filter and the count it discarded, with no `data`;
 *   - some survived and some were dropped → `available` carrying
 *     `dropped_count`, so the section does not overstate its completeness;
 *   - nothing survived and nothing was dropped → `queried_no_data`: the list
 *     was empty before any filter of ours ran.
 */
export function coverageFromFilteredRows<TData>(args: {
    data: TData;
    retainedCount: number;
    droppedCount: number;
    /** What ran, in a reader's terms — carried verbatim on the `filtered` branch. */
    filter: string;
    /** Why the source itself held nothing, used only when no filter dropped anything. */
    emptyReason: string;
}):
    | { coverage: "available"; data: TData; dropped_count?: number }
    | { coverage: "filtered"; filter: string; dropped_count: number }
    | { coverage: "queried_no_data"; error: SerializedError } {
    const { data, retainedCount, droppedCount, filter, emptyReason } = args;
    if (retainedCount > 0) {
        return droppedCount > 0 ? { coverage: "available", data, dropped_count: droppedCount } : { coverage: "available", data };
    }
    if (droppedCount > 0) {
        return { coverage: "filtered", filter, dropped_count: droppedCount };
    }
    return { coverage: "queried_no_data", error: { message: emptyReason } };
}
