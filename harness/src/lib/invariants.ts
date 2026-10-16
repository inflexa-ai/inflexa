/**
 * Hands a caller a value that an input schema's refinements have already
 * guaranteed. The throw names the violated contract instead of surfacing as a
 * `TypeError` at the first property access.
 */
export function guaranteed<T>(value: T | undefined, field: string): T {
    if (value === undefined) throw new Error(`the input schema must supply ${field}`);
    return value;
}

/**
 * Hands a caller a value read from a map keyed by the very collection being
 * iterated, so a miss is an internal defect; the throw makes it loud instead of
 * silently dropping a member.
 */
export function present<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`internal error: missing ${what}`);
    return value;
}
