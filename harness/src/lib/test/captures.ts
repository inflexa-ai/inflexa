/**
 * Honest reads of a `RegExp` match's capture groups, for test assertions that
 * walk matches of a grammar they own.
 */

/**
 * The capture group at `index`, with the `undefined` an unmatched group returns
 * at runtime: the `RegExpMatchArray` index type claims `string` for every group.
 */
export function captureOf(match: RegExpMatchArray, index: number): string | undefined {
    return match[index];
}
