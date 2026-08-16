/**
 * The report version store -- the one recorded version of each report thread.
 *
 * A version is one row. It holds the block document, the pinned snapshot, and the
 * anchor. The store records a version and reads a version. A record on a thread
 * that holds a version replaces the document, the snapshot, and the anchor of that
 * row, whole. The version id stays, thus a consumer that names the version keeps
 * its name.
 *
 * A thread holds at most one version, and a named unique constraint on the thread
 * id enforces it. The record reads nothing before the write, and the constraint
 * routes it: a fresh thread takes the insert arm, and a thread that holds a version
 * takes the replace arm. The store writes the full triple each time, thus a partial
 * update is not representable.
 *
 * The store keeps the snapshot and the anchor as given, and it never pins a
 * snapshot. A read parses the stored document and the stored snapshot with the
 * current schemas. A row that fails a parse reads as a typed error, and it does
 * not crash. An absent row reads as a normal absence.
 *
 * A version outlives its thread. The anchor columns sit on the row, thus a
 * deleted thread leaves a recorded version in place. Only a purge of the analysis
 * removes the version, through the analysis-id cascade.
 */

import { randomUUID } from "node:crypto";

import { type Result, type ResultAsync, err, errAsync, ok } from "neverthrow";
import type { Pool } from "pg";

import { ReportDocumentSchema, type ReportDocument } from "../contracts/report-blocks.js";
import { type DbError, tryMutation, tryQuery } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import type { DomainError } from "../lib/result.js";
import type { ReportSnapshot } from "../report-model/reference-resolver.js";
import { parseSnapshot, reduceIssues, type SchemaIssue } from "./snapshot-parse.js";

export type { SchemaIssue };

/**
 * The name of the unique constraint on thread_id. The write names it as its
 * conflict target, thus the replace arm binds to the one row of the thread.
 */
const THREAD_UNIQUE_CONSTRAINT = "cortex_report_versions_one_per_thread";

/** The anchor and the payload of a version to record. */
export interface RecordVersionInput {
    /** The block document. It rides as `unknown`, and the record parses it. */
    readonly document: unknown;
    /** The pinned snapshot, stored as given. */
    readonly snapshot: ReportSnapshot;
    readonly analysisId: string;
    readonly threadId: string;
    /** The parent conversation thread of the anchor, or `null` when a root has none. */
    readonly parentThreadId: string | null;
    /** The parent transcript position of the anchor, or `null` beside a null parent thread. */
    readonly parentSeq: number | null;
    /** The earlier version that this one reuses. The parent must belong to the same analysis. */
    readonly parentVersionId?: string;
}

/** The stable reference of a recorded version, and how the record landed. */
export interface RecordedVersionRef {
    readonly versionId: string;
    /**
     * `created` minted the row. `replaced` wrote over the one version of the
     * thread, under the same version id.
     */
    readonly outcome: "created" | "replaced";
}

/**
 * A record the store refuses as data, before or in place of a row. Distinct from
 * `DbError`: the request describes a version that the store will not write.
 *
 * The store parses the document and the snapshot before any row. The store
 * refuses a malformed document or a malformed snapshot here as typed data, and
 * no row lands.
 *
 * A second record for one thread is no refusal. The unique constraint on the
 * thread id routes it into the replace arm, and the row carries the new triple.
 * Every constraint trip stays a `DbError`.
 *
 * A `parentVersionId` naming no row is not one of these -- the self foreign key
 * refuses an unknown parent id, and `tryMutation` classifies that refusal as the
 * `constraint_violation` variant of `DbError`.
 */
export type RecordVersionError =
    | {
          readonly type: "malformed_document";
          readonly op: string;
          readonly issues: readonly SchemaIssue[];
      }
    | {
          readonly type: "malformed_snapshot";
          readonly op: string;
          readonly issues: readonly SchemaIssue[];
      }
    | {
          readonly type: "parent_analysis_mismatch";
          readonly op: string;
          readonly analysisId: string;
          readonly parentVersionId: string;
          readonly parentAnalysisId: string;
      }
    | DbError;

/**
 * A stored row that a read cannot parse with the current schemas. It names the
 * version id and the part that failed, and it carries the reduced issues.
 */
export type VersionReadError = {
    readonly type: "corrupt_version";
    readonly op: string;
    readonly versionId: string;
    readonly part: "document" | "snapshot";
    readonly issues: readonly SchemaIssue[];
};

// The two error unions are each a `DomainError` (string `type`) -- the
// compile-time check keeps them inside the cross-subsystem error vocabulary.
type _AssertRecordError = RecordVersionError extends DomainError ? true : never;
const _assertRecordError: _AssertRecordError = true;
type _AssertReadError = VersionReadError extends DomainError ? true : never;
const _assertReadError: _AssertReadError = true;

/** One recorded version, as the store gives it back. */
export interface RecordedVersion {
    readonly versionId: string;
    readonly analysisId: string;
    readonly threadId: string;
    readonly parentThreadId: string | null;
    readonly parentSeq: number | null;
    /** The earlier version that this one reuses, or `null` when it has none. */
    readonly parentVersionId: string | null;
    readonly document: ReportDocument;
    readonly snapshot: ReportSnapshot;
    readonly createdAt: Date;
}

export interface ReportVersionStore {
    /**
     * Record a version. The record parses the document, refuses a malformed value
     * as data with no row, and refuses a parent from a different analysis. It reads
     * nothing before the write. A record on a thread that holds a version replaces
     * that row whole, under the same version id. The snapshot and the anchor store
     * as given, and the reference names a creation or a replacement.
     */
    record(input: RecordVersionInput): ResultAsync<RecordedVersionRef, RecordVersionError>;
    /** One version by its id, or `null` when no row holds it. */
    getVersion(versionId: string): ResultAsync<RecordedVersion | null, DbError | VersionReadError>;
    /** The one version of a thread, or `null` for a thread with no version. */
    getThreadVersion(threadId: string): ResultAsync<RecordedVersion | null, DbError | VersionReadError>;
}

export interface ReportVersionStoreDeps {
    readonly pool: Pool;
    readonly logger?: Logger;
}

/**
 * The full row projection every read shares. `parent_seq` is a bigint, thus the
 * driver hands it back as text, and `rowToVersion` is the single place that turns
 * it into a number.
 */
const VERSION_COLUMNS =
    "version_id, analysis_id, thread_id, parent_thread_id, parent_seq::text AS parent_seq, parent_version_id, document, snapshot, created_at";

interface VersionRow {
    readonly version_id: string;
    readonly analysis_id: string;
    readonly thread_id: string;
    readonly parent_thread_id: string | null;
    readonly parent_seq: string | null;
    readonly parent_version_id: string | null;
    readonly document: unknown;
    readonly snapshot: unknown;
    readonly created_at: Date;
}

/**
 * The write. The row carries no ordinal, thus the statement writes the given
 * columns directly. A fresh thread takes the insert arm, and `created_at` takes
 * the column default. A thread that holds a version trips the named constraint,
 * and the conflict target turns the trip into the replace of that one row.
 *
 * The replace arm writes each given column, thus the stored row equals the input.
 * It writes neither `version_id` nor `created_at`: the version keeps its name, and
 * the row keeps the time of its first record.
 *
 * The returned id names the row that stands. It equals the minted id on the insert
 * arm alone, thus the caller reads which arm ran.
 */
const RECORD_SQL = `INSERT INTO cortex_report_versions
    (version_id, analysis_id, thread_id, parent_thread_id, parent_seq,
     parent_version_id, document, snapshot)
  VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::jsonb, $8::jsonb)
  ON CONFLICT ON CONSTRAINT ${THREAD_UNIQUE_CONSTRAINT} DO UPDATE SET
    analysis_id = EXCLUDED.analysis_id,
    parent_thread_id = EXCLUDED.parent_thread_id,
    parent_seq = EXCLUDED.parent_seq,
    parent_version_id = EXCLUDED.parent_version_id,
    document = EXCLUDED.document,
    snapshot = EXCLUDED.snapshot
  RETURNING version_id`;

function rowToVersion(row: VersionRow): Result<RecordedVersion, VersionReadError> {
    const document = ReportDocumentSchema.safeParse(row.document);
    if (!document.success) {
        return err({ type: "corrupt_version", op: "report-versions.read", versionId: row.version_id, part: "document", issues: reduceIssues(document.error) });
    }
    const snapshot = parseSnapshot(row.snapshot);
    if (snapshot.isErr()) {
        return err({ type: "corrupt_version", op: "report-versions.read", versionId: row.version_id, part: "snapshot", issues: snapshot.error });
    }
    return ok({
        versionId: row.version_id,
        analysisId: row.analysis_id,
        threadId: row.thread_id,
        parentThreadId: row.parent_thread_id,
        parentSeq: row.parent_seq === null ? null : Number(row.parent_seq),
        parentVersionId: row.parent_version_id,
        document: document.data,
        snapshot: snapshot.value,
        createdAt: row.created_at,
    });
}

/**
 * Create a `ReportVersionStore` bound to a Postgres pool. The
 * `cortex_report_versions` table is provisioned by the state-init DDL.
 */
export function createReportVersionStore({ pool }: ReportVersionStoreDeps): ReportVersionStore {
    /**
     * The analysis scope of a parent version, or `null` when no such row exists.
     * Absence is not a verdict here: an unknown parent id falls through to the
     * write, where the self foreign key refuses it as a `DbError`.
     */
    function parentAnalysis(parentVersionId: string): ResultAsync<string | null, DbError> {
        return tryQuery("report-versions.record.parentScope", () =>
            pool.query<{ analysis_id: string }>({
                text: "SELECT analysis_id FROM cortex_report_versions WHERE version_id = $1",
                values: [parentVersionId],
            }),
        ).map(({ rows }) => rows[0]?.analysis_id ?? null);
    }

    function record(input: RecordVersionInput): ResultAsync<RecordedVersionRef, RecordVersionError> {
        const parsed = ReportDocumentSchema.safeParse(input.document);
        if (!parsed.success) {
            return errAsync({ type: "malformed_document", op: "report-versions.record", issues: reduceIssues(parsed.error) });
        }
        const document = parsed.data;

        // The parse guards the row against a caller bug. The store stores the given
        // value, thus the parse changes no value.
        const parsedSnapshot = parseSnapshot(input.snapshot);
        if (parsedSnapshot.isErr()) {
            return errAsync({ type: "malformed_snapshot", op: "report-versions.record", issues: parsedSnapshot.error });
        }

        const write = (): ResultAsync<RecordedVersionRef, RecordVersionError> => {
            const minted = randomUUID();
            return tryMutation("report-versions.record.write", async (): Promise<RecordedVersionRef> => {
                const { rows } = await pool.query<{ version_id: string }>({
                    text: RECORD_SQL,
                    values: [
                        minted,
                        input.analysisId,
                        input.threadId,
                        input.parentThreadId,
                        input.parentSeq,
                        input.parentVersionId ?? null,
                        JSON.stringify(document),
                        JSON.stringify(input.snapshot),
                    ],
                });
                // Each arm of the write returns its row. The replace arm keeps the
                // version id of the row that stood, thus an id that differs from the
                // minted one names a replacement.
                const landed = rows[0]?.version_id ?? minted;
                return { versionId: landed, outcome: landed === minted ? "created" : "replaced" };
            });
        };

        if (input.parentVersionId === undefined) {
            return write();
        }

        const parentVersionId = input.parentVersionId;
        return parentAnalysis(parentVersionId).andThen((parentAnalysisId): ResultAsync<RecordedVersionRef, RecordVersionError> => {
            if (parentAnalysisId !== null && parentAnalysisId !== input.analysisId) {
                return errAsync({
                    type: "parent_analysis_mismatch",
                    op: "report-versions.record",
                    analysisId: input.analysisId,
                    parentVersionId,
                    parentAnalysisId,
                });
            }
            return write();
        });
    }

    function getVersion(versionId: string): ResultAsync<RecordedVersion | null, DbError | VersionReadError> {
        return tryQuery("report-versions.getVersion", () =>
            pool.query<VersionRow>({
                text: `SELECT ${VERSION_COLUMNS} FROM cortex_report_versions WHERE version_id = $1`,
                values: [versionId],
            }),
        ).andThen(({ rows }) => {
            const row = rows[0];
            if (!row) return ok(null);
            return rowToVersion(row);
        });
    }

    function getThreadVersion(threadId: string): ResultAsync<RecordedVersion | null, DbError | VersionReadError> {
        return tryQuery("report-versions.getThreadVersion", () =>
            pool.query<VersionRow>({
                text: `SELECT ${VERSION_COLUMNS} FROM cortex_report_versions WHERE thread_id = $1`,
                values: [threadId],
            }),
        ).andThen(({ rows }) => {
            const row = rows[0];
            if (!row) return ok(null);
            return rowToVersion(row);
        });
    }

    return { record, getVersion, getThreadVersion };
}
