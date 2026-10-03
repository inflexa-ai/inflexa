import type { OpenTarget } from "../types/session.ts";

/**
 * The body of `POST {A}/artifacts/resolve`: the semantic references of the openable entries of one card.
 * A `workspace-file` path is relative to the workspace folder of the analysis. A folder reveal sends the
 * folder as a `workspace-file` entry.
 */
export type ResolveArtifactsRequest = {
    entries: OpenTarget[];
    /** Write the echart or svg file of each entry first, thus each path without an `error` is ready to open. */
    materialize: boolean;
};

/**
 * Why an entry is not ready to open:
 *
 * - `unresolved` — the workspace folder of the analysis cannot be located.
 * - `missing` — nothing is on disk at `path`.
 * - `materialize_failed` — the echart or svg file could not be written.
 * - `unavailable` — the entry has nothing to open, or its path leaves the workspace folder.
 */
export type ArtifactError =
    { type: "unresolved" } | { type: "missing"; path: string } | { type: "materialize_failed" } | { type: "unavailable"; reason: string };

/** One entry of a `POST {A}/artifacts/resolve` response, in the order of the request. */
export type ResolvedArtifact = {
    kind: OpenTarget["kind"];
    /** Where the entry is or will be on disk. `null` when the workspace folder cannot be located, or for `unavailable`. */
    path: string | null;
    /** True when the card shows the entry as broken: a missing workspace file, or nothing to open. An echart or svg file is made on open, thus it is never degraded. */
    degraded: boolean;
    /** With `materialize`: why the entry is not ready to open. Absent when `path` is ready. */
    error?: ArtifactError;
};

/** The body of a `POST {A}/artifacts/resolve` response. */
export type ResolvedArtifacts = {
    entries: ResolvedArtifact[];
};
