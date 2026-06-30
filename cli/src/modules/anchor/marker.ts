import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Result, ok, err } from "neverthrow";
import { z } from "zod";
import type { AnchorMarker, AnchorId } from "../../types/anchor.ts";
import { readFileResult, writeFileResult, mkdirResult } from "../../lib/fs.ts";

/** Marker-layer failure. Covers I/O (FS read/write) and data integrity (corrupt marker file). */
export type MarkerError =
    | { type: "marker_read_failed"; path: string; cause: unknown }
    | { type: "marker_corrupt"; path: string; raw: string }
    | { type: "marker_write_failed"; path: string; cause: unknown };

/** The on-disk marker for a folder: <dir>/.inflexa/id (write-once identity file). */
export function markerPath(dir: string): string {
    return join(dir, ".inflexa", "id");
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
 * Shape of a valid on-disk marker. Kept beside the marker I/O (its only reader) and pinned
 * to the {@link AnchorMarker} domain type with `satisfies`, so the schema and the type
 * cannot drift apart.
 */
const anchorMarkerSchema = z.object({
    schemaVersion: z.literal(1),
    anchorId: z.string(),
}) satisfies z.ZodType<AnchorMarker>;

/**
 * Reads & validates <dir>/.inflexa/id. Returns `ok(null)` when the file is absent (the normal
 * "not an anchor yet" case). Returns `err` on I/O failure or a marker that fails the schema:
 * corruption is surfaced so the caller can repair it, never silently re-minted (which
 * would orphan the existing identity and duplicate its analyses).
 */
export function readMarker(dir: string): Result<AnchorMarker | null, MarkerError> {
    const path = markerPath(dir);
    if (!existsSync(path)) return ok(null);

    const read = readFileResult(path, "readMarker");
    if (read.isErr()) return err({ type: "marker_read_failed", path, cause: read.error.cause });

    const raw = read.value;
    const marker = JSON.parseWith(raw, anchorMarkerSchema);
    if (!marker) return err({ type: "marker_corrupt", path, raw });
    return ok(marker);
}

/**
 * Write-once: if a valid marker already exists it is returned unchanged (the folder
 * already has identity, so its UUID wins over the passed one and the file is never
 * rewritten — the marker records no mutable state). A corrupt existing marker returns
 * an error rather than being clobbered. Only an absent marker is created.
 */
export function writeMarker(dir: string, anchorId: AnchorId): Result<AnchorMarker, MarkerError> {
    return readMarker(dir).andThen((existing) => {
        if (existing) return ok(existing);

        const marker: AnchorMarker = { schemaVersion: 1, anchorId: anchorId };
        const dotDir = join(dir, ".inflexa");
        const path = markerPath(dir);

        return mkdirResult(dotDir, "writeMarker:mkdir")
            .mapErr((e): MarkerError => ({ type: "marker_write_failed", path, cause: e.cause }))
            .andThen(() =>
                writeFileResult(path, `${JSON.stringify(marker, null, 2)}\n`, "writeMarker:write").mapErr(
                    (e): MarkerError => ({ type: "marker_write_failed", path, cause: e.cause }),
                ),
            )
            .map(() => marker);
    });
}

/**
 * True when files can be created under `dir`. Uses accessSync(W_OK) rather than a
 * temp-file probe so it never leaves litter; any error (missing dir, read-only mount,
 * foreign ownership) is treated as not writable.
 */
export function isDirWritable(dir: string): boolean {
    try {
        accessSync(dir, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Walk up from startDir to the filesystem root, returning the nearest ancestor
 * (including startDir) that holds a valid marker. Stops at the root (parent === dir)
 * instead of looping. A corrupt marker mid-walk propagates via readMarker — corruption
 * at a candidate anchor is a real error, not something to skip past.
 */
export function findMarkerUpwards(startDir: string): Result<{ dir: string; marker: AnchorMarker } | null, MarkerError> {
    let dir = resolve(startDir);
    for (;;) {
        const result = readMarker(dir);
        if (result.isErr()) return err(result.error);
        if (result.value) return ok({ dir, marker: result.value });
        const parent = dirname(dir);
        if (parent === dir) return ok(null);
        dir = parent;
    }
}
