/**
 * The one hash of a draft document.
 *
 * The look-before-record rule rides two durable markers, and each marker holds a hash of the draft. A
 * stamp writes a hash, and a compare reads one. Both call this one function, thus two serializations of one
 * document cannot split.
 *
 * The function serializes the draft with sorted object keys, and it hashes the text with sha256. The sort
 * makes the hash independent of key order. Thus two objects with the same values and a different key order
 * give one hash, and a marker survives a round trip through storage.
 */

import { createHash } from "node:crypto";

import type { DraftDocument } from "./draft.js";

/**
 * Give back a copy of a value with each object key in sorted order, at every depth.
 *
 * An array keeps its order, because the order of an array is data. An object gets its keys in one canonical
 * order, thus the serialization does not depend on the order that a producer wrote the keys.
 */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

/** The sha256 hash of the draft, over a JSON serialization with sorted keys. */
export function computeDraftHash(document: DraftDocument): string {
    const canonical = JSON.stringify(canonicalize(document));
    return createHash("sha256").update(canonical).digest("hex");
}
