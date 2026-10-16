/** Split text into lines, accepting CRLF and LF endings. */
export function splitLines(text: string): string[] {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the grammar of line endings: CRLF and LF, which no string-method split separates in one call.
    return text.split(/\r?\n/);
}
