/**
 * Identifier validation — safe patterns for path-embedded IDs.
 */

/** Pattern for IDs safe to embed in filesystem paths. */
export const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Zod refinement for safe path identifiers. */
export function isSafePathId(value: string): boolean {
    return SAFE_ID_PATTERN.test(value) && !value.includes("..");
}

export const SAFE_ID_MESSAGE = "Must be alphanumeric with hyphens/underscores, no path separators";
