/**
 * Directory names to skip during provenance read tracking and artifact directory scanning.
 * Used by processProvenanceFrame() (read-side filter) and
 * scanArtifactDirectory() (UI file tree snapshots).
 */
export const IGNORED_DIRS = new Set([".ruff_cache", "__pycache__", ".cache", ".ipynb_checkpoints", "node_modules", ".Rproj.user"]);

/**
 * Check whether any segment of a relative path matches IGNORED_DIRS.
 * Used to filter tooling noise reads in processProvenanceFrame.
 */
export function isToolNoisePath(relativePath: string): boolean {
    const segments = relativePath.split("/");
    return segments.some((s) => IGNORED_DIRS.has(s));
}
