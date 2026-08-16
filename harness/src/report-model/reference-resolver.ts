/**
 * The seam that turns a report reference into a concrete value, and the value model that it gives back.
 *
 * A reference is authored belief. A resolver reads the pinned evidence and gives the value that the
 * belief points at. The harness declares the seam here, thus a production realization can read storage,
 * and a fixture realization can read an in-memory snapshot. The two obey the same contract.
 */

import type { Result } from "neverthrow";

import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";
import type { ArtifactType } from "../schemas/artifact-manifest.js";

/**
 * One pinned artifact: its content hash, and its rows as plain cells.
 *
 * A cell is a string or a number, because a realization gives back whatever its store holds. A
 * text-backed artifact such as a CSV gives a numeric column as a string. Thus a realization is free to
 * skip a type inference pass, and resolution compares a numeral by its numeric value and never by its
 * JavaScript type.
 *
 * `rows` is optional because an image is pinned by its hash alone and holds no cells. An empty array in
 * that position would say that the artifact holds zero rows, which is a different and false claim. The
 * pin never populates `rows`. `rows` serves the fixture realization only, and that realization resolves
 * from the snapshot itself. A production snapshot pins identity, and a value comes from a read of the
 * artifact.
 *
 * `fileType` states a role, and it does not state a data format. `inferArtifactType` in
 * `src/schemas/artifact-manifest.ts` gives each value that the ledger holds, and the values are
 * `figure`, `script`, `log`, `notebook`, and `output`. Thus the field can refuse a kind of reference, and
 * it can never confirm one. An `output` covers a table and an image alike.
 */
export interface ArtifactSnapshot {
    hash: string;
    fileType?: string | null;
    rows?: Array<Record<string, string | number>>;
}

/**
 * One pinned citation record: the short citation of the paper, and the description that the synthesis
 * gave. The record is the bibliography of a citation key, and the key alone states the membership.
 */
export interface CitationRecord {
    citation: string;
    description?: string;
}

/** The pinned citation records, keyed by the citation key, for example `pmid:12345`. */
export type CitationRecords = Record<string, CitationRecord>;

/**
 * The pinned evidence that a resolver reads. The `artifacts` map is keyed by the analysis-relative path,
 * the same path that an artifact reference names and the same key as `cortex_artifacts.path`. That path
 * is unique across the analysis, thus one map holds the artifacts of every run without a collision.
 * `citations` holds each known external id as an `idKind:id` string, for example `pmid:12345`.
 *
 * `citationRecords` carries the bibliography of a key that the synthesis described. The key list keeps the
 * membership role, thus a key with no record is a pinned citation and a stored pin with no map reads the
 * same as one that predates the map.
 */
export interface ReportSnapshot {
    artifacts: Record<string, ArtifactSnapshot>;
    citations?: string[];
    citationRecords?: CitationRecords;
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
 * The capability seam that resolves one reference against a snapshot.
 *
 * The method is async because a production realization reads storage. A synchronous signature would
 * force a local realization onto every host, thus the seam stays async even when a realization is
 * in-memory.
 *
 * The `Ok` channel carries the resolved value. The `Err` channel carries the `UnresolvedReference`,
 * which names the reason and the detail that a reference did not bind. The validator collects each such
 * `Err` into its report, thus a caller reads the reason as data and resolution never throws.
 *
 * `prepare` is an optional batch step that runs one time before the per-reference loop. A realization
 * that reads storage groups the references by artifact, reads each file one time, and fills a cache.
 * `resolve` then answers from the cache. The method is optional, thus a realization without it keeps the
 * per-reference behavior and the extension breaks no caller.
 */
export interface ReferenceResolver {
    resolve(reference: Reference, snapshot: ReportSnapshot): Promise<Result<ResolvedValue, UnresolvedReference>>;
    prepare?(references: readonly Reference[], snapshot: ReportSnapshot): Promise<void>;
}

/**
 * Give back each name in `columns` that no row holds, in the order of `columns`.
 *
 * A table tolerates a ragged row, thus a column that only some rows hold is present. A column that no
 * row holds is a name that addresses nothing, and it is the difference between a sparse table and a
 * column that does not exist.
 *
 * A table with no rows gives back nothing. There is no evidence to contradict any name, and an empty
 * result table is a real scientific outcome that must not fail for the shape of its emptiness.
 */
export function columnsHeldByNoRow(rows: Array<Record<string, string | number>>, columns: readonly string[]): string[] {
    if (rows.length === 0) {
        return [];
    }
    return columns.filter((column) => !rows.some((row) => column in row));
}

/**
 * The file type of an entry that holds no cell for a reference to address.
 *
 * The `satisfies` clause ties each literal to a member of `ArtifactType`. A renamed member of
 * `ArtifactType` becomes a compile error here. A new member passes with no error, because the rule
 * refuses a kind and never confirms one.
 */
const FILE_TYPES_WITH_NO_CELL: ReadonlySet<string> = new Set(["figure", "script", "log", "notebook"] satisfies readonly ArtifactType[]);

/**
 * Give back `true` for a file type that holds no cell for a reference to address.
 *
 * The file type states a role, and it does not state a data format. Thus the rule runs one way only. It
 * refuses a kind, and it never confirms one. An `output` gives back `false`, because it covers a table and
 * an image alike. Only a read of the artifact settles which one it is. An absent file type gives back
 * `false` for the same reason.
 *
 * The structural tier and a resolver both read this one predicate. Thus the two tiers can never disagree
 * about one reference.
 */
export function fileTypeHoldsNoCell(fileType: string | null | undefined): boolean {
    return fileType !== undefined && fileType !== null && FILE_TYPES_WITH_NO_CELL.has(fileType);
}

/**
 * Give back the snapshot entry at `path`, or `undefined` when the map holds no such own key.
 *
 * An agent authors a report reference, thus the path is untrusted text. The `artifacts` map can be a
 * plain object: a fixture literal, or a `JSON.parse` of a stored snapshot. A bracket lookup on a plain
 * object with a path such as `constructor` finds an inherited member. Then the refusal reads
 * `hash-mismatch`, but the true answer is `artifact-missing`. The `Object.hasOwn` guard admits an own
 * key only, thus an inherited member reads as absent.
 *
 * The structural tier and the fixture resolver both read this one lookup. Thus the two tiers can never
 * disagree about membership.
 */
export function snapshotEntry(snapshot: ReportSnapshot, path: string): ArtifactSnapshot | undefined {
    return Object.hasOwn(snapshot.artifacts, path) ? snapshot.artifacts[path] : undefined;
}

/**
 * Give back the citation record at `key`, or `undefined` when the map holds no such own key.
 *
 * An agent authors the citation key of a block, thus the key is untrusted text. The map can be a plain
 * object from a `JSON.parse` of a stored snapshot, and a bracket lookup with a key such as `constructor`
 * finds an inherited member. The `Object.hasOwn` guard admits an own key only, thus an inherited member
 * reads as absent.
 *
 * The card and the appendix both read this one lookup. Thus the two surfaces can never disagree about the
 * bibliography of one key.
 */
export function citationRecordOf(records: CitationRecords | undefined, key: string): CitationRecord | undefined {
    return records !== undefined && Object.hasOwn(records, key) ? records[key] : undefined;
}
