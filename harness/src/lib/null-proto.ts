/**
 * A record with a null prototype, for maps whose keys come from outside the
 * process (stored snapshots, ledger paths). A key such as `__proto__` stays an
 * ordinary entry and never reaches a prototype slot, on writes and on reads.
 */
export function nullProtoRecord<T>(): Record<string, T> {
    const created: unknown = Object.create(null);
    // Object.create(null) always yields an object, so the guard never refuses;
    // it moves the parser's `any` out of the returned record. The empty record
    // holds no member, so it is a `Record<string, T>` for every `T`.
    if (!isRecordOf<T>(created)) throw new Error("Object.create(null) did not yield an object");
    return created;
}

function isRecordOf<T>(value: unknown): value is Record<string, T> {
    return typeof value === "object" && value !== null;
}
