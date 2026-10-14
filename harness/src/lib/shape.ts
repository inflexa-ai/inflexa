/**
 * Runtime narrows for values whose shape the static types cannot prove: XML
 * rendered to JSON, chart options, JSON off the wire. Each helper performs the
 * check it claims, so a malformed payload is caught at the boundary that read it
 * instead of surfacing as `undefined` at a property access far from the cause.
 */

/** Whether the value is a non-null object, read as the string-keyed record the XML/JSON navigations walk. */
function isRecord(value: unknown): value is Record<string, unknown> {
    // SAFETY: the predicate claims exactly the set the `typeof`/`null` tests accept, and it must stay that way.
    return typeof value === "object" && value !== null;
}

/** An object narrowed from `unknown`, or `undefined` for `null` and primitives. */
export function maybeRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

/** The member of `container` narrowed to an object, or `undefined` when absent, `null`, or a primitive. */
export function recordMember(container: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
    return maybeRecord(container?.[key]);
}

/**
 * The member at `key` with the `undefined` a missing key returns at runtime.
 * The index-signature read without `noUncheckedIndexedAccess` claims the member
 * is always present, so a guard on the direct read reads as dead to the linter.
 */
export function typedMember<T>(record: Record<string, T>, key: string): T | undefined {
    return record[key];
}

/**
 * The member at `key` admitting the `null` and `undefined` an index read can
 * return at runtime, for rows whose declared type promises a value per key.
 */
export function wideMember<T>(record: Record<string, T>, key: string): T | null | undefined {
    const value: T | null | undefined = record[key];
    return value;
}
