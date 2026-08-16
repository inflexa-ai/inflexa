/**
 * The reference ledger state.
 *
 * A claim binds to evidence, and a citation block points at an external source. The ledger collects each
 * reference in first-appearance order, and it gives one marker number to each distinct reference. A claim
 * marker and a citation marker read from the same ledger, thus one reference that two blocks share gets
 * one number and one list entry.
 *
 * The ledger holds two ladders. A citation reference numbers in the citation ladder, and every other
 * reference numbers in the provenance ladder. Thus the prose footnotes point at the provenance appendix,
 * the bracket markers point at the bibliography, and a page reads the way that a paper reads.
 *
 * Identity is the canonical serialization of the reference. `serializeReference` sorts the keys at every
 * depth, thus two references match only when every field matches. The key order of the source object does
 * not change the identity.
 */

import { serializeReference, type CitationReference, type Reference } from "../contracts/report-reference.js";

/** The two ladders of a page: the numeric footnote ladder, and the bracket ladder of the literature. */
export type ReferenceLadder = "provenance" | "citation";

/** Each reference kind that the provenance ladder holds, which is every kind except a citation. */
export type ProvenanceReference = Exclude<Reference, CitationReference>;

/** One marked reference: the ladder that holds it, and its number inside that ladder. */
export interface ReferenceMark {
    ladder: ReferenceLadder;
    n: number;
}

/**
 * The mutable ledger of references.
 *
 * The page walk makes one ledger, and it threads the ledger through each claim and each citation. The
 * order of the entries of a ladder is the order of the first mark, thus the marker numbers count up by
 * first appearance inside that ladder.
 */
export class ReferenceLedger {
    private readonly provenance: ProvenanceReference[] = [];
    private readonly citations: CitationReference[] = [];
    private readonly marks = new Map<string, ReferenceMark>();

    /**
     * Give the mark of a reference. A new reference gets the next number of its ladder, and it joins the
     * order of that ladder. A reference that matches an earlier one gives the earlier mark, thus the list
     * holds it one time.
     */
    mark(reference: Reference): ReferenceMark {
        const key = serializeReference(reference);
        const seen = this.marks.get(key);
        if (seen !== undefined) {
            return seen;
        }
        // `push` gives back the new length of the array, which is the number of the entry that it added.
        const mark: ReferenceMark =
            reference.kind === "citation"
                ? { ladder: "citation", n: this.citations.push(reference) }
                : { ladder: "provenance", n: this.provenance.push(reference) };
        this.marks.set(key, mark);
        return mark;
    }

    /** The provenance references in first-appearance order. The marker of an entry is its position plus one. */
    provenanceEntries(): readonly ProvenanceReference[] {
        return this.provenance;
    }

    /** The citation references in first-appearance order. The marker of an entry is its position plus one. */
    citationEntries(): readonly CitationReference[] {
        return this.citations;
    }
}
