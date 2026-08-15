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
 * snapshot and no document yet, because the pin writes the snapshot first and the
 * document lands later. A null column reads as a null value.
 *
 * A read parses the stored document with the draft schema, and the stored snapshot
 * with `parseSnapshot`. The document is the draft document, because an in-progress
 * document can be incomplete. A column that fails a parse reads as a typed error, and
 * it does not crash. An absent row reads as a normal absence.
 *
 * The row also holds the derivation list of the session. One record chains a derived
 * table to the evidence that made it: the output path, the output hash, the source
 * paths with their hashes, the script hash, and the script text. A record is
 * immutable, and the append refuses a repeated output path. A row that holds no list
 * reads as an empty list.
 *
 * A persist is a compare-and-swap. The load reads the prior document, and the persist
 * lands only when the row still holds it. Thus two concurrent turns cannot both land,
 * and the loser reads the state again.
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
import type { ReportSnapshot } from "../report-model/reference-resolver.js";
import { parseSnapshot, reduceIssues, type SchemaIssue } from "./snapshot-parse.js";

/** One source of a derivation: the pinned path that the script read, and the hash of that path. */
export interface DerivationSource {
    readonly path: string;
    readonly hash: string;
}

/**
 * One derivation of a session.
 *
 * The record chains the derived table to the evidence that made it, thus a verifier mounts the same
 * sources, runs the same script, and compares the output hash. The script text rides the record, thus the
 * verifier needs no second store.
 *
 * `outputPath` is the workspace-root-relative path of the derived file, and it is the key that the served
 * membership holds. A record is immutable, thus a new derivation takes a new output path.
 */
export interface DerivationRecord {
    readonly outputPath: string;
    readonly outputHash: string;
    readonly sources: readonly DerivationSource[];
    readonly scriptHash: string;
    readonly script: string;
}

const DerivationSourceSchema = z.object({ path: z.string(), hash: z.string() });

const DerivationRecordSchema = z.object({
    outputPath: z.string(),
    outputHash: z.string(),
    sources: z.array(DerivationSourceSchema),
    scriptHash: z.string(),
    script: z.string(),
});

const DerivationListSchema = z.array(DerivationRecordSchema);

/**
 * The outcome of an append. `appended` landed the record. `duplicate` means that a record already holds the
 * output path, thus the list stays as it is. `absent` means that no row holds the thread.
 */
export type AppendDerivationOutcome = "appended" | "duplicate" | "absent";

/** The state of one report session, as the store gives it back. */
export interface ReportSessionState {
    readonly threadId: string;
    readonly analysisId: string;
    /** The in-progress draft document, or `null` before the first document lands. */
    readonly document: DraftDocument | null;
    /** The pinned snapshot, or `null` before the pin writes it. */
    readonly snapshot: ReportSnapshot | null;
    /** The derivations of the session, in the order that they landed. A row with no list reads as empty. */
    readonly derivations: readonly DerivationRecord[];
    /** The hash of the draft that the last preview rendered, or `null` before the first preview. */
    readonly renderedDocumentHash: string | null;
    /** The hash that the last eyes capture saw, or `null` before the first look. */
    readonly seenDocumentHash: string | null;
    readonly createdAt: Date;
}

/** The snapshot and the anchor of a row to create. */
export interface WriteSnapshotInput {
    readonly threadId: string;
    readonly analysisId: string;
    /** The pinned snapshot, stored as given. */
    readonly snapshot: ReportSnapshot;
}

/** The document to persist against an existing row, and the prior document that the load read. */
export interface PersistDocumentInput {
    readonly threadId: string;
    /** The draft document, stored as given. */
    readonly document: DraftDocument;
    /**
     * The prior document that the load read, or `null` before the first document lands.
     * The persist lands only when the row still holds it, thus a concurrent turn that
     * landed first turns this persist into a conflict.
     */
    readonly expected: DraftDocument | null;
}

/**
 * The outcome of a persist. `persisted` landed the document. `conflict` means the row
 * no longer holds the expected prior document, thus a concurrent turn landed first and
 * this turn must read the state again. `absent` means no row holds the thread.
 */
export type PersistOutcome = "persisted" | "conflict" | "absent";

/**
 * The outcome of a stamp. `stamped` wrote the hash on the row. `absent` means that no row holds the
 * thread, thus the stamp wrote nothing. A stamp reads nothing before the write.
 */
export type StampOutcome = "stamped" | "absent";

/**
 * The outcome of the seen stamp. `stamped` copied a rendered hash onto the seen hash. `no-rendered`
 * means that the row holds no rendered hash, thus no preview stamped one and the copy found none.
 * `absent` means that no row holds the thread.
 */
export type SeenStampOutcome = "stamped" | "no-rendered" | "absent";

/**
 * A stored row that a read cannot parse with the current schemas. It names the
 * thread id and the part that failed, and it carries the reduced issues.
 */
export type SessionStateReadError = {
    readonly type: "corrupt_session_state";
    readonly op: string;
    readonly threadId: string;
    readonly part: "document" | "snapshot" | "derivations";
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
     * Persist the document of a thread against the prior document that the load read.
     * The row must exist, pinned by `writeSnapshot` first. The update lands only when
     * the row still holds the prior document. `persisted` landed it, `conflict` means a
     * concurrent turn landed first, and `absent` means no row holds the thread.
     */
    persistDocument(input: PersistDocumentInput): ResultAsync<PersistOutcome, DbError>;
    /**
     * Stamp the rendered-document hash on the row. The preview calls it when the page lands, thus the row
     * holds the hash of the draft that the page shows. `absent` means that no row holds the thread.
     */
    stampRendered(threadId: string, hash: string): ResultAsync<StampOutcome, DbError>;
    /**
     * Copy the rendered hash onto the seen hash. The eyes call it after a capture, thus the seen hash holds
     * the hash of the draft that the picture shows, and never the current one. The operation reports whether
     * a rendered hash existed to copy. `no-rendered` means that the row holds none, thus no preview stamped
     * one. `absent` means that no row holds the thread.
     */
    stampSeen(threadId: string): ResultAsync<SeenStampOutcome, DbError>;
    /**
     * Append one derivation record to the list of a thread. The output path is unique across the list,
     * thus a repeated path refuses with `duplicate` and the stored list stays as it is. `absent` means
     * that no row holds the thread.
     */
    appendDerivation(threadId: string, record: DerivationRecord): ResultAsync<AppendDerivationOutcome, DbError>;
}

export interface ReportSessionStateStoreDeps {
    readonly pool: Pool;
    readonly logger?: Logger;
}

/** The full row projection every read shares. */
const STATE_COLUMNS = "thread_id, analysis_id, document, snapshot, derivations, rendered_document_hash, seen_document_hash, created_at";

interface SessionStateRow {
    readonly thread_id: string;
    readonly analysis_id: string;
    readonly document: unknown;
    readonly snapshot: unknown;
    readonly derivations: unknown;
    readonly rendered_document_hash: string | null;
    readonly seen_document_hash: string | null;
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
    // A row that predates the list carries SQL NULL, and a session that derived nothing carries none
    // either. Both read as an empty list, because a session with no derivation has none.
    let derivations: readonly DerivationRecord[] = [];
    if (row.derivations !== null && row.derivations !== undefined) {
        const parsed = DerivationListSchema.safeParse(row.derivations);
        if (!parsed.success) {
            return err({
                type: "corrupt_session_state",
                op: "report-session-state.read",
                threadId: row.thread_id,
                part: "derivations",
                issues: reduceIssues(parsed.error),
            });
        }
        derivations = parsed.data;
    }
    return ok({
        threadId: row.thread_id,
        analysisId: row.analysis_id,
        document,
        snapshot,
        derivations,
        renderedDocumentHash: row.rendered_document_hash,
        seenDocumentHash: row.seen_document_hash,
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

    function persistDocument(input: PersistDocumentInput): ResultAsync<PersistOutcome, DbError> {
        return tryMutation("report-session-state.persistDocument", async () => {
            // The prior document rides as SQL NULL when absent, thus the compare-and-swap
            // matches a fresh row whose document column is null. A JSON `null` would be a
            // distinct jsonb value, and it would never match the null column.
            const expected = input.expected === null ? null : JSON.stringify(input.expected);
            // One statement tells a conflict from an absence. `existed` counts the row, and
            // `updated` counts the compare-and-swap. A row that exists but did not update
            // holds a different prior document, thus a concurrent turn landed first.
            const { rows } = await pool.query<{ existed: number; updated: number }>({
                text: `WITH target AS (
    SELECT 1 FROM cortex_report_session_state WHERE thread_id = $1
  ), updated AS (
    UPDATE cortex_report_session_state
       SET document = $2::jsonb
     WHERE thread_id = $1 AND document IS NOT DISTINCT FROM $3::jsonb
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM target)::int AS existed, (SELECT COUNT(*) FROM updated)::int AS updated`,
                values: [input.threadId, JSON.stringify(input.document), expected],
            });
            const row = rows[0];
            if (row === undefined || row.existed === 0) return "absent";
            return row.updated > 0 ? "persisted" : "conflict";
        });
    }

    function stampRendered(threadId: string, hash: string): ResultAsync<StampOutcome, DbError> {
        return tryMutation("report-session-state.stampRendered", async () => {
            const { rowCount } = await pool.query({
                text: "UPDATE cortex_report_session_state SET rendered_document_hash = $2 WHERE thread_id = $1",
                values: [threadId, hash],
            });
            return (rowCount ?? 0) > 0 ? "stamped" : "absent";
        });
    }

    function stampSeen(threadId: string): ResultAsync<SeenStampOutcome, DbError> {
        return tryMutation("report-session-state.stampSeen", async () => {
            // The seen hash takes the rendered hash of the same row. A copy inside the statement keeps the
            // two markers on one row, thus the eyes copy the rendered hash and never the current one. The
            // `RETURNING` clause reads the copied rendered hash back, thus the caller tells a real stamp from
            // a row that holds no rendered hash to copy.
            const { rows } = await pool.query<{ copied: string | null }>({
                text: "UPDATE cortex_report_session_state SET seen_document_hash = rendered_document_hash WHERE thread_id = $1 RETURNING rendered_document_hash AS copied",
                values: [threadId],
            });
            const row = rows[0];
            if (row === undefined) return "absent";
            return row.copied === null ? "no-rendered" : "stamped";
        });
    }

    function appendDerivation(threadId: string, record: DerivationRecord): ResultAsync<AppendDerivationOutcome, DbError> {
        return tryMutation("report-session-state.appendDerivation", async () => {
            // One statement tells a duplicate from an absence, the same way the persist does. `existed`
            // counts the row, and `appended` counts the update. The name rule reads the stored list inside
            // the statement, thus two concurrent appends of one name cannot both land.
            const { rows } = await pool.query<{ existed: number; appended: number }>({
                text: `WITH target AS (
    SELECT thread_id, COALESCE(derivations, '[]'::jsonb) AS list
      FROM cortex_report_session_state
     WHERE thread_id = $1
  ), appended AS (
    UPDATE cortex_report_session_state AS s
       SET derivations = COALESCE(s.derivations, '[]'::jsonb) || $2::jsonb
      FROM target AS t
     WHERE s.thread_id = t.thread_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(t.list) AS held WHERE held->>'outputPath' = $3
       )
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM target)::int AS existed, (SELECT COUNT(*) FROM appended)::int AS appended`,
                // The record rides as a one-element array, thus the `||` operator appends one element and
                // never merges the fields of an object into the list.
                values: [threadId, JSON.stringify([record]), record.outputPath],
            });
            const row = rows[0];
            if (row === undefined || row.existed === 0) return "absent";
            return row.appended > 0 ? "appended" : "duplicate";
        });
    }

    return { readState, writeSnapshot, persistDocument, stampRendered, stampSeen, appendDerivation };
}
