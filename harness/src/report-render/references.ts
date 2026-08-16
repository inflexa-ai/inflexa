/**
 * The reference ledger state.
 *
 * A claim binds to evidence, and a citation block points at an external source. The ledger collects each
 * reference in first-appearance order, and it gives one bracket number to each distinct reference. Every
 * marker of the page reads from this one ladder, thus a reference that two blocks share gets one number and
 * one appendix entry.
 *
 * One ladder holds both kinds. A reader of a report follows one notation, and the appendix lists flat in
 * number order. Two ladders give one page two notations, and a reader must then learn which marker points
 * at which list.
 *
 * The identity of a reference depends on its kind. An artifact identity is the canonical serialization of
 * the reference: `serializeReference` sorts the keys at every depth, thus two references match only when
 * every field matches, and two locators of one file stay apart. A citation identity is the citation key
 * alone, because the key names the paper and the display text is authored beside it.
 *
 * The two identity forms cannot collide. A serialization is a JSON object, and a citation key is the
 * prefixed `idKind:id` text. Thus one map holds both.
 */

import { serializeReference, type CitationReference, type Reference } from "../contracts/report-reference.js";

/** The citation key of one citation reference, in the prefixed `idKind:id` form. */
export function citationKeyOf(reference: CitationReference): string {
    return `${reference.idKind}:${reference.id}`;
}

/** One source of a derivation: the pinned path that the script read, and the content hash of those bytes. */
export interface DerivationChainSource {
    readonly path: string;
    readonly hash: string;
}

/**
 * The chain of one derived path: the sources that the script read, and the hash of the script itself.
 *
 * The renderer declares the shape that the appendix reads, and never the durable record that carries it.
 * Thus a caller passes the stored records straight through, and the render stays a pure function of plain
 * data.
 *
 * The two sources are the links of the chain, and both are optional. `scriptSource` is the relative source
 * of the staged script asset, and `outputSource` is the relative source of the derived file. The caller
 * stages the script and it knows where the derived file sits, thus the caller states both and the renderer
 * reads no disk. A chain that carries neither renders its hashes alone.
 */
export interface DerivationChain {
    readonly outputPath: string;
    readonly sources: readonly DerivationChainSource[];
    readonly scriptHash: string;
    readonly scriptSource?: string;
    readonly outputSource?: string;
}

/** The chain of each derived path of one render, keyed by the output path that the bindings name. */
export type DerivationChains = ReadonlyMap<string, DerivationChain>;

/**
 * Key each chain by its output path.
 *
 * The appendix reads one chain for one path, thus the map is the read form of the list. A repeated output
 * path keeps the first record, because the durable list refuses a repeated path and a second one carries no
 * new meaning.
 */
export function derivationChains(records: readonly DerivationChain[] | undefined): DerivationChains {
    const chains = new Map<string, DerivationChain>();
    for (const record of records ?? []) {
        if (!chains.has(record.outputPath)) {
            chains.set(record.outputPath, record);
        }
    }
    return chains;
}

/**
 * Each reference kind that names data, which is every kind except a citation.
 *
 * A derivation joins this set, because it computes over pinned artifacts and it names no paper.
 */
export type ArtifactReference = Exclude<Reference, CitationReference>;

/**
 * The mutable ledger of references.
 *
 * The page walk makes one ledger, and it threads the ledger through each claim, each card, and each
 * citation. The order of the entries is the order of the first mark, thus the marker numbers count up by
 * first appearance across the whole page.
 */
export class ReferenceLedger {
    private readonly references: Reference[] = [];
    private readonly marks = new Map<string, number>();

    /**
     * Give the marker number of a reference. A new reference gets the next number of the ladder, and it
     * joins the order of the ladder. A reference that matches an earlier one gives the earlier number, thus
     * the appendix holds it one time.
     *
     * A citation matches on its key alone. The `raw` text and the display fields of a citation are the
     * words of the author, and two blocks over one paper carry different words. The key names the paper,
     * thus one paper takes one number and the appendix holds it one time.
     */
    mark(reference: Reference): number {
        const key = reference.kind === "citation" ? citationKeyOf(reference) : serializeReference(reference);
        const seen = this.marks.get(key);
        if (seen !== undefined) {
            return seen;
        }
        // `push` gives back the new length of the array, which is the number of the entry that it added.
        const n = this.references.push(reference);
        this.marks.set(key, n);
        return n;
    }

    /** Every reference in first-appearance order. The marker of an entry is its position plus one. */
    entries(): readonly Reference[] {
        return this.references;
    }
}
