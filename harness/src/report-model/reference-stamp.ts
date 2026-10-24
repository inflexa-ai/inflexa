/**
 * The hash stamp of the land path, and the hash elision of the read.
 *
 * An artifact reference pins a path and a content hash. The pinned snapshot already maps each path onto
 * its hash, thus the author of a block gives the path alone. The stamp fills the hash from the snapshot,
 * and a reference that names the path lands.
 *
 * The stamp also drops a hash that a payload carries. The snapshot owns the value. Thus an echoed binding
 * and a mistyped one both land with the hash of the snapshot entry, and the structural tier reads no stale
 * pin on the land path.
 *
 * The walk is structural, because it runs before the grammar parse. It reads the artifact-reference shape
 * alone: a pinned kind and a string path. Every other value passes through untouched, thus a nested block,
 * a derivation input, and a plain field are all safe.
 *
 * A reference whose path the snapshot does not hold refuses here. Without this arm the parse refuses the
 * absent hash, and that message sends the author to the wrong repair.
 *
 * The elision walks the same shape in the other direction: a read of a landed block gives each binding
 * with no hash. Thus one module holds both directions, and the two agree on which object carries a pin.
 */

import { err, ok, type Result } from "neverthrow";

import type { AuthoredPinRecord, UnresolvedReference } from "../contracts/report-reference.js";
import type { DraftRefusal } from "./draft-operations.js";
import { snapshotEntry, type ReportSnapshot } from "./reference-resolver.js";

/**
 * The three reference kinds that name one artifact directly, thus the three kinds that take a hash. A kind
 * outside the set passes with no error, because the stamp fills a known kind and it never refuses one.
 */
type PinnedKind = "artifact-value" | "artifact-table" | "artifact-file";

/** One path-only reference whose path the snapshot does not hold, with the object that the author wrote. */
type MissingPin = {
    readonly path: string;
    readonly record: AuthoredPinRecord;
};

/**
 * Give the authored record of an object that takes a stamp, or `undefined` when the object takes none.
 *
 * The test reads the shape alone, because the payload reaches the stamp before the grammar parse. A hash
 * that the object carries decides nothing here, because the stamp writes the hash of the snapshot over it.
 * The copy the function returns is the refusal's view of the author's object: the walk still stamps and
 * returns the original, and the copy holds the same own enumerable fields, so the serialized refusal is
 * unchanged.
 */
function stampablePin(record: object): { path: string; record: AuthoredPinRecord } | undefined {
    if (!("kind" in record) || !("path" in record)) return undefined;
    const kind: unknown = record.kind;
    const path: unknown = record.path;
    const pinned: PinnedKind | undefined =
        kind === "artifact-value" ? "artifact-value" : kind === "artifact-table" ? "artifact-table" : kind === "artifact-file" ? "artifact-file" : undefined;
    if (pinned === undefined || typeof path !== "string") return undefined;
    return { path, record: { ...record, kind: pinned, path } };
}

/**
 * Put one own data property on a copy.
 *
 * A plain assignment at the key `__proto__` reaches the prototype setter, thus the copy loses an own key
 * that the payload carries. The definition makes an own data property for each key.
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Walk one value, and give the value with the hash of each artifact reference filled from the snapshot.
 *
 * The walk builds a copy on the changed path only. A branch that no stamp touched comes back as the same
 * reference, thus the input stays intact and the copy costs the size of the change.
 */
function stampValue(value: unknown, snapshot: ReportSnapshot, missing: MissingPin[]): unknown {
    if (Array.isArray(value)) {
        let changed = false;
        const next: unknown[] = [];
        for (const item of value) {
            const stamped = stampValue(item, snapshot, missing);
            if (stamped !== item) {
                changed = true;
            }
            next.push(stamped);
        }
        return changed ? next : value;
    }
    if (value === null || typeof value !== "object") {
        return value;
    }

    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        const held: unknown = Reflect.get(value, key);
        const stamped = stampValue(held, snapshot, missing);
        if (stamped !== held) {
            changed = true;
        }
        defineOwn(next, key, stamped);
    }

    const pin = stampablePin(value);
    if (pin === undefined) {
        return changed ? next : value;
    }
    const entry = snapshotEntry(snapshot, pin.path);
    if (entry === undefined) {
        missing.push({ path: pin.path, record: pin.record });
        return changed ? next : value;
    }
    return { ...next, hash: entry.hash };
}

/**
 * Stamp the hash of each artifact reference in a block payload, from the snapshot entry at its path.
 *
 * The membership read is `snapshotEntry`, because the path is author text. An own key alone counts, thus
 * an inherited member of a plain object reads as absent and the stamp agrees with the structural tier.
 *
 * The whole call refuses when one reference names a path that the snapshot does not hold. A partial stamp
 * beside a refusal would land nothing, thus the refusal carries every unknown path at one time and the
 * author repairs them together.
 */
export function stampReferenceHashes(payload: unknown, snapshot: ReportSnapshot): Result<unknown, DraftRefusal> {
    const missing: MissingPin[] = [];
    const stamped = stampValue(payload, snapshot, missing);
    if (missing.length === 0) {
        return ok(stamped);
    }
    const unresolved: UnresolvedReference[] = missing.map((pin) => ({
        // The payload reaches the stamp before the parse, thus the refusal carries the object as the
        // author wrote it, and the `AuthoredPinRecord` arm of `UnresolvedReferenceSchema` types it.
        reference: pin.record,
        reason: "artifact-missing",
        detail: `no artifact at ${pin.path}`,
    }));
    return err({
        reason: "unresolved-reference",
        detail: `the pinned evidence holds no artifact at ${missing.map((pin) => pin.path).join(", ")}`,
        unresolved,
    });
}

/**
 * Give one value with the stamped hash of each artifact reference removed.
 *
 * The snapshot owns the hash, thus a read that echoed one would give an agent a value to mistype. A binding
 * still gives its path and its locator, which are what an agent authored and what it changes.
 *
 * The walk builds a copy on the changed path only. A branch that carries no pin comes back as the same
 * reference. Thus the read costs the size of the pins, and never the size of the block.
 */
export function stripReferenceHashes(value: unknown): unknown {
    if (Array.isArray(value)) {
        let changed = false;
        const next: unknown[] = [];
        for (const item of value) {
            const stripped = stripReferenceHashes(item);
            if (stripped !== item) {
                changed = true;
            }
            next.push(stripped);
        }
        return changed ? next : value;
    }
    if (value === null || typeof value !== "object") {
        return value;
    }

    const pinned = stampablePin(value) !== undefined;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        if (pinned && key === "hash") {
            changed = true;
            continue;
        }
        const held: unknown = Reflect.get(value, key);
        const stripped = stripReferenceHashes(held);
        if (stripped !== held) {
            changed = true;
        }
        defineOwn(next, key, stripped);
    }
    return changed ? next : value;
}
