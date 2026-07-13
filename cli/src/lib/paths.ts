import { homedir } from "node:os";
import { sep } from "node:path";

/**
 * Contract the user's home-directory prefix to `~` for a compact display path.
 * Only a true path-boundary prefix contracts (exact home, or home followed by the
 * platform separator), so a sibling like `/home/alice-backup` is left untouched
 * rather than mangled into `~-backup`.
 */
export function contractHome(path: string): string {
    const home = homedir();
    if (path === home) return "~";
    // A path-boundary prefix is home followed by the platform separator (`/` on POSIX, `\` on
    // Windows). Both `homedir()` and `canonicalPath` (which backs these display paths via
    // realpathSync/resolve) yield platform-native separators — they are NOT normalized to `/` —
    // so hard-coding `/` would fail to contract any path on Windows.
    return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
