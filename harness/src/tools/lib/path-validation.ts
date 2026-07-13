/**
 * Shared path-shape validation for display-card references.
 *
 * `show_file` and `show_user`'s echart `dataPath` both name analysis-rooted
 * artifact paths the host resolves to viewable content at render time. The
 * shape rules are identical and live here as the single source: non-empty,
 * length-capped, no NUL, no leading slash (must be analysis-rooted, not
 * absolute), no `..` traversal segment. Neither tool checks that the file
 * exists — a reference that fails to resolve degrades at render time.
 */

/** Max length of an analysis-rooted reference path. */
export const MAX_PATH_LEN = 1024;

/** Returns null for a legal analysis-rooted path, an error code otherwise. */
export function validatePath(path: string): null | "invalid_path" {
    if (path.length === 0 || path.length > MAX_PATH_LEN) return "invalid_path";
    if (path.includes("\0")) return "invalid_path";
    if (path.startsWith("/")) return "invalid_path";
    for (const segment of path.split("/")) {
        if (segment === "..") return "invalid_path";
    }
    return null;
}
