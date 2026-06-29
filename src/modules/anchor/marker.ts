import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AnchorMarker, AnchorId } from "../../types/anchor.ts";

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
        // TODO(slop): neverthrow
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
 * Reads & validates <dir>/.inflexa/id. Returns null when the file is absent (the normal
 * "not an anchor yet" case). Throws on malformed JSON or a marker that fails the schema:
 * corruption is surfaced so the caller can repair it, never silently re-minted (which
 * would orphan the existing identity and duplicate its analyses).
 */
export function readMarker(dir: string): AnchorMarker | null {
    const path = markerPath(dir);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path, "utf8"); // TODO(slop): make a wrapper that returns result - since I guess this throws
    // A present-but-invalid marker is corruption, not absence. JSON.parseWith returns null
    // for both a parse error and a schema mismatch, so the existsSync gate above is what
    // separates "no marker" (null, fine) from "broken marker" (throw, never silently re-minted).
    const marker = JSON.parseWith(raw, anchorMarkerSchema);
    if (!marker) throw new Error(`corrupt anchor marker at ${path}: ${raw}`); // TODO(slop): don't throw, return result
    return marker;
}

/**
 * Write-once: if a valid marker already exists it is returned unchanged (the folder
 * already has identity, so its UUID wins over the passed one and the file is never
 * rewritten — the marker records no mutable state). A corrupt existing marker throws
 * rather than being clobbered. Only an absent marker is created.
 */
export function writeMarker(dir: string, anchorId: AnchorId): AnchorMarker {
    const existing = readMarker(dir); // throws if corrupt — do not overwrite corruption
    if (existing) return existing;

    const marker: AnchorMarker = { schemaVersion: 1, anchorId: anchorId };
    mkdirSync(join(dir, ".inflexa"), { recursive: true }); // TODO(slop): Make wrapper - don't throw
    writeFileSync(markerPath(dir), `${JSON.stringify(marker, null, 2)}\n`, "utf8"); // TODO(slop): make wrapper - don't throw
    return marker;
}

/**
 * True when files can be created under `dir`. Uses accessSync(W_OK) rather than a
 * temp-file probe so it never leaves litter; any error (missing dir, read-only mount,
 * foreign ownership) is treated as not writable.
 */
export function isDirWritable(dir: string): boolean {
    try {
        // TODO(slop): neverthrow
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
export function findMarkerUpwards(startDir: string): { dir: string; marker: AnchorMarker } | null {
    let dir = resolve(startDir);
    for (;;) {
        const marker = readMarker(dir);
        if (marker) return { dir, marker };
        const parent = dirname(dir); // TODO(slop): make a wrapper that returns result and change the call.
        if (parent === dir) return null; // reached filesystem root
        dir = parent;
    }
}
