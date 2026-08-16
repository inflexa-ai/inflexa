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

import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";
import type { DraftRefusal } from "./draft-operations.js";
import { snapshotEntry, type ReportSnapshot } from "./reference-resolver.js";

/**
 * The three reference kinds that name one artifact directly, thus the three kinds that take a hash.
 *
 * The `satisfies` clause ties each literal to a member of the reference union. A renamed kind becomes a
 * compile error here. A new kind passes with no error, because the stamp fills a known kind and it never
 * refuses one.
 */
const PINNED_KINDS: ReadonlySet<string> = new Set(["artifact-value", "artifact-table", "artifact-file"] satisfies readonly Reference["kind"][]);

/** One path-only reference whose path the snapshot does not hold, with the object that the author wrote. */
interface MissingPin {
    readonly path: string;
    readonly record: Record<string, unknown>;
}

/** Give `true` when an object carries an artifact pin. Such an object takes a stamp, and a read removes its hash. */
function holdsPin(record: Record<string, unknown>): boolean {
    const { kind } = record;
    return typeof kind === "string" && PINNED_KINDS.has(kind);
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
 * Give the artifact path of an object that takes a stamp, or `undefined` when the object takes none.
 *
 * The test reads the shape alone, because the payload reaches the stamp before the grammar parse. A hash
 * that the object carries decides nothing here, because the stamp writes the hash of the snapshot over it.
 */
function stampablePath(record: Record<string, unknown>): string | undefined {
    const { path } = record;
    if (!holdsPin(record) || typeof path !== "string") {
        return undefined;
    }
    return path;
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

    const record = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        const stamped = stampValue(record[key], snapshot, missing);
        if (stamped !== record[key]) {
            changed = true;
        }
        defineOwn(next, key, stamped);
    }

    const path = stampablePath(record);
    if (path === undefined) {
        return changed ? next : value;
    }
    const entry = snapshotEntry(snapshot, path);
    if (entry === undefined) {
        missing.push({ path, record });
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
        // The payload reaches the stamp before the parse, thus the object holds the fields of a reference
        // as the author wrote them. The refusal names that object, and this assertion is the one place
        // where the pre-parse shape enters the parsed reference type.
        reference: pin.record as unknown as Reference,
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

    const record = value as Record<string, unknown>;
    const pinned = holdsPin(record);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        if (pinned && key === "hash") {
            changed = true;
            continue;
        }
        const stripped = stripReferenceHashes(record[key]);
        if (stripped !== record[key]) {
            changed = true;
        }
        defineOwn(next, key, stripped);
    }
    return changed ? next : value;
}
