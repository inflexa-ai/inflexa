import { err, ok, type Result } from "neverthrow";
import type { ZodError, ZodType } from "zod";

/** Why `JSON.parseResult` refused a text: it is not JSON, or it is JSON of the wrong shape. */
export type JsonParseError = { type: "malformed"; cause: unknown } | { type: "mismatch"; error: ZodError };

declare global {
    interface JSON {
        /**
         * Parses raw JSON and validates it against a zod schema; null on either a
         * parse error or a schema mismatch, so callers can surface the raw
         * payload in their own typed errors. Mirrors JSON.parse's text-first arg
         * order, with the schema in place of a reviver.
         */
        parseWith<T>(raw: string, schema: ZodType<T>): T | null;

        /**
         * Parses raw JSON and validates it against a zod schema, and keeps the reason of a
         * failure: `malformed` carries the `SyntaxError`, `mismatch` carries the `ZodError`.
         * Only `JSON.parse` sits in the `try`. A throw from a refine or a transform of the
         * schema propagates, because it is a defect of the schema and not a property of the input.
         */
        parseResult<T>(raw: string, schema: ZodType<T>): Result<T, JsonParseError>;
    }
}

JSON.parseResult = function <T>(raw: string, schema: ZodType<T>): Result<T, JsonParseError> {
    let parsed: unknown; // unknown: external input, validated by the schema below
    try {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the one place that turns text into a value; each caller states its schema, and `parseResult` hands it to `safeParse`
        parsed = JSON.parse(raw);
    } catch (cause) {
        return err({ type: "malformed", cause });
    }
    const result = schema.safeParse(parsed);
    return result.success ? ok(result.data) : err({ type: "mismatch", error: result.error });
};

JSON.parseWith = function <T>(raw: string, schema: ZodType<T>): T | null {
    try {
        return JSON.parseResult(raw, schema).unwrapOr(null);
    } catch {
        // `parseResult` lets a throw from a refine or a transform propagate. This boundary has always
        // answered `null` for it, and its callers rely on `null` meaning "unusable".
        return null;
    }
};

export {};
