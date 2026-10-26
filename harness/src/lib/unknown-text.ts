/**
 * The text form of a value whose type stopped at `unknown`: a string stays
 * itself, each primitive keeps its `String` render — a missing value names
 * itself as `null` / `undefined`, the `String` form the diagnostic fields
 * read — and a record or array renders as JSON, so no object reaches a message
 * as `[object Object]`.
 */

function jsonTextOf(value: object): string {
    let json: string | undefined;
    try {
        json = JSON.stringify(value);
    } catch {
        // A cycle or a bigint inside the value throws here.
    }
    // `toJSON` giving `undefined` stringifies to `undefined` rather than throwing; both
    // non-strings fall to the default object stringification, the render `String` gives.
    return json ?? Object.prototype.toString.call(value);
}

export function textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") return String(value);
    if (typeof value === "function") return String(value);
    return value === undefined || value === null ? String(value) : jsonTextOf(value);
}
