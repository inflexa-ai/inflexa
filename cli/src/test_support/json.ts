import type { ZodType } from "zod";

import { describeCause } from "../lib/cause.ts";

/**
 * Parses the JSON `text` of a test and gives the value that `schema` proved. A text that is not JSON throws an
 * `Error` with the parse message, and a value of the wrong shape throws the `ZodError`. A test that asserts on
 * the whole value passes `z.json()`, which accepts each JSON value.
 */
export function parsedJson<T>(text: string, schema: ZodType<T>): T {
    const result = JSON.parseResult(text, schema);
    if (result.isOk()) return result.value;
    if (result.error.type === "malformed") throw new Error(`malformed JSON: ${describeCause(result.error.cause)}`);
    throw result.error.error;
}
