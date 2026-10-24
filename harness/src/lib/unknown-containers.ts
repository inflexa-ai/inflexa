/**
 * The generic containers that a walk accepts, as zod schemas.
 *
 * A walk over untyped data takes the container shape at its entry and keeps each field and each entry
 * `unknown`, so every read narrows on its own. The record schema refuses an array, where a
 * `typeof x === "object"` probe would accept one.
 */

import { z } from "zod";

/** A record whose fields the walk narrows one by one. */
export const UnknownRecordSchema = z.record(z.string(), z.unknown());

/** An array whose entries the walk narrows one by one. */
export const UnknownArraySchema = z.array(z.unknown());

/** The record that a value holds, or `undefined` when the value holds no record. */
export function parseUnknownRecord(value: unknown): Record<string, unknown> | undefined {
    const parsed = UnknownRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}
