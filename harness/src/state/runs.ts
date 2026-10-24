/**
 * `cortex_runs` operations — run lifecycle, dedup, run-mandate persistence. oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
 *
 * Every read/write returns `ResultAsync<T, DbError>` — a driver failure rides
 * the err channel, absence rides ok (`ok(null)` / `ok([])`). The lone exception
 * is `insertRun`'s dedup collision: `RunDedupCollisionError` is a control-flow
 * signal (the caller recovers via `queryActiveRun`), not a storage failure, so
 * it is thrown verbatim ABOVE the Result boundary rather than mapped to a
 * `DbError`. Every other write maps SQLSTATE 23505/23503/23502/23514 to
 * `err(constraint_violation)` via `tryMutation`.
 */

import type { ResultAsync } from "neverthrow";
import type { QueryConfig } from "pg";

import { stripNulCharacters } from "../input-sanitization.js";
import type { DbError } from "../lib/db-result.js";
import { tryMutation, tryQuery } from "../lib/db-result.js";
import { UnknownArraySchema } from "../lib/unknown-containers.js";
import { z } from "zod";
import type { Querier } from "./db.js";
import { CortexRunRowSchema, type CortexRunRow, type SynthesisStatus } from "./schema.js";

/**
 * The row-reading surface of this module: one query over the text or config form, whose rows the mapRunRow
 * parser types. A computed test fake satisfies this shape directly, where the row-generic of `Querier`
 * cannot be implemented by a fake that computes its rows.
 */
export type RunRowQuerier = {
    query(queryTextOrConfig: string | QueryConfig, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export type InsertRunInput = {
    runId: string;
    analysisId: string;
    threadId?: string | null;
    workflowName: string;
    planId?: string | null;
    mandateJti?: string | null; // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    mandateExpiresAt?: string | null; // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    /** The start time as an ISO string. Without it, the row gets the clock of the host. */
    startedAt?: string;
};

export type RunReservation = {
    readonly row: CortexRunRow;
    readonly inserted: boolean;
};

/** Bounded run rows paired with the true count before limit/offset. */
export type RunPage = {
    readonly runs: CortexRunRow[];
    readonly total: number;
};

export class RunIdentityCollisionError extends Error {
    constructor(readonly runId: string) {
        super(`run id ${runId} already belongs to another analysis`);
        this.name = "RunIdentityCollisionError";
    }
}

/**
 * Raised when `insertRun` collides with the partial-unique index
 * `idx_cortex_runs_active_plan` — i.e., an active run already exists for
 * `(analysisId, planId)`. Callers SHOULD recover via `queryActiveRun` and
 * return the existing `runId` instead of starting a fresh workflow.
 */
export class RunDedupCollisionError extends Error {
    constructor(
        readonly analysisId: string,
        readonly planId: string | null,
    ) {
        super(`active run already exists for (analysisId=${analysisId}, planId=${planId ?? "null"})`);
        this.name = "RunDedupCollisionError";
    }
}

/**
 * Insert the run row. On the partial-unique index collision
 * (`idx_cortex_runs_active_plan`) the function throws `RunDedupCollisionError`
 * verbatim — a control-flow signal the caller recovers from via
 * `queryActiveRun`, NOT a `DbError`. The throw rides out of the `ResultAsync`
 * as a rejected promise (so an `await insertRun(...).match(...)`-free caller
 * sees the same exception it always did); every other driver failure stays in
 * the err channel as a `DbError`.
 */
export function insertRun(pool: Querier, input: InsertRunInput): ResultAsync<void, DbError> {
    const now = input.startedAt ?? new Date().toISOString();
    return tryMutation("runs.insertRun", async () => {
        await pool.query({
            text: `INSERT INTO cortex_runs
            (run_id, analysis_id, thread_id, workflow_name,
             status, started_at, plan_id, mandate_jti, mandate_expires_at) -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8)`,
            values: [
                input.runId,
                input.analysisId,
                input.threadId ?? null,
                input.workflowName,
                now,
                input.planId ?? null,
                input.mandateJti ?? null, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
                input.mandateExpiresAt ?? null, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            ],
        });
    }).mapErr((e) => {
        // The dedup collision is control flow, not a storage failure — re-throw it
        // verbatim ABOVE the Result boundary so the caller's existing
        // catch(RunDedupCollisionError) path still fires. `mapErr` runs in the
        // ResultAsync's promise body, so the throw surfaces as a rejection.
        if (isPartialUniqueViolation(e.cause)) {
            throw new RunDedupCollisionError(input.analysisId, input.planId ?? null);
        }
        return e;
    });
}

/** Reserve a deterministic run id, treating same-analysis PK conflict as redelivery. */
export function reserveRunById(pool: Querier, input: InsertRunInput): ResultAsync<RunReservation, DbError> {
    const now = input.startedAt ?? new Date().toISOString();
    return tryMutation("runs.reserveRunById", async () => {
        const result = await pool.query({
            text: `INSERT INTO cortex_runs
            (run_id, analysis_id, thread_id, workflow_name,
             status, started_at, plan_id, mandate_jti, mandate_expires_at)
            VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8)
            ON CONFLICT (run_id) DO NOTHING
            RETURNING run_id`,
            values: [
                input.runId,
                input.analysisId,
                input.threadId ?? null,
                input.workflowName,
                now,
                input.planId ?? null,
                input.mandateJti ?? null,
                input.mandateExpiresAt ?? null,
            ],
        });
        return (result.rowCount ?? 0) > 0;
    }).andThen((inserted) =>
        tryQuery("runs.reserveRunById.reload", async () => {
            const result = await pool.query<Record<string, unknown>>({
                text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                       status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                       mandate_jti, mandate_expires_at, plan_id
                FROM cortex_runs
                WHERE run_id = $1`,
                values: [input.runId],
            });
            return result.rows[0] ?? null;
        }).map((row) => {
            if (!row || row.analysis_id !== input.analysisId) throw new RunIdentityCollisionError(input.runId);
            return { row: mapRunRow(row), inserted };
        }),
    );
}

/** The two pg error fields a dedup collision is read from; a driver error is an `Error` carrying them as own fields. */
const PgErrorIdentitySchema = z.object({ code: z.string(), constraint: z.string() });

function isPartialUniqueViolation(err: unknown): boolean {
    const parsed = PgErrorIdentitySchema.safeParse(err);
    return parsed.success && parsed.data.code === "23505" && parsed.data.constraint === "idx_cortex_runs_active_plan";
}

/**
 * Recover the active run row for `(analysisId, planId)` after `insertRun`
 * raises `RunDedupCollisionError`. The partial-unique index guarantees at
 * most one match.
 */
export function queryActiveRun(pool: Querier, analysisId: string, planId: string | null): ResultAsync<CortexRunRow | null, DbError> {
    return tryQuery("runs.queryActiveRun", async () => {
        const result = await pool.query<Record<string, unknown>>({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1
              AND plan_id IS NOT DISTINCT FROM $2
              AND status = 'running'`,
            values: [analysisId, planId],
        });
        const row = result.rows[0];
        return row ? mapRunRow(row) : null;
    });
}

/** The optional text filter of the run reads. */
export type RunTextFilter = {
    /** A part of the run id or of the plan title, with no regard to case. Each character matches only itself. */
    q?: string;
};

/**
 * The SQL condition of the text filter `q` for the bound placeholder `placeholder`. A run matches when its id holds the
 * text, or when the `title` of the plan of the same analysis holds it. `strpos` is the test, because `LIKE` would turn
 * `%` and `_` of the input into wildcards. The `analysis_id` condition keeps the plan of a different analysis out, the
 * same scope as `loadPlan`.
 */
function runTextCondition(placeholder: string): string {
    return `(strpos(lower(run_id), lower(${placeholder}::text)) > 0
              OR EXISTS (SELECT 1 FROM cortex_plans p
                         WHERE p.plan_id = cortex_runs.plan_id
                           AND p.analysis_id = cortex_runs.analysis_id
                           AND jsonb_typeof(p.plan -> 'title') = 'string'
                           AND strpos(lower(p.plan ->> 'title'), lower(${placeholder}::text)) > 0))`;
}

/**
 * Every NON-TERMINAL run of an analysis, newest-first and deliberately unbounded.
 *
 * The counterpart to {@link queryRunsByAnalysis}, which answers "the newest N runs" — a windowed
 * question, and the wrong one for a host driving live surfaces. Ordering by `started_at DESC` and
 * capping means the run most worth watching is the first to fall out: a long analysis still going
 * while ten short ones start and finish after it leaves the window entirely, so a host reading only
 * that window loses its progress AND never learns it terminated.
 *
 * Unbounded is safe here in a way it is not for the general listing: this result is capped by the
 * analysis's live concurrency, not by its history, and a run leaves the set permanently when it
 * finishes.
 *
 * The status set is the one {@link queryActiveRun} uses — non-terminal means `running`. Keep the two
 * in step: a new non-terminal status added to one and not the other makes a live run invisible to
 * exactly one of its readers.
 *
 * With `q`, only the runs that the text filter selects are members.
 */
export function queryActiveRunsByAnalysis(pool: Querier, analysisId: string, { q }: RunTextFilter = {}): ResultAsync<CortexRunRow[], DbError> {
    return tryQuery("runs.queryActiveRunsByAnalysis", async () => {
        const values: unknown[] = [analysisId];
        const text = q === undefined ? "" : `AND ${runTextCondition(`$${values.push(q)}`)}`;
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1
              AND status = 'running'
              ${text}
            ORDER BY started_at DESC`,
            values,
        });
        return result.rows.map(mapRunRow);
    });
}

/**
 * How long a reserved run may wait for its workflow before {@link reconcileOrphanedRuns} fails it. A launch writes
 * the workflow row seconds after the reservation, and the margin covers a slow authorization gate of a managed host.
 */
export const ORPHANED_RUN_GRACE_MS = 5 * 60 * 1000;

/**
 * Fail each `running` run that started before the grace and that has no DBOS workflow row, and give the ids of
 * the runs that it failed.
 *
 * A launch reserves the run row, then starts the workflow. A host that dies between the two, or a start that throws
 * while the following status write also fails, leaves a `running` row that no workflow will ever settle. That row
 * holds the active-plan slot, thus each later launch of the plan answers `started: false` for a run that never
 * started. Recovery cannot help, because no workflow row exists to recover.
 *
 * Only a run with no workflow row at all is failed. A run whose workflow exists, also a terminal one, is the
 * workflow's to settle: a failed mark could misname a run that completed. Call it after `DBOS.launch()`, thus a
 * recovered workflow is visible to the predicate.
 */
export function reconcileOrphanedRuns(pool: Querier, opts: { now?: number; graceMs?: number } = {}): ResultAsync<string[], DbError> {
    const now = opts.now ?? Date.now();
    const before = new Date(now - (opts.graceMs ?? ORPHANED_RUN_GRACE_MS)).toISOString();
    return tryMutation("runs.reconcileOrphanedRuns", async () => {
        const result = await pool.query<{ run_id: string }>({
            text: `UPDATE cortex_runs r
            SET status = 'failed',
                error = 'The workflow of the run never started.',
                completed_at = $1
            WHERE r.status = 'running'
              AND r.started_at < $2
              AND NOT EXISTS (SELECT 1 FROM dbos.workflow_status ws WHERE ws.workflow_uuid = r.run_id)
            RETURNING r.run_id`,
            values: [new Date(now).toISOString(), before],
        });
        return result.rows.map((row) => row.run_id);
    });
}

/**
 * Write a status to a run row that is still `running`, and report whether the row changed. The first terminal write
 * of a run wins: a row that already holds a terminal status keeps its status, its `completed_at`, and its error.
 * The error text loses each NUL character, because Postgres rejects a NUL in text and the write must not fail for its own value.
 */
export function updateRunStatus(
    pool: Querier,
    runId: string,
    status: "running" | "completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds",
    error?: string | null,
): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    const isTerminal =
        status === "completed" || status === "partial" || status === "failed" || status === "canceled" || status === "suspended_insufficient_funds";
    return tryMutation("runs.updateRunStatus", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_runs
            SET status = $1, completed_at = $2, error = $3
            WHERE run_id = $4 AND status = 'running'`,
            values: [status, isTerminal ? now : null, error === undefined || error === null ? null : stripNulCharacters(error), runId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

/**
 * Conditionally transition an ACTIVE run to `canceled`, stamping `completed_at`
 * and recording `reason` in `error` (the same column `collectAndComplete`
 * stamps `external_cancel` into). Reports whether a row transitioned — false
 * means the run was already terminal (e.g. it completed concurrently with an
 * external cancel). The guarded set is the active set `queryActiveRun`
 * deduplicates on.
 */
export function markRunCanceledIfActive(pool: Querier, runId: string, reason: string): ResultAsync<boolean, DbError> {
    const now = new Date().toISOString();
    return tryMutation("runs.markRunCanceledIfActive", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_runs
            SET status = 'canceled', completed_at = $2, error = $3
            WHERE run_id = $1 AND status = 'running'`,
            values: [runId, now, reason],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function promoteFailedToPartial(pool: Querier, runId: string): ResultAsync<boolean, DbError> {
    return tryMutation("runs.promoteFailedToPartial", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_runs SET status = 'partial'
             WHERE run_id = $1 AND status = 'failed'`,
            values: [runId],
        });
        return (result.rowCount ?? 0) > 0;
    });
}

export function queryRun(pool: RunRowQuerier, runId: string): ResultAsync<CortexRunRow | null, DbError> {
    return tryQuery("runs.queryRun", async () => {
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE run_id = $1`,
            values: [runId],
        });
        const row = result.rows[0];
        return row ? mapRunRow(row) : null;
    });
}

/**
 * One window of the runs of an analysis, newest start first. With `q`, the window holds only the runs that the text
 * filter selects: the filter applies before `limit` and `offset`, and it does not change the order.
 */
export function queryRunsByAnalysis(
    pool: Querier,
    analysisId: string,
    { limit = 50, offset = 0, q }: { limit?: number; offset?: number } & RunTextFilter = {},
): ResultAsync<CortexRunRow[], DbError> {
    return tryQuery("runs.queryRunsByAnalysis", async () => {
        const values: unknown[] = [analysisId, limit, offset];
        const text = q === undefined ? "" : `AND ${runTextCondition(`$${values.push(q)}`)}`;
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1
              ${text}
            ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
            values,
        });
        return result.rows.map(mapRunRow);
    });
}

/**
 * The count of the runs of an analysis, in one statement. With `q`, the count holds only the runs that the text filter
 * selects, thus it agrees with the windows of {@link queryRunsByAnalysis} for the same `q`.
 */
export function countRunsByAnalysis(pool: Querier, analysisId: string, { q }: RunTextFilter = {}): ResultAsync<number, DbError> {
    return tryQuery("runs.countRunsByAnalysis", async () => {
        const values: unknown[] = [analysisId];
        const text = q === undefined ? "" : `AND ${runTextCondition(`$${values.push(q)}`)}`;
        const result = await pool.query<{ total: number }>({
            text: `SELECT COUNT(*)::int AS total
            FROM cortex_runs
            WHERE analysis_id = $1
              ${text}`,
            values,
        });
        return Number(result.rows[0]?.total ?? 0);
    });
}

/**
 * The run ids of one plan of one analysis, newest start first, at most `limit`.
 * The run id breaks a tie of start times, highest first. A plan with no run gives
 * an empty list.
 */
export function queryRunIdsByPlan(pool: Querier, opts: { analysisId: string; planId: string; limit: number }): ResultAsync<string[], DbError> {
    return tryQuery("runs.queryRunIdsByPlan", async () => {
        const result = await pool.query<{ run_id: string }>({
            text: `SELECT run_id FROM cortex_runs
            WHERE analysis_id = $1 AND plan_id = $2
            ORDER BY started_at DESC, run_id DESC
            LIMIT $3`,
            values: [opts.analysisId, opts.planId, opts.limit],
        });
        return result.rows.map((row) => row.run_id);
    });
}

/**
 * The newest run of one plan of one analysis, or `null` for a plan with no run. The order is the one of
 * {@link queryRunIdsByPlan}: the latest start first, and the highest run id on a tie of start times.
 */
export function queryNewestPlanRun(
    pool: Querier,
    opts: { analysisId: string; planId: string },
): ResultAsync<{ runId: string; startedAt: string } | null, DbError> {
    return tryQuery("runs.queryNewestPlanRun", async () => {
        const result = await pool.query<{ run_id: string; started_at: string }>({
            text: `SELECT run_id, started_at FROM cortex_runs
            WHERE analysis_id = $1 AND plan_id = $2
            ORDER BY started_at DESC, run_id DESC
            LIMIT 1`,
            values: [opts.analysisId, opts.planId],
        });
        const row = result.rows[0];
        return row ? { runId: row.run_id, startedAt: row.started_at } : null;
    });
}

/**
 * Read the analysis's non-terminal run activity without coupling it to a
 * conversation thread. The total is counted before the detail limit so a
 * bounded prompt projection can disclose omitted rows.
 */
export function queryNonTerminalRunsByAnalysis(pool: Querier, analysisId: string, limit = 20): ResultAsync<RunPage, DbError> {
    return tryQuery("runs.queryNonTerminalRunsByAnalysis", async () => {
        const countResult = await pool.query<Record<string, unknown>>({
            text: `SELECT COUNT(*)::int AS total
            FROM cortex_runs
            WHERE analysis_id = $1
              AND status = 'running'`,
            values: [analysisId],
        });
        const rowsResult = await pool.query<Record<string, unknown>>({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id
            FROM cortex_runs
            WHERE analysis_id = $1
              AND status = 'running'
            ORDER BY started_at DESC,
                     run_id DESC
            LIMIT $2`,
            values: [analysisId, limit],
        });
        return {
            runs: rowsResult.rows.map(mapRunRow),
            total: Number(countResult.rows[0]?.total ?? 0),
        };
    });
}

/**
 * Read one stable inspection page: running first, then each other run. This is deliberately separate from
 * {@link queryRunsByAnalysis}, whose chronological order is an embedder/UI
 * contract.
 */
export function queryRunsForInspection(
    pool: RunRowQuerier,
    analysisId: string,
    { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): ResultAsync<RunPage, DbError> {
    return tryQuery("runs.queryRunsForInspection", async () => {
        const countResult = await pool.query({
            text: "SELECT COUNT(*)::int AS total FROM cortex_runs WHERE analysis_id = $1",
            values: [analysisId],
        });
        const rowsResult = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id
            FROM cortex_runs
            WHERE analysis_id = $1
            ORDER BY CASE status
                         WHEN 'running' THEN 0
                         ELSE 1
                     END,
                     started_at DESC,
                     run_id DESC
            LIMIT $2 OFFSET $3`,
            values: [analysisId, limit, offset],
        });
        return {
            runs: rowsResult.rows.map(mapRunRow),
            total: Number(countResult.rows[0]?.total ?? 0),
        };
    });
}

/** The runs of one thread of an analysis, newest start first. With `q`, the text filter applies before the window. */
export function queryRunsByThread(
    pool: Querier,
    analysisId: string,
    threadId: string,
    { limit = 50, offset = 0, q }: { limit?: number; offset?: number } & RunTextFilter = {},
): ResultAsync<CortexRunRow[], DbError> {
    return tryQuery("runs.queryRunsByThread", async () => {
        const values: unknown[] = [analysisId, threadId, limit, offset];
        const text = q === undefined ? "" : `AND ${runTextCondition(`$${values.push(q)}`)}`;
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, synthesis_status, synthesis_reason, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1 AND thread_id = $2
              ${text}
            ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
            values,
        });
        return result.rows.map(mapRunRow);
    });
}

/**
 * Persist the run mandate jti + expiry for a run. oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
 * Called by `authorizeForRun` after a successful mint so the cancel
 * handler can revoke the mandate by `runId → jti` lookup. oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
 * The JWT itself is NOT persisted — it rides in DBOS workflow input.
 */
export function setRunMandate(pool: Querier, runId: string, jti: string, expiresAt: string): ResultAsync<void, DbError> {
    // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    return tryMutation("runs.setRunMandate", async () => {
        // oss-core-managed-ok: run-mandate ledger op label
        await pool.query({
            text: `UPDATE cortex_runs
            SET mandate_jti = $1, mandate_expires_at = $2 -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            WHERE run_id = $3`,
            values: [jti, expiresAt, runId],
        });
    });
}

/**
 * Record the run-level synthesis outcome on the run ledger. `synthesisReason`
 * carries operator-facing detail for a skipped/failed outcome; it stays null
 * for the "produced" case.
 */
export function setRunSynthesisOutcome(
    pool: Querier,
    runId: string,
    synthesisStatus: SynthesisStatus,
    synthesisReason?: string | null,
): ResultAsync<void, DbError> {
    return tryMutation("runs.setRunSynthesisOutcome", async () => {
        await pool.query({
            text: `UPDATE cortex_runs
            SET synthesis_status = $1, synthesis_reason = $2
            WHERE run_id = $3`,
            values: [synthesisStatus, synthesisReason ?? null, runId],
        });
    });
}

function mapRunRow(row: Record<string, unknown>): CortexRunRow {
    // JSONB is parsed by `pg` into native arrays/objects. Treat legacy TEXT
    // rows (if anything slipped through) as strings and parse them. A parts
    // value that survives neither shape reads as null, like a row with no parts.
    let parts: unknown = row.parts;
    if (typeof parts === "string") {
        try {
            parts = JSON.parse(parts);
        } catch {
            parts = null;
        }
    }
    const parsedParts = UnknownArraySchema.safeParse(parts);
    return CortexRunRowSchema.parse({
        runId: row.run_id,
        analysisId: row.analysis_id,
        threadId: row.thread_id ?? null,
        workflowName: row.workflow_name,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? null,
        error: row.error ?? null,
        synthesisStatus: row.synthesis_status ?? null,
        synthesisReason: row.synthesis_reason ?? null,
        parts: parsedParts.success ? parsedParts.data : null,
        mandateJti: row.mandate_jti ?? null, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
        mandateExpiresAt: row.mandate_expires_at ?? null, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
        planId: row.plan_id ?? null,
    });
}
