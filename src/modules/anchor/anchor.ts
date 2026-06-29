import { randomUUIDv7 } from "bun";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ok, err, Result } from "neverthrow";
import type { Anchor, AnchorMarker } from "../../types/anchor.ts";
import type { DbError } from "../../db/errors.ts";
import { getAnchor, listAnchors } from "../../db/primary_query.ts";
import { insertAnchor, touchAnchor, updateAnchorCachedPath } from "../../db/primary_mutation.ts";
import { canonicalPath, findMarkerUpwards, isDirWritable, readMarker, writeMarker, type MarkerError } from "./marker.ts";

/** Bridge a marker-layer failure into the db-layer error type so callers that return `Result<T, DbError>` can propagate it without widening their error union. */
function markerToDbError(op: string, e: MarkerError): DbError {
    return { type: "query_failed", op, cause: e };
}

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
 *
 * WRITES TO DISK: in a writable dir with no marker, this mints an anchor and writes a
 * `.inflexa/id` marker. Call it only from a deliberate user action (e.g. analysis creation),
 * never from a passive/background flow like TUI launch — that would litter markers in every
 * folder the app opens (no-litter policy). For startup reconciliation use {@link recoverAnchors}.
 */
export function getOrCreateAnchorForCwd(dir: string): Result<Anchor, DbError> {
    const abs = canonicalPath(dir);

    const markerResult = readMarker(abs);
    if (markerResult.isErr()) return err(markerToDbError("getOrCreateAnchorForCwd:readMarker", markerResult.error));
    const marker = markerResult.value;

    if (marker) {
        const anchorId = marker.anchorId;
        return getAnchor(anchorId).andThen((existing): Result<Anchor, DbError> => {
            // Marker on disk but no DB row (DB reset, or folder authored on another
            // machine): re-establish the row keyed on the existing UUID to keep identity.
            if (!existing) return insertAnchor(makeAnchor(anchorId, abs, true));
            // Self-heal a drifted cached path.
            if (existing.cachedPath !== abs) {
                const healed: Anchor = { ...existing, cachedPath: abs };
                return updateAnchorCachedPath(anchorId, abs).map(() => healed);
            }
            return ok(existing);
        });
    }

    // No marker: mint a UUID. Only write a marker when the dir is writable; otherwise
    // the anchor degrades to path-only (markerWritten: false), per the spec.
    const anchorId = randomUUIDv7();
    const writable = isDirWritable(abs);
    if (writable) {
        const writeResult = writeMarker(abs, anchorId);
        if (writeResult.isErr()) return err(markerToDbError("getOrCreateAnchorForCwd:writeMarker", writeResult.error));
    }
    return insertAnchor(makeAnchor(anchorId, abs, writable));
}

/**
 * True if `dir` holds a valid marker whose UUID matches. Corrupt or absent markers are
 * treated as non-matching here: resolution must not abort on an unrelated corrupt marker.
 */
function markerMatches(dir: string, anchorId: string): boolean {
    return readMarker(dir)
        .map((m) => m?.anchorId === anchorId)
        .unwrapOr(false);
}

/**
 * Walk up from startDir for the nearest marker matching uuid; corruption-safe (a corrupt
 * marker on the walk falls through to the bounded search rather than aborting resolution).
 */
function findMatchingMarkerUpwards(startDir: string, anchorId: string): string | null {
    return findMarkerUpwards(startDir)
        .map((found) => (found && found.marker.anchorId === anchorId ? found.dir : null))
        .unwrapOr(null);
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

/** A resolved anchor and its current on-disk path (`null` when the folder can't be located). */
export type ResolvedAnchor = { anchor: Anchor; path: string | null };

/** Best-effort path: the resolved on-disk path, falling back to the anchor's cached path, or `null` when the anchor row is missing. */
export function resolvedPathOrCached(r: ResolvedAnchor | null): string | null {
    return r ? (r.path ?? r.anchor.cachedPath) : null;
}

function selfHeal(anchor: Anchor, anchorId: string, dir: string): Result<ResolvedAnchor, DbError> {
    const canonical = canonicalPath(dir);
    const healed: Anchor = { ...anchor, cachedPath: canonical };
    return updateAnchorCachedPath(anchorId, canonical).map(() => ({ anchor: healed, path: canonical }));
}

/**
 * Resolve a UUID to its current path, reconciling the cached path lazily. See the spec
 * (Folder identity & moves): cached-path check → cwd/ancestor self-heal → bounded search.
 *
 * Returns `null` when the DB has no row for `anchorId`. That is a NORMAL condition, not an error:
 * the database is the user's local file and they may delete or edit it freely, while on-disk markers
 * (and analyses that reference an anchor) persist independently — so a reference to a missing anchor
 * is a routine desync. We degrade rather than hard-fail; the deliberate `getOrCreateAnchorForCwd`
 * re-establishes the row from the on-disk marker when the user next acts (we never write on this
 * passive resolve — the no-litter policy). See CLAUDE.md → "Local state can desync from the database".
 */
export function resolveAnchor(anchorId: string, opts?: { searchRoots?: string[] }): Result<ResolvedAnchor | null, DbError> {
    return getAnchor(anchorId).andThen((anchor): Result<ResolvedAnchor | null, DbError> => {
        if (!anchor) return ok(null);

        // Step 1: the cached path still holds our marker — cheapest, highest-hit case.
        if (markerMatches(anchor.cachedPath, anchorId)) {
            return touchAnchor(anchorId).map(() => ({ anchor, path: anchor.cachedPath }));
        }

        const roots = (opts?.searchRoots ?? [process.cwd()]).map((r) => canonicalPath(r));

        // Step 2: cwd or an ancestor holds our marker (we cd'd into the moved folder).
        for (const root of roots) {
            const hit = findMatchingMarkerUpwards(root, anchorId);
            if (hit) return selfHeal(anchor, anchorId, hit);
        }

        // Step 3: bounded search over roots (+ ancestors) and known anchor cached paths.
        return listAnchors().andThen((anchors): Result<ResolvedAnchor, DbError> => {
            const candidates = new Set<string>();
            for (const root of roots) for (const d of ancestorsOf(root)) candidates.add(d);
            for (const a of anchors) candidates.add(resolve(a.cachedPath));

            const matches = [...candidates].filter((d) => markerMatches(d, anchorId));
            const unique = matches.length === 1 ? matches[0] : null;
            if (unique) return selfHeal(anchor, anchorId, unique);
            // Zero or multiple hits: do not guess — caller surfaces "run `inflexa relocate`".
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
    return getAnchor(marker.anchorId).map((anchor): "copy" | "move" | "ok" => {
        if (!anchor) return "ok"; // no existing identity to conflict with
        const cached = canonicalPath(anchor.cachedPath);
        if (cached === abs) return "ok";
        return existsSync(cached) ? "copy" : "move";
    });
}

/**
 * Reconcile every known anchor against the filesystem — the automatic counterpart to the
 * manual `repair`/`relocate`/`prune` backstop, meant to run at startup. An anchor still at
 * its cached path is a cheap no-op (a heartbeat touch); one whose folder moved under
 * `searchRoots` self-heals in place; one that cannot be located is left untouched for the
 * operator to `relocate` or `prune`. Recovery only — it never mints or writes a marker.
 * Returns how many anchors resolved to a live path (`recovered`) versus could not
 * (`unresolved`), so the caller can log a one-line summary.
 */
export function recoverAnchors(searchRoots: string[] = [process.cwd()]): Result<{ recovered: number; unresolved: number }, DbError> {
    return listAnchors().andThen((anchors) =>
        // Every id comes from listAnchors, so the row always exists (r is non-null); the guard is
        // only to satisfy resolveAnchor's nullable contract — a null would count as unresolved anyway.
        Result.combine(anchors.map((a) => resolveAnchor(a.id, { searchRoots }).map((r) => r?.path ?? null))).map((paths) => {
            const unresolved = paths.filter((p) => p === null).length;
            return { recovered: paths.length - unresolved, unresolved };
        }),
    );
}
