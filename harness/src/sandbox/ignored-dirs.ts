/**
 * Directory names that are tooling noise (interpreter caches, dependency
 * trees) rather than analysis artifacts. `walkStepArtifacts`
 * (`execution/post-step.js`) prunes these while walking a step's writable
 * tree so caches never register as artifacts.
 */
export const IGNORED_DIRS = new Set([".ruff_cache", "__pycache__", ".cache", ".ipynb_checkpoints", "node_modules", ".Rproj.user"]);
