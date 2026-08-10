/**
 * The reference ledger state.
 *
 * A claim binds to evidence, and a citation block points at an external source. The ledger collects each
 * reference in first-appearance order, and it gives one marker number to each distinct reference. A claim
 * marker and a citation marker read from the same ledger, thus one reference that two blocks share gets
 * one number and one list entry.
 *
 * Identity is the canonical serialization of the reference. `serializeReference` sorts the keys at every
 * depth, thus two references match only when every field matches. The key order of the source object does
 * not change the identity.
 */

import { serializeReference, type Reference } from "../contracts/report-reference.js";

/**
 * The mutable ledger of references.
 *
 * The page walk makes one ledger, and it threads the ledger through each claim and each citation. The
 * order of the entries is the order of the first mark, thus the marker numbers count up by first
 * appearance.
 */
export class ReferenceLedger {
    private readonly order: Reference[] = [];
    private readonly markers = new Map<string, number>();

    /**
     * Give the marker number of a reference. A new reference gets the next number, and it joins the
     * order. A reference that matches an earlier one gives the earlier number, thus the list holds it one
     * time.
     */
    mark(reference: Reference): number {
        const key = serializeReference(reference);
        const seen = this.markers.get(key);
        if (seen !== undefined) {
            return seen;
        }
        const marker = this.order.length + 1;
        this.markers.set(key, marker);
        this.order.push(reference);
        return marker;
    }

    /** The references in first-appearance order. The marker of an entry is its position plus one. */
    entries(): readonly Reference[] {
        return this.order;
    }
}
