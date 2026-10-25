/**
 * Strip each `<...>` run to its first closing bracket. One pass already
 * reaches the fixpoint: a span's interior holds no `>`, so a removal cannot
 * form a new `<...>` pair.
 */
export function stripHtmlTags(text: string): string {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- an HTML tag run to the first closing bracket; a quoted `>` inside an attribute is deliberately not seen.
    return text.replace(/<[^>]+>/g, "");
}
