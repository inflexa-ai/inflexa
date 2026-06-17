import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnchorMarker, AnchorId } from "../../types/anchor.ts";

/** The on-disk marker for a folder: <dir>/.inf/id (write-once identity file). */
export function markerPath(dir: string): string {
    return join(dir, ".inf", "id");
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
 * Mint a fresh anchor id. This is a globally-unique opaque token written to disk
 * that must survive moves/renames, so it is crypto.randomUUID() — deliberately NOT
 * newId()/ULID, which is reserved for sortable DB row ids. The caller normally
 * supplies the id; this default exists only for convenience.
 */
export function newAnchorUuid(): AnchorId {
    return randomUUID();
}

/**
 * Reads & validates <dir>/.inf/id. Returns null when the file is absent (the normal
 * "not an anchor yet" case). Throws on malformed JSON or an unexpected schemaVersion:
 * corruption is surfaced so the caller can repair it, never silently re-minted (which
 * would orphan the existing identity and duplicate its analyses).
 */
export function readMarker(dir: string): AnchorMarker | null {
    const path = markerPath(dir);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path, "utf8");
    // Let a JSON parse error throw — a present-but-unreadable marker is corruption.
    const parsed = JSON.parse(raw) as Partial<AnchorMarker>;
    if (parsed.schemaVersion !== 1 || typeof parsed.anchorUuid !== "string") {
        throw new Error(`corrupt anchor marker at ${path}: ${raw}`);
    }
    return { schemaVersion: 1, anchorUuid: parsed.anchorUuid };
}

/**
 * Write-once: if a valid marker already exists it is returned unchanged (the folder
 * already has identity, so its UUID wins over the passed one and the file is never
 * rewritten — the marker records no mutable state). A corrupt existing marker throws
 * rather than being clobbered. Only an absent marker is created.
 */
export function writeMarker(dir: string, anchorUuid: AnchorId): AnchorMarker {
    const existing = readMarker(dir); // throws if corrupt — do not overwrite corruption
    if (existing) return existing;

    const marker: AnchorMarker = { schemaVersion: 1, anchorUuid };
    mkdirSync(join(dir, ".inf"), { recursive: true });
    writeFileSync(markerPath(dir), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    return marker;
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
export function findMarkerUpwards(startDir: string): { dir: string; marker: AnchorMarker } | null {
    let dir = resolve(startDir);
    for (;;) {
        const marker = readMarker(dir);
        if (marker) return { dir, marker };
        const parent = dirname(dir);
        if (parent === dir) return null; // reached filesystem root
        dir = parent;
    }
}
