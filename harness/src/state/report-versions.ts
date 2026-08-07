/**
 * The report version store -- the append-only record of report versions.
 *
 * A version is one immutable row. It holds the block document, the pinned
 * snapshot, and the anchor. The store records a version and reads a version. It
 * never updates a recorded row, thus a correction is a new version.
 *
 * A thread holds at most one version, and a named unique constraint on the thread
 * id enforces it. The record reads nothing before the insert. A second record for
 * one thread trips the constraint, and the store maps that trip to the typed
 * refusal thread_already_holds_version.
 *
 * The store keeps the snapshot and the anchor as given, and it never mints a
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
import { z } from "zod";

import { ReportDocumentSchema, type ReportDocument } from "../contracts/report-blocks.js";
import { type DbError, tryMutation, tryQuery } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import type { DomainError } from "../lib/result.js";
import type { ReportSnapshot } from "../report-model/reference-resolver.js";

/**
 * The name of the unique constraint on thread_id. Postgres reports it on a
 * duplicate-thread refusal, and the record matches it to map the trip to the
 * thread_already_holds_version refusal.
 */
const THREAD_UNIQUE_CONSTRAINT = "cortex_report_versions_one_per_thread";

/**
 * One pinned artifact of a stored snapshot. The value carries the content hash,
 * an optional file type, and optional rows. The `z.ZodType<ReportSnapshot>`
 * annotation below keeps this schema and the `ArtifactSnapshot` type of the
 * reference model in step, thus a change to one shows as a compile error there.
 */
const ArtifactSnapshotSchema = z.object({
    hash: z.string(),
    fileType: z.string().nullable().optional(),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).optional(),
});

/**
 * The stored-snapshot schema. The annotation ties the parse output to the
 * `ReportSnapshot` type of the reference model, thus the store and the structural
 * validation never disagree about the snapshot shape. The mint never fills `rows`,
 * but the schema admits what the type admits.
 */
const ReportSnapshotSchema: z.ZodType<ReportSnapshot> = z.object({
    artifacts: z.record(z.string(), ArtifactSnapshotSchema),
    citations: z.array(z.string()).optional(),
});

/** One reduced schema issue -- the dotted path and the message, without the rest. */
export interface SchemaIssue {
    readonly path: string;
    readonly message: string;
}

function reduceIssues(error: z.ZodError): SchemaIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
    }));
}

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

/** The stable reference of a freshly recorded version. */
export interface RecordedVersionRef {
    readonly versionId: string;
}

/**
 * A record the store refuses as data, before or in place of a row. Distinct from
 * `DbError`: the request describes a version that the store will not write.
 *
 * The store parses the document and the snapshot before any row. The store
 * refuses a malformed document or a malformed snapshot here as typed data, and
 * no row lands.
 *
 * A second record for one thread is `thread_already_holds_version`. The unique
 * constraint on the thread id trips, and the record maps that one constraint by
 * its name. Every other constraint trip stays a `DbError`.
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
    | {
          readonly type: "thread_already_holds_version";
          readonly op: string;
          readonly threadId: string;
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
     * nothing before the insert. A second record for one thread refuses with
     * thread_already_holds_version. The snapshot and the anchor store as given.
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
 * The insert. The row carries no ordinal, thus the statement writes the given
 * columns directly. `created_at` takes the column default.
 */
const INSERT_SQL = `INSERT INTO cortex_report_versions
    (version_id, analysis_id, thread_id, parent_thread_id, parent_seq,
     parent_version_id, document, snapshot)
  VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::jsonb, $8::jsonb)`;

function rowToVersion(row: VersionRow): Result<RecordedVersion, VersionReadError> {
    const document = ReportDocumentSchema.safeParse(row.document);
    if (!document.success) {
        return err({ type: "corrupt_version", op: "report-versions.read", versionId: row.version_id, part: "document", issues: reduceIssues(document.error) });
    }
    const snapshot = ReportSnapshotSchema.safeParse(row.snapshot);
    if (!snapshot.success) {
        return err({ type: "corrupt_version", op: "report-versions.read", versionId: row.version_id, part: "snapshot", issues: reduceIssues(snapshot.error) });
    }
    return ok({
        versionId: row.version_id,
        analysisId: row.analysis_id,
        threadId: row.thread_id,
        parentThreadId: row.parent_thread_id,
        parentSeq: row.parent_seq === null ? null : Number(row.parent_seq),
        parentVersionId: row.parent_version_id,
        document: document.data,
        snapshot: snapshot.data,
        createdAt: row.created_at,
    });
}

/**
 * Map an insert failure to a record refusal. A trip of the thread constraint is
 * thread_already_holds_version. Every other DbError stays unchanged.
 */
function mapInsertError(error: DbError, threadId: string): RecordVersionError {
    if (error.type === "constraint_violation" && error.constraint === THREAD_UNIQUE_CONSTRAINT) {
        return { type: "thread_already_holds_version", op: "report-versions.record", threadId };
    }
    return error;
}

/**
 * Create a `ReportVersionStore` bound to a Postgres pool. The
 * `cortex_report_versions` table is provisioned by the state-init DDL.
 */
export function createReportVersionStore({ pool }: ReportVersionStoreDeps): ReportVersionStore {
    /**
     * The analysis scope of a parent version, or `null` when no such row exists.
     * Absence is not a verdict here: an unknown parent id falls through to the
     * insert, where the self foreign key refuses it as a `DbError`.
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

        // The parse guards the row against a caller bug through a cast. The store
        // stores the given value, thus the parse changes no value.
        const parsedSnapshot = ReportSnapshotSchema.safeParse(input.snapshot);
        if (!parsedSnapshot.success) {
            return errAsync({ type: "malformed_snapshot", op: "report-versions.record", issues: reduceIssues(parsedSnapshot.error) });
        }

        const insert = (): ResultAsync<RecordedVersionRef, RecordVersionError> => {
            const versionId = randomUUID();
            return tryMutation("report-versions.record.insert", async () => {
                await pool.query({
                    text: INSERT_SQL,
                    values: [
                        versionId,
                        input.analysisId,
                        input.threadId,
                        input.parentThreadId,
                        input.parentSeq,
                        input.parentVersionId ?? null,
                        JSON.stringify(document),
                        JSON.stringify(input.snapshot),
                    ],
                });
                return { versionId };
            }).mapErr((error) => mapInsertError(error, input.threadId));
        };

        if (input.parentVersionId === undefined) {
            return insert();
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
            return insert();
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
