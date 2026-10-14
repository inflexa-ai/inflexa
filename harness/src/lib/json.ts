import type { ZodType } from "zod";

/**
 * Decode a JSON string and prove its shape with a schema.
 */
export function jsonParse<T>(text: string, schema: ZodType<T>): T {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the single JSON decode of the package: zod 4.4.3 exports no schema that decodes a JSON string, and the schema proves the decoded value.
    const value: unknown = JSON.parse(text);
    return schema.parse(value);
}

/**
 * Decode a JSON string and give back `undefined` when the text is malformed.
 * The caller proves the value with its own schema or guard and maps malformed
 * text to its own fallback; a throwing schema parse would collapse a syntax
 * failure into a schema failure and change that fallback.
 */
export function parseJsonOrUndefined(text: string): unknown {
    try {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the syntax-only decode: the caller owns the schema and the fallback, so the parse here must throw on nothing.
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Clone a value through the JSON wire shape: a member whose value is `undefined`
 * is dropped and a `Date` becomes a string, exactly what a JSON round trip keeps.
 * `structuredClone` keeps both, so it cannot stand in for a wire-shaped clone.
 */
export function jsonClone<T>(value: T, revive?: (key: string, value: unknown) => unknown): T {
    // SAFETY: the text came from JSON.stringify of the same value, so the decode gives back the wire shape of `T` and nothing wider.
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the clone must keep the JSON wire shape, which no builtin clone does; the schema-free decode is sound because the text came from JSON.stringify of the same value.
    return JSON.parse(JSON.stringify(value), revive);
}
