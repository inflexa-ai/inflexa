/**
 * The read-back surface of a draft.
 *
 * The agent holds the outline as its working view. The outline gives one entry for each block: the id,
 * the kind, the nesting depth, and a short label. It carries no binding and no full prose. Thus the full
 * tree stays out of the agent context.
 *
 * A read of one block by its id gives the full block. The agent pulls a block only when it needs one.
 */

import type { DraftBlock, DraftDocument } from "./draft.js";

/** The label keeps a prose head of at most this many characters. A longer head loses its tail. */
const PROSE_CLIP = 80;

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
 * The short label of one block.
 *
 * A section, a metric, a table, and a chart give a titled name. A figure and a citation give a caption or
 * a note. A text and a claim carry prose, which can be long, thus each gives a clipped head and never the
 * whole prose. A block with an absent optional field gives an empty label.
 */
function labelOf(block: DraftBlock): string {
    switch (block.kind) {
        case "section":
            return block.title;
        case "metric":
            return block.label;
        case "table":
            return block.title ?? "";
        case "chart":
            return block.title ?? "";
        case "figure":
            return block.caption ?? "";
        case "citation":
            return block.note ?? "";
        case "text":
            return block.content.prose.slice(0, PROSE_CLIP);
        case "claim":
            return block.content.prose.slice(0, PROSE_CLIP);
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
 * Read one block by its id. The result is the block as it is, with its bindings, and, for a section, its
 * children. A block that no id holds gives `undefined`.
 */
export function readBlock(draft: DraftDocument, id: string): DraftBlock | undefined {
    const find = (block: DraftBlock): DraftBlock | undefined => {
        if (block.id === id) {
            return block;
        }
        if (block.kind === "section") {
            for (const child of block.blocks) {
                const found = find(child);
                if (found !== undefined) {
                    return found;
                }
            }
        }
        return undefined;
    };
    for (const section of draft.sections) {
        const found = find(section);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
}
