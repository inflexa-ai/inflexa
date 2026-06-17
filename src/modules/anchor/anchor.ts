import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ok, err, type Result } from "neverthrow";
import type { Anchor, AnchorMarker } from "../../types/anchor.ts";
import type { DbError } from "../../db/errors.ts";
import { getAnchor, listAnchors } from "../../db/primary_query.ts";
import { insertAnchor, touchAnchor, updateAnchorCachedPath } from "../../db/primary_mutation.ts";
import { canonicalPath, findMarkerUpwards, isDirWritable, newAnchorUuid, readMarker, writeMarker } from "./marker.ts";

/**
 * `id` is the marker UUID (from the on-disk marker or freshly minted), stored as the
 * anchor row's primary key.
 */
function makeAnchor(id: string, dir: string, markerWritten: boolean): Anchor {
    const now = Date.now();
    return { id, cachedPath: canonicalPath(dir), markerWritten, createdAt: now, updatedAt: now, lastSeen: now };
}

/**
 * Ensure `dir` is a tracked anchor and return its row. The single entry point used at
 * analysis creation and context resolution.
 */
export function getOrCreateAnchorForCwd(dir: string): Result<Anchor, DbError> {
    const abs = canonicalPath(dir);

    let marker: AnchorMarker | null;
    try {
        marker = readMarker(abs);
    } catch (cause) {
        // Corrupt on-disk marker surfaces through the Result channel, not as a throw.
        return err({ type: "query_failed", op: "getOrCreateAnchorForCwd:readMarker", cause });
    }

    if (marker) {
        const uuid = marker.anchorUuid;
        return getAnchor(uuid).andThen((existing): Result<Anchor, DbError> => {
            // Marker on disk but no DB row (DB reset, or folder authored on another
            // machine): re-establish the row keyed on the existing UUID to keep identity.
            if (!existing) return insertAnchor(makeAnchor(uuid, abs, true));
            // Self-heal a drifted cached path.
            if (existing.cachedPath !== abs) {
                const healed: Anchor = { ...existing, cachedPath: abs };
                return updateAnchorCachedPath(uuid, abs).map(() => healed);
            }
            return ok(existing);
        });
    }

    // No marker: mint a UUID. Only write a marker when the dir is writable; otherwise
    // the anchor degrades to path-only (markerWritten: false), per the spec.
    const uuid = newAnchorUuid();
    const writable = isDirWritable(abs);
    if (writable) {
        try {
            writeMarker(abs, uuid);
        } catch (cause) {
            return err({ type: "mutation_failed", op: "getOrCreateAnchorForCwd:writeMarker", cause });
        }
    }
    return insertAnchor(makeAnchor(uuid, abs, writable));
}

/**
 * True if `dir` holds a valid marker whose UUID matches. Corrupt or absent markers are
 * treated as non-matching here: resolution must not abort on an unrelated corrupt marker.
 */
function markerMatches(dir: string, uuid: string): boolean {
    try {
        return readMarker(dir)?.anchorUuid === uuid;
    } catch {
        return false;
    }
}

/**
 * Walk up from startDir for the nearest marker matching uuid; corruption-safe (a corrupt
 * marker on the walk falls through to the bounded search rather than aborting resolution).
 */
function findMatchingMarkerUpwards(startDir: string, uuid: string): string | null {
    try {
        const found = findMarkerUpwards(startDir);
        return found && found.marker.anchorUuid === uuid ? found.dir : null;
    } catch {
        return null;
    }
}

function ancestorsOf(dir: string): string[] {
    const out: string[] = [];
    let d = resolve(dir);
    for (;;) {
        out.push(d);
        const parent = dirname(d);
        if (parent === d) return out;
        d = parent;
    }
}

function selfHeal(anchor: Anchor, uuid: string, dir: string): Result<{ anchor: Anchor; path: string | null }, DbError> {
    const canonical = canonicalPath(dir);
    const healed: Anchor = { ...anchor, cachedPath: canonical };
    return updateAnchorCachedPath(uuid, canonical).map(() => ({ anchor: healed, path: canonical }));
}

/**
 * Resolve a UUID to its current path, reconciling the cached path lazily. See the spec
 * (Folder identity & moves): cached-path check → cwd/ancestor self-heal → bounded search.
 */
export function resolveAnchor(uuid: string, opts?: { searchRoots?: string[] }): Result<{ anchor: Anchor; path: string | null }, DbError> {
    return getAnchor(uuid).andThen((anchor): Result<{ anchor: Anchor; path: string | null }, DbError> => {
        if (!anchor) return err({ type: "query_failed", op: "resolveAnchor", cause: new Error(`unknown anchor ${uuid}`) });

        // Step 1: the cached path still holds our marker — cheapest, highest-hit case.
        if (markerMatches(anchor.cachedPath, uuid)) {
            return touchAnchor(uuid).map(() => ({ anchor, path: anchor.cachedPath }));
        }

        const roots = (opts?.searchRoots ?? [process.cwd()]).map((r) => canonicalPath(r));

        // Step 2: cwd or an ancestor holds our marker (we cd'd into the moved folder).
        for (const root of roots) {
            const hit = findMatchingMarkerUpwards(root, uuid);
            if (hit) return selfHeal(anchor, uuid, hit);
        }

        // Step 3: bounded search over roots (+ ancestors) and known anchor cached paths.
        return listAnchors().andThen((anchors): Result<{ anchor: Anchor; path: string | null }, DbError> => {
            const candidates = new Set<string>();
            for (const root of roots) for (const d of ancestorsOf(root)) candidates.add(d);
            for (const a of anchors) candidates.add(resolve(a.cachedPath));

            const matches = [...candidates].filter((d) => markerMatches(d, uuid));
            const unique = matches.length === 1 ? matches[0] : null;
            if (unique) return selfHeal(anchor, uuid, unique);
            // Zero or multiple hits: do not guess — caller surfaces "run `inf relocate`".
            return ok({ anchor, path: null });
        });
    });
}

/**
 * Classify a marker sighting at `dir` against the UUID's known location. Only classifies;
 * callers own the UX and never auto-merge a copy.
 */
export function classifyMarkerSighting(dir: string, marker: AnchorMarker): Result<"copy" | "move" | "ok", DbError> {
    const abs = canonicalPath(dir);
    return getAnchor(marker.anchorUuid).map((anchor): "copy" | "move" | "ok" => {
        if (!anchor) return "ok"; // no existing identity to conflict with
        const cached = canonicalPath(anchor.cachedPath);
        if (cached === abs) return "ok";
        return existsSync(cached) ? "copy" : "move";
    });
}
