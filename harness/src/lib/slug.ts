/**
 * The shared lowercase slug: each run of characters outside `[a-z0-9]` becomes one dash.
 *
 * The harness hand-rolled this loop in six places with small policy differences at each site. The helper
 * holds the loop alone; each caller states its own cap and its own empty-result fallback beside the call.
 */

export type SlugifyOpts = {
    /**
     * The result never passes this length: the loop stops before the append that would cross it, and a
     * final slice removes a dash that a two-character append straddled. A stop before an append cannot
     * change the first characters of the result, because an append only extends the prefix.
     */
    maxLength?: number;
    /** The result for an input with no slug character. Without a fallback the empty result stays empty. */
    fallback?: string;
};

export function slugify(value: string, opts: SlugifyOpts = {}): string {
    const { maxLength, fallback } = opts;
    let out = "";
    let inRun = false;
    for (const char of value.toLowerCase()) {
        if (maxLength !== undefined && out.length >= maxLength) break;
        const isSlugChar = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
        if (!isSlugChar) {
            inRun = true;
            continue;
        }
        if (inRun && out.length > 0) out += "-";
        inRun = false;
        out += char;
    }
    if (maxLength !== undefined && out.length > maxLength) out = out.slice(0, maxLength);
    if (out === "" && fallback !== undefined) return fallback;
    return out;
}
