import { z } from "zod";

/**
 * A JSON object read as a record of unknown values, for a walk that names no key in advance. A value that is
 * not a plain object (an array, a scalar, `null`) does not parse. Each value stays `unknown`, thus the caller
 * checks the keys that it reads.
 */
export const unknownRecordSchema = z.record(z.string(), z.unknown());

/** A JSON object as a record, or an empty record for an absent value or a value of another kind: a config write keeps the keys that it finds and starts clean otherwise. */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
    const parsed = unknownRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : {};
}
