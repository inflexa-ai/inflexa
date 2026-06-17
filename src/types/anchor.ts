/**
 * Opaque anchor identity: a `crypto.randomUUID()` written into the folder marker
 * (`.inf/id`), deliberately NOT a ULID row id — it must survive moves and renames.
 */
export type AnchorId = string;

/** Invisible folder-identity record. Keyed by the marker id, not its path. */
export type Anchor = {
    /** the marker UUID; the row's primary key, mirrored on disk in `.inf/id` */
    id: AnchorId;
    createdAt: number;
    /** bumped on data edits (e.g. cachedPath); distinct from lastSeen */
    updatedAt: number;
    /** absolute; a HINT, reconciled to the live location by id */
    cachedPath: string;
    /** false when the folder was not writable (no on-disk marker) */
    markerWritten: boolean;
    /** heartbeat: last time the folder was sighted at its path */
    lastSeen: number;
};

/** Contents of the write-once on-disk marker `<anchor>/.inf/id`. */
export type AnchorMarker = {
    schemaVersion: 1;
    anchorUuid: AnchorId;
};
