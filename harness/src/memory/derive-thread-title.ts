/**
 * Derive a deterministic thread title from the user's first message.
 * Pure function — no I/O, no global state.
 *
 * Rules:
 * 1. Collapse runs of whitespace to a single space.
 * 2. Trim.
 * 3. Empty / whitespace-only input → `"Untitled"`.
 * 4. If length ≤ `max`, return unchanged.
 * 5. Else slice to `max`, walk back to the last space (word boundary),
 *    append the real ellipsis `…` (U+2026). If no space exists inside
 *    the window, hard-slice at `max` and append `…`.
 */
export function deriveThreadTitle(text: string, max: number = 40): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) return "Untitled";
    if (normalized.length <= max) return normalized;

    const slice = normalized.slice(0, max);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > 0) {
        return slice.slice(0, lastSpace) + "…";
    }
    return slice + "…";
}
