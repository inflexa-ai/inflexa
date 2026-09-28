/**
 * The mark of a block: its id on each element at the top of its markup. A text block has no container, thus
 * each of its paragraphs carries the mark, and a capture of the block reads the union of the marked boxes.
 */

/** The attribute that carries the block id. The capture of one block reads the same constant. */
export const BLOCK_ID_ATTRIBUTE = "data-block";

/** The mark of one block, for a spread onto each element at the top of its markup. */
export function blockMark(blockId: string): Record<string, string> {
    return { [BLOCK_ID_ATTRIBUTE]: blockId };
}
