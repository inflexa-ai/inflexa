/**
 * The report session-state store -- the mutable working state of one report session.
 *
 * One row holds the state of one report session, keyed by the thread id. The row
 * holds the in-progress draft document and the pinned snapshot. The row is mutable,
 * and it differs from a recorded version this way. A session reads the state, writes
 * the snapshot one time at the start, and persists the document as the composition
 * proceeds.
 *
 * The snapshot writes at row creation. The write is insert-if-absent through
 * ON CONFLICT DO NOTHING. Thus two concurrent first calls make one row, and the
 * winner keeps its snapshot. The store reads the row back after the write, thus the
 * caller sees the durable state whichever call won.
 *
 * The document column and the snapshot column are each nullable. A row exists with a
 * snapshot and no document yet, because the mint writes the snapshot first and the
 * document lands later. A null column reads as a null value.
 *
 * A read parses the stored document with the draft schema, and the stored snapshot
 * with `parseSnapshot`. The document is the draft document, because an in-progress
 * document can be incomplete. A column that fails a parse reads as a typed error, and
 * it does not crash. An absent row reads as a normal absence.
 *
 * A purge of the analysis removes the row through the analysis-id cascade.
 */

import { type Result, type ResultAsync, err, ok } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { type DbError, tryMutation, tryQuery } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import type { DomainError } from "../lib/result.js";
import { DraftDocumentSchema, type DraftDocument } from "../report-model/draft.js";
import type { ArtifactSnapshot, ReportSnapshot } from "../report-model/reference-resolver.js";
import type { SchemaIssue } from "./report-versions.js";

/**
 * One pinned artifact of a stored snapshot. The value carries the content hash, an
 * optional file type, and optional rows.
 */
const ArtifactSnapshotSchema = z.object({
    hash: z.string(),
    fileType: z.string().nullable().optional(),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).optional(),
});

/** The citation list of a stored snapshot. A snapshot with no list reads as an absent field. */
const CitationsSchema = z.array(z.string()).optional();

function reduceIssues(error: z.ZodError): SchemaIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
    }));
}

/** Put a prefix before the path of each issue, thus a nested parse names the key that failed. */
function prefixIssues(prefix: string, issues: SchemaIssue[]): SchemaIssue[] {
    return issues.map((issue) => ({
        path: issue.path === "" ? prefix : `${prefix}.${issue.path}`,
        message: issue.message,
    }));
}

/** A stored map is a plain object. An array and a null carry no own key that a map read can use. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored snapshot.
 *
 * The artifacts map never goes through a zod object schema. Each object-shaped schema
 * of zod drops a `__proto__` key, and it validates no value under one. The artifact
 * ledger accepts any path, and the mint keeps such a path as an ordinary entry of a
 * null-prototype map (`report-model/mint-snapshot.ts`). Thus a zod parse of the map
 * would resolve a reference to that artifact before a reload and refuse it as absent
 * after one. The walk reads the own keys of the stored map, and it parses each value on
 * its own.
 *
 * The `ReportSnapshot` return type ties this parse to the type of the reference model,
 * thus a change to one shows as a compile error here.
 */
function parseSnapshot(stored: unknown): Result<ReportSnapshot, SchemaIssue[]> {
    if (!isPlainRecord(stored)) {
        return err([{ path: "", message: "the stored snapshot is not an object" }]);
    }
    if (!isPlainRecord(stored.artifacts)) {
        return err([{ path: "artifacts", message: "the artifacts map is not an object" }]);
    }
    const citations = CitationsSchema.safeParse(stored.citations);
    if (!citations.success) {
        return err(prefixIssues("citations", reduceIssues(citations.error)));
    }
    // The map takes a null prototype, the same as the mint, thus a path such as
    // `__proto__` stays an ordinary entry and never reaches a prototype slot.
    const artifacts: Record<string, ArtifactSnapshot> = Object.create(null);
    const issues: SchemaIssue[] = [];
    for (const [path, value] of Object.entries(stored.artifacts)) {
        const parsed = ArtifactSnapshotSchema.safeParse(value);
        if (!parsed.success) {
            issues.push(...prefixIssues(`artifacts.${path}`, reduceIssues(parsed.error)));
            continue;
        }
        artifacts[path] = parsed.data;
    }
    if (issues.length > 0) {
        return err(issues);
    }
    return citations.data === undefined ? ok({ artifacts }) : ok({ artifacts, citations: citations.data });
}

/** The state of one report session, as the store gives it back. */
export interface ReportSessionState {
    readonly threadId: string;
    readonly analysisId: string;
    /** The in-progress draft document, or `null` before the first document lands. */
    readonly document: DraftDocument | null;
    /** The pinned snapshot, or `null` before the mint writes it. */
    readonly snapshot: ReportSnapshot | null;
    readonly createdAt: Date;
}

/** The snapshot and the anchor of a row to create. */
export interface WriteSnapshotInput {
    readonly threadId: string;
    readonly analysisId: string;
    /** The pinned snapshot, stored as given. */
    readonly snapshot: ReportSnapshot;
}

/** The document to persist against an existing row. */
export interface PersistDocumentInput {
    readonly threadId: string;
    /** The draft document, stored as given. */
    readonly document: DraftDocument;
}

/**
 * A stored row that a read cannot parse with the current schemas. It names the
 * thread id and the part that failed, and it carries the reduced issues.
 */
export type SessionStateReadError = {
    readonly type: "corrupt_session_state";
    readonly op: string;
    readonly threadId: string;
    readonly part: "document" | "snapshot";
    readonly issues: readonly SchemaIssue[];
};

// The read error is a `DomainError` (string `type`) -- the compile-time check keeps
// it inside the cross-subsystem error vocabulary.
type _AssertReadError = SessionStateReadError extends DomainError ? true : never;
const _assertReadError: _AssertReadError = true;

export interface ReportSessionStateStore {
    /**
     * The state of a thread, or `null` when no row holds it. A parse failure on a
     * stored column reads as a typed error, and an absent row reads as a normal
     * absence.
     */
    readState(threadId: string): ResultAsync<ReportSessionState | null, DbError | SessionStateReadError>;
    /**
     * Write the snapshot at row creation, insert-if-absent. Two concurrent first
     * calls make one row through ON CONFLICT DO NOTHING, and the winner keeps its
     * snapshot. The store reads the row back, thus the caller sees the durable state.
     */
    writeSnapshot(input: WriteSnapshotInput): ResultAsync<ReportSessionState, DbError | SessionStateReadError>;
    /**
     * Persist the document of a thread. The row must exist, minted by `writeSnapshot`
     * first. The value is `true` when a row took the document, and `false` when no row
     * holds the thread.
     */
    persistDocument(input: PersistDocumentInput): ResultAsync<boolean, DbError>;
}

export interface ReportSessionStateStoreDeps {
    readonly pool: Pool;
    readonly logger?: Logger;
}

/** The full row projection every read shares. */
const STATE_COLUMNS = "thread_id, analysis_id, document, snapshot, created_at";

interface SessionStateRow {
    readonly thread_id: string;
    readonly analysis_id: string;
    readonly document: unknown;
    readonly snapshot: unknown;
    readonly created_at: Date;
}

/**
 * The insert. The row carries the snapshot at creation, and the document lands later
 * through `persistDocument`. ON CONFLICT DO NOTHING keeps the first row, thus a
 * second first call cannot replace the snapshot.
 */
const INSERT_SQL = `INSERT INTO cortex_report_session_state
    (thread_id, analysis_id, snapshot)
  VALUES ($1, $2, $3::jsonb)
  ON CONFLICT (thread_id) DO NOTHING`;

function rowToState(row: SessionStateRow): Result<ReportSessionState, SessionStateReadError> {
    let document: DraftDocument | null = null;
    if (row.document !== null) {
        const parsed = DraftDocumentSchema.safeParse(row.document);
        if (!parsed.success) {
            return err({
                type: "corrupt_session_state",
                op: "report-session-state.read",
                threadId: row.thread_id,
                part: "document",
                issues: reduceIssues(parsed.error),
            });
        }
        document = parsed.data;
    }
    let snapshot: ReportSnapshot | null = null;
    if (row.snapshot !== null) {
        const parsed = parseSnapshot(row.snapshot);
        if (parsed.isErr()) {
            return err({
                type: "corrupt_session_state",
                op: "report-session-state.read",
                threadId: row.thread_id,
                part: "snapshot",
                issues: parsed.error,
            });
        }
        snapshot = parsed.value;
    }
    return ok({
        threadId: row.thread_id,
        analysisId: row.analysis_id,
        document,
        snapshot,
        createdAt: row.created_at,
    });
}

/**
 * Create a `ReportSessionStateStore` bound to a Postgres pool. The
 * `cortex_report_session_state` table is provisioned by the state-init DDL.
 */
export function createReportSessionStateStore({ pool }: ReportSessionStateStoreDeps): ReportSessionStateStore {
    function selectRow(op: string, threadId: string): ResultAsync<SessionStateRow | null, DbError> {
        return tryQuery(op, () =>
            pool.query<SessionStateRow>({
                text: `SELECT ${STATE_COLUMNS} FROM cortex_report_session_state WHERE thread_id = $1`,
                values: [threadId],
            }),
        ).map(({ rows }) => rows[0] ?? null);
    }

    function readState(threadId: string): ResultAsync<ReportSessionState | null, DbError | SessionStateReadError> {
        return selectRow("report-session-state.readState", threadId).andThen((row) => {
            if (!row) return ok(null);
            return rowToState(row);
        });
    }

    function writeSnapshot(input: WriteSnapshotInput): ResultAsync<ReportSessionState, DbError | SessionStateReadError> {
        return tryMutation("report-session-state.writeSnapshot", async () => {
            await pool.query({
                text: INSERT_SQL,
                values: [input.threadId, input.analysisId, JSON.stringify(input.snapshot)],
            });
        })
            .andThen(() => selectRow("report-session-state.writeSnapshot.readBack", input.threadId))
            .andThen((row): Result<ReportSessionState, DbError | SessionStateReadError> => {
                if (!row) {
                    // The insert-if-absent guarantees a row. Absence here is not a normal
                    // condition, thus it rides the error channel.
                    return err({
                        type: "mutation_failed",
                        op: "report-session-state.writeSnapshot.readBack",
                        cause: new Error("row absent after insert-if-absent"),
                    });
                }
                return rowToState(row);
            });
    }

    function persistDocument(input: PersistDocumentInput): ResultAsync<boolean, DbError> {
        return tryMutation("report-session-state.persistDocument", async () => {
            const { rowCount } = await pool.query({
                text: "UPDATE cortex_report_session_state SET document = $2::jsonb WHERE thread_id = $1",
                values: [input.threadId, JSON.stringify(input.document)],
            });
            return (rowCount ?? 0) > 0;
        });
    }

    return { readState, writeSnapshot, persistDocument };
}
