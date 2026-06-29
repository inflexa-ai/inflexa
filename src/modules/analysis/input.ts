import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ok, err, type Result } from "neverthrow";
import type { AnalysisInput } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { canonicalPath, findMarkerUpwards } from "../anchor/marker.ts";
import { resolveAnchor } from "../anchor/anchor.ts";

/**
 * Classify a user-supplied path into a storable ref. Resolve to absolute, then walk up for
 * a marker: inside a tracked anchor → `(anchorId, relpath)`; else `(null, absolute)`. This
 * is how an input "lives under an anchor" — and rides it across moves — without any SQL scan.
 */
export function classifyInputPath(analysisId: string, rawPath: string, cwd: string): Result<AnalysisInput, DbError> {
    const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
    const target = resolve(cwd, expanded);

    // `isDir` comes from a real stat. A non-existent path cannot honestly produce `isDir`, so
    // surface it (op marks it not-found) rather than defaulting — the caller rejects it.
    let isDir: boolean;
    try {
        isDir = statSync(target).isDirectory();
    } catch (cause) {
        return err({ type: "query_failed", op: "classifyInputPath:notFound", cause });
    }

    // Canonicalize now that we know it exists, so anchor membership and the stored relpath are
    // computed against symlink-resolved paths (consistent with the anchor's cachedPath).
    const abs = canonicalPath(target);

    let found: { dir: string; marker: { anchorId: string } } | null;
    try {
        found = findMarkerUpwards(abs);
    } catch (cause) {
        return err({ type: "query_failed", op: "classifyInputPath:marker", cause });
    }

    if (found) {
        const rel = relative(found.dir, abs);
        // Only store anchor-relative when genuinely inside the marker dir: a `..`-escaping or
        // (Windows cross-drive) absolute relpath means the input is not under the anchor.
        if (!rel.startsWith("..") && !isAbsolute(rel)) {
            return ok({ path: rel === "" ? "." : rel, isDir, analysisId, anchorId: found.marker.anchorId });
        }
    }
    return ok({ path: abs, isDir, analysisId, anchorId: null });
}

/**
 * Inverse of `classifyInputPath`: resolve a stored ref to an absolute path. Anchor-relative
 * refs ride the anchor's live (reconciled) location; `null` when the anchor can't be resolved.
 */
export function resolveInputPath(input: AnalysisInput): Result<string | null, DbError> {
    if (input.anchorId === null) return ok(input.path);
    // A missing anchor row (null resolved) or unlocated folder (null path) both mean "can't resolve".
    return resolveAnchor(input.anchorId).map((resolved) => (resolved?.path == null ? null : join(resolved.path, input.path)));
}
