/**
 * The seam that turns a report reference into a concrete value, and the value model that it gives back.
 *
 * A reference is authored belief. A resolver reads the pinned evidence and gives the value that the
 * belief points at. The harness declares the seam here, thus a production realization can read storage,
 * and a fixture realization can read an in-memory snapshot. The two obey the same contract.
 */

import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";

/**
 * One pinned artifact: its content hash, and its rows as plain cells.
 *
 * `rows` is optional because an image is pinned by its hash alone and holds no cells. An empty array in
 * that position would say that the artifact holds zero rows, which is a different and false claim.
 */
export interface ArtifactSnapshot {
    hash: string;
    rows?: Array<Record<string, string | number>>;
}

/**
 * The pinned evidence that a resolver reads. The `artifacts` map is keyed by the run-relative path, the
 * same path that an artifact reference names. `citations` holds each known external id as an `idKind:id`
 * string, for example `pmid:12345`.
 */
export interface ReportSnapshot {
    artifacts: Record<string, ArtifactSnapshot>;
    citations?: string[];
}

/**
 * The concrete value that a reference resolves to. A scalar comes from one artifact cell or one
 * derivation. A table comes from a whole-table artifact. A file echoes the pin of a whole-file artifact,
 * for example an image. A citation echo confirms that an external id is in the pinned evidence.
 */
export type ResolvedValue =
    | { type: "scalar"; value: string | number }
    | { type: "table"; rows: Array<Record<string, string | number>>; columns?: string[] }
    | { type: "file"; path: string; hash: string }
    | { type: "citation"; id: string };

/**
 * The outcome of one resolution. It is plain, discriminated data, and not a `Result` from neverthrow. An
 * unresolved reference is a normal domain outcome that a reviewer reads, and not an error channel that a
 * caller must bridge. Thus resolution never throws.
 */
export type ResolveOutcome = { ok: true; value: ResolvedValue } | { ok: false; failure: UnresolvedReference };

/**
 * The capability seam that resolves one reference against a snapshot.
 *
 * The method is async because a production realization reads storage. A synchronous signature would
 * force a local realization onto every host, thus the seam stays async even when a realization is
 * in-memory.
 */
export interface ReferenceResolver {
    resolve(reference: Reference, snapshot: ReportSnapshot): Promise<ResolveOutcome>;
}
