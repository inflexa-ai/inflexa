import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AnchorMarker, AnchorId } from "../../types/anchor.ts";
import { mkdirResultAsync, pathExistsAsync, readFileResultAsync, writeFileResultAsync } from "../../lib/fs.ts";

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
 *
 * Each read runs off the event loop: the local server reads markers for a request, and a folder on a
 * hung mount must stop only that request.
 */
export function readMarker(dir: string): ResultAsync<AnchorMarker | null, MarkerError> {
    const path = markerPath(dir);
    // The existence probe keeps the meaning of `existsSync`: each failed `stat` (ENOENT, ENOTDIR when `dir`
    // is a file, EACCES on a parent) reads as "no marker", and only a marker that exists and fails its
    // read is an error.
    return ResultAsync.fromSafePromise(pathExistsAsync(path)).andThen((exists) => {
        if (!exists) return okAsync(null);
        return readFileResultAsync(path, "readMarker")
            .mapErr((e): MarkerError => ({ type: "marker_read_failed", path, cause: e.cause }))
            .andThen((raw) => {
                const marker = JSON.parseWith(raw, anchorMarkerSchema);
                if (!marker) return errAsync<AnchorMarker, MarkerError>({ type: "marker_corrupt", path, raw });
                return okAsync<AnchorMarker, MarkerError>(marker);
            });
    });
}

/**
 * Write-once: if a valid marker already exists it is returned unchanged (the folder
 * already has identity, so its UUID wins over the passed one and the file is never
 * rewritten — the marker records no mutable state). A corrupt existing marker returns
 * an error rather than being clobbered. Only an absent marker is created.
 */
export function writeMarker(dir: string, anchorId: AnchorId): ResultAsync<AnchorMarker, MarkerError> {
    return readMarker(dir).andThen((existing) => {
        if (existing) return okAsync<AnchorMarker, MarkerError>(existing);

        const marker: AnchorMarker = { schemaVersion: 1, anchorId: anchorId };
        const dotDir = join(dir, ".inflexa");
        const path = markerPath(dir);

        return mkdirResultAsync(dotDir, "writeMarker:mkdir")
            .andThen(() => writeFileResultAsync(path, `${JSON.stringify(marker, null, 2)}\n`, "writeMarker:write"))
            .mapErr((e): MarkerError => ({ type: "marker_write_failed", path, cause: e.cause }))
            .map(() => marker);
    });
}

/**
 * True when files can be created under `dir`. Uses access(W_OK) rather than a
 * temp-file probe so it never leaves litter; any error (missing dir, read-only mount,
 * foreign ownership) is treated as not writable.
 */
export function isDirWritable(dir: string): Promise<boolean> {
    return access(dir, constants.W_OK).then(
        () => true,
        () => false,
    );
}

/**
 * Walk up from startDir to the filesystem root, returning the nearest ancestor
 * (including startDir) that holds a valid marker. Stops at the root (parent === dir)
 * instead of looping. A corrupt marker mid-walk propagates via readMarker — corruption
 * at a candidate anchor is a real error, not something to skip past.
 *
 * The reads run one at a time, from the start folder up: the nearest marker wins, thus a read of a
 * parent is wasted work once a nearer folder answers.
 */
export function findMarkerUpwards(startDir: string): ResultAsync<{ dir: string; marker: AnchorMarker } | null, MarkerError> {
    function step(dir: string): ResultAsync<{ dir: string; marker: AnchorMarker } | null, MarkerError> {
        return readMarker(dir).andThen((marker) => {
            if (marker) return okAsync({ dir, marker });
            const parent = dirname(dir);
            if (parent === dir) return okAsync(null);
            return step(parent);
        });
    }
    return step(resolve(startDir));
}
