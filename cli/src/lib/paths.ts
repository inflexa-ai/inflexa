import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

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

/**
 * Canonical (symlink-resolved) absolute form of a path. Falls back to resolve() when the
 * path doesn't exist yet (realpath requires existence). Identity must key on the canonical
 * path, or the same physical folder reached via two textual forms — e.g. macOS /var vs
 * /private/var, or any user symlink — would be misread as a move or a copy.
 */
export function canonicalPath(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return resolve(p);
    }
}

/**
 * Expand a leading `~` to the home directory, then resolve against `cwd` — the front half of
 * input-path classification, shared with existence pre-checks and removal matching so all three
 * agree on what a raw path resolves to. A client resolves a path of the user with it before it sends
 * the path to the local server, which never sees the folder of the client.
 */
export function expandAndResolve(cwd: string, rawPath: string): string {
    const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
    return resolve(cwd, expanded);
}
