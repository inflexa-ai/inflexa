/**
 * The escape helpers for the page.
 *
 * Every interpolated string on the page passes through one of these two helpers, with no exception.
 * `escapeHtml` guards element content. `escapeAttr` guards an attribute value. The renderer owns the
 * escape, thus agent prose reaches the page as text and never as an element.
 *
 * The escape is single-pass. The helper escapes each source character one time, and it does not detect an
 * existing entity. Thus an input `&amp;` becomes `&amp;amp;`. This rule is simple and total, and every
 * prose slot on the page holds raw text before it enters a helper.
 */

/** The element-content entities: the three characters that can open or close a tag. */
const HTML_ENTITIES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
};

/** The attribute-value entities: the element-content set plus the two quote characters. */
const ATTR_ENTITIES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** Escape element content. The helper replaces `&`, `<`, and `>`. */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>]/g, (character) => HTML_ENTITIES[character]);
}

/** Escape an attribute value. The helper replaces `&`, `<`, `>`, `"`, and `'`. */
export function escapeAttr(text: string): string {
    return text.replace(/[&<>"']/g, (character) => ATTR_ENTITIES[character]);
}
