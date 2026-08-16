/**
 * The read-back surface of a draft.
 *
 * The agent holds the outline as its primary view. The outline gives one entry for each block: the id,
 * the kind, the nesting depth, and a short label. It carries no binding and no full prose. Thus the full
 * tree stays out of the agent context.
 *
 * A read of one block by its id gives the full block. The agent pulls a block only when it needs one. A
 * section gives its own fields and the ids of its children, and never the subtree. The outline already
 * names every descendant, thus a subtree here would return the whole tree that the outline exists to keep
 * out.
 */

import type { AtomBlock } from "../contracts/report-blocks.js";
import { locate } from "./draft-operations.js";
import type { DraftBlock, DraftDocument } from "./draft.js";

/** The label keeps a prose head of at most this many code points. A clipped label ends with the marker. */
const PROSE_CLIP = 80;

/** The marker that a clipped label ends with. It counts toward `PROSE_CLIP`. */
const CLIP_MARKER = "…";

/**
 * One outline entry. It carries the id, the kind, the nesting depth, and a short label. A top-level
 * section is depth 0. The entry carries no binding, thus the outline stays small.
 */
export interface OutlineEntry {
    id: string;
    kind: DraftBlock["kind"];
    depth: number;
    label: string;
}

/**
 * A section as the read surface gives it: its own fields, and the id of each child in document order.
 *
 * The children stay out. A section carries no field that the outline does not already give, thus the
 * subtree would be a second copy of the outline, and a read of a top-level section would return the whole
 * draft.
 */
export interface ShallowSection {
    kind: "section";
    id: string;
    title: string;
    childIds: string[];
}

/** One block as the read surface gives it. An atom reads in full, and a section reads shallow. */
export type ReadableBlock = AtomBlock | ShallowSection;

/**
 * Clip a label to `PROSE_CLIP` code points, and mark a clipped label.
 *
 * The cut counts code points and not UTF-16 units, because a cut at a fixed index splits a surrogate pair
 * whenever an astral character straddles the boundary. A lone surrogate has no UTF-8 encoding, thus the
 * agent would read a replacement character in place of the character the author wrote.
 *
 * A clipped label carries the marker, because a bare head and a whole short label read the same. Without
 * the marker the agent cannot tell whether the prose ends there, and it acts on a truncated claim as if it
 * were the whole one.
 */
function clip(text: string): string {
    const points = [...text];
    if (points.length <= PROSE_CLIP) {
        return text;
    }
    return `${points.slice(0, PROSE_CLIP - CLIP_MARKER.length).join("")}${CLIP_MARKER}`;
}

/**
 * The short label of one block.
 *
 * A section, a metric, a table, and a chart give a titled name. A figure and a citation give a caption or
 * a note. A text and a claim carry prose. Every one of them clips: a caption, a note, and a title are free
 * prose too, thus an unclipped arm would put a paragraph into each outline that names the block.
 *
 * A text block carries its enumeration in the list, and the lead sentences above it can be empty. Such a
 * block gives the first item, thus the outline names it and the agent reads which block it is.
 *
 * A block with an absent optional field gives an empty label.
 */
function labelOf(block: DraftBlock): string {
    switch (block.kind) {
        case "section":
            return clip(block.title);
        case "metric":
            return clip(block.label);
        case "table":
            return clip(block.title ?? "");
        case "chart":
            return clip(block.title ?? "");
        case "figure":
            return clip(block.caption ?? "");
        case "citation":
            return clip(block.note ?? "");
        case "text": {
            const prose = block.content.prose;
            if (prose.trim().length > 0) {
                return clip(prose);
            }
            // An item passes the grammar with one space in it, thus the first item can name nothing. The
            // walk takes the first item that holds text, and a list of blank items gives an empty label.
            return clip(block.content.list?.items.find((item) => item.trim().length > 0) ?? "");
        }
        case "claim":
            return clip(block.content.prose);
    }
}

/**
 * Build the outline of a draft. The walk is pre-order, thus the entries follow the document order. A
 * section comes before its children, and a child sits one depth deeper than its parent.
 */
export function buildOutline(draft: DraftDocument): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    const visit = (block: DraftBlock, depth: number): void => {
        entries.push({ id: block.id, kind: block.kind, depth, label: labelOf(block) });
        if (block.kind === "section") {
            for (const child of block.blocks) {
                visit(child, depth + 1);
            }
        }
    };
    for (const section of draft.sections) {
        visit(section, 0);
    }
    return entries;
}

/**
 * Build the outline of one container: an entry for each direct child, and nothing deeper.
 *
 * A landed operation reports the container that it changed, and the whole outline would grow the context
 * by the size of the draft on every call. The child order is what the agent cannot know on its own, and a
 * descendant did not move, thus one level answers the question that a landing raises.
 *
 * `depth` is the depth of the children, thus the entries read the same as the entries of a full outline.
 */
export function childOutline(blocks: readonly DraftBlock[], depth: number): OutlineEntry[] {
    return blocks.map((block) => ({ id: block.id, kind: block.kind, depth, label: labelOf(block) }));
}

/**
 * Read one block by its id. An atom gives the block as it is, with its bindings. A section gives its own
 * fields and the id of each child. A block that no id holds gives `undefined`.
 */
export function readBlock(draft: DraftDocument, id: string): ReadableBlock | undefined {
    const found = locate(draft, id)?.block;
    if (found === undefined) {
        return undefined;
    }
    if (found.kind === "section") {
        return { kind: "section", id: found.id, title: found.title, childIds: found.blocks.map((child) => child.id) };
    }
    return found;
}
