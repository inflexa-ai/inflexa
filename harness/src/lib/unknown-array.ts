/**
 * A type predicate over a value no parser has shaped yet. `Array.isArray`
 * alone narrows `unknown` to `any[]`; this guard yields `unknown[]`, so each
 * element must narrow before use.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}
