/**
 * The lineage keys of a grounded block, and the control that opens the chain of one key.
 *
 * A grounded block stamps its identity into the markup: the block id, and one key for each reference that
 * it binds, in marker order. The page script reads the stamp when a reader clicks a control. Thus the
 * markup is the one contract between the renderer and the script, and neither side holds a copy of the
 * other.
 *
 * A key is a pin or an external record. A pin names one immutable file by `path` and `hash`, and the walk
 * resolves the node of those bytes. A citation names a paper, which no data chain reaches, thus its key
 * carries the identity of the record instead.
 *
 * A reference that pins no single file gives no key. A derivation computes over two inputs, thus it names
 * no file of its own and the marker of such a reference carries no control.
 *
 * The stamp is empty while the page carries no provenance document. Thus such a page holds no lineage
 * attribute, no control, and the markup that it held before the stamp existed.
 *
 * The module also declares `ViewOptions`. Each view of the page reads that bag, and the lineage condition
 * is the one truth that it holds today.
 */

import type { Reference } from "../../contracts/report-reference.js";

/**
 * The page-wide truths of one render.
 *
 * A truth of this kind is constant across the whole page, thus each view of one page decides it alike. The
 * bag threads one time through the view layer. Thus the next truth joins this interface, and no view
 * signature grows one more parameter for it.
 *
 * `lineage` states that the page carries a provenance document. Each grounded block then stamps its keys
 * and shows its control, and a page with no document carries neither.
 */
export interface ViewOptions {
    readonly lineage: boolean;
}

/**
 * The options that a view takes when the caller gives none. Each truth is off, thus the view renders its
 * plain form.
 */
export const DEFAULT_VIEW_OPTIONS: ViewOptions = { lineage: false };

/** The attribute that names the block of one stamp. The page script reads the same name. */
export const LINEAGE_BLOCK_ATTRIBUTE = "data-lineage-block";

/** The attribute that carries the keys of one stamp, as a JSON array in marker order. */
export const LINEAGE_KEYS_ATTRIBUTE = "data-lineage-keys";

/** The attribute of one control: the place of its key in the key list of the block. */
export const LINEAGE_KEY_ATTRIBUTE = "data-lineage-key";

/** The class of the control that opens the chain of one reference. */
export const LINEAGE_CONTROL_CLASS = "report-lineage";

/** The name of the control for a reader who hears the page instead of seeing it. */
const LINEAGE_CONTROL_LABEL = "Show the lineage of this reference";

/** The class of the glyph inside the control. The design sheet holds the matching rule. */
const LINEAGE_GLYPH_CLASS = "report-lineage-glyph";

/**
 * The glyph of the control: a branch of three nodes on the 16px grid.
 *
 * The drawing reads as a chain that divides, which is what the panel behind it shows. A text glyph reads
 * as a disclosure of more prose, and a bracket form would give the page two notations that look alike and
 * mean different things.
 *
 * The stroke takes the current color, thus the muted color of the button and its primary color on hover
 * both reach the drawing and the sheet holds one color for the two states. The glyph is decoration, thus
 * it hides from a reader who hears the page and the label of the button answers instead.
 */
function LineageGlyph() {
    return (
        <svg class={LINEAGE_GLYPH_CLASS} width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="4" cy="4" r="2" />
            <circle cx="4" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <path d="M4 6v4" />
            <path d="M6 12h4" />
            <path d="M12 10V8a4 4 0 0 0-4-4H6" />
        </svg>
    );
}

/** The pin of one artifact: the analysis-relative path, and the content hash of the bytes. */
export interface LineagePin {
    readonly path: string;
    readonly hash: string;
}

/** The identity of one external record: the identifier space, and the identifier inside it. */
export interface LineageRecord {
    readonly idKind: string;
    readonly id: string;
}

/** One key of a stamp. A reference that pins no single file gives `null` in place of a key. */
export type LineageKey = LineagePin | LineageRecord;

/**
 * The key of one reference, or `null` where the reference pins no single file.
 *
 * A derivation is the one artifact-side kind that gives `null`. It computes over two inputs, thus the
 * document holds no node of its own bytes and one pin cannot address it.
 */
export function lineageKeyOf(reference: Reference): LineageKey | null {
    switch (reference.kind) {
        case "citation":
            return { idKind: reference.idKind, id: reference.id };
        case "derivation":
            return null;
        default:
            return { path: reference.path, hash: reference.hash };
    }
}

/**
 * The stamp attributes of one block, or an empty object while the page carries no provenance.
 *
 * The caller spreads the result onto the container element of the block. Thus a page with no provenance
 * emits no attribute at all, and the spread is the one place that decides it.
 *
 * The key list keeps one entry for each binding, in marker order. Thus the place of a control indexes the
 * bindings directly, and a binding that gives no key keeps its place as `null`.
 */
export function lineageStamp(on: boolean, blockId: string, references: readonly Reference[]): Record<string, string> {
    if (!on) {
        return {};
    }
    // The JSON rides an attribute value, and the markup runtime escapes each attribute value. Thus a
    // hostile path reaches the page as text and it cannot leave its slot.
    return {
        [LINEAGE_BLOCK_ATTRIBUTE]: blockId,
        [LINEAGE_KEYS_ATTRIBUTE]: JSON.stringify(references.map(lineageKeyOf)),
    };
}

/**
 * The place of the control of one reference, or `undefined` where the page carries no provenance or the
 * reference pins nothing.
 *
 * A block that binds one reference passes no index, because its one key sits at the first place.
 */
export function lineagePlace(on: boolean, reference: Reference, index = 0): number | undefined {
    return on && lineageKeyOf(reference) !== null ? index : undefined;
}

/**
 * The control beside one marker. A click opens the chain of the key that sits at `place`.
 *
 * The control names its place and never its key. The stamp of the block holds the keys, thus one page
 * carries one copy of each key and a claim of several bindings repeats none of them.
 */
export function LineageControl({ place }: { place: number }) {
    return (
        <button
            type="button"
            class={LINEAGE_CONTROL_CLASS}
            aria-label={LINEAGE_CONTROL_LABEL}
            aria-expanded="false"
            {...{ [LINEAGE_KEY_ATTRIBUTE]: String(place) }}
        >
            <LineageGlyph />
        </button>
    );
}
