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
 * Each ladder holds its own identity. A provenance identity is the canonical serialization of the
 * reference: `serializeReference` sorts the keys at every depth, thus two references match only when every
 * field matches, and two locators of one file stay apart. A citation identity is the citation key alone,
 * because the key names the paper and the display text is authored beside it.
 */

import { serializeReference, type CitationReference, type Reference } from "../contracts/report-reference.js";

/** The citation key of one citation reference, in the prefixed `idKind:id` form. */
export function citationKeyOf(reference: CitationReference): string {
    return `${reference.idKind}:${reference.id}`;
}

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
    private readonly provenanceMarks = new Map<string, ReferenceMark>();
    private readonly citationMarks = new Map<string, ReferenceMark>();

    /**
     * Give the mark of a reference. A new reference gets the next number of its ladder, and it joins the
     * order of that ladder. A reference that matches an earlier one gives the earlier mark, thus the list
     * holds it one time.
     *
     * A citation matches on its key alone. The `raw` text and the display fields of a citation are the
     * words of the author, and two blocks over one paper carry different words. The key names the paper,
     * thus one paper takes one number and the bibliography holds it one time.
     */
    mark(reference: Reference): ReferenceMark {
        // `push` gives back the new length of the array, which is the number of the entry that it added.
        if (reference.kind === "citation") {
            const key = citationKeyOf(reference);
            const seen = this.citationMarks.get(key);
            if (seen !== undefined) {
                return seen;
            }
            const mark: ReferenceMark = { ladder: "citation", n: this.citations.push(reference) };
            this.citationMarks.set(key, mark);
            return mark;
        }
        const key = serializeReference(reference);
        const seen = this.provenanceMarks.get(key);
        if (seen !== undefined) {
            return seen;
        }
        const mark: ReferenceMark = { ladder: "provenance", n: this.provenance.push(reference) };
        this.provenanceMarks.set(key, mark);
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
