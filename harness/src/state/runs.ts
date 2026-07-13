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

import type { DbError } from "../lib/db-result.js";
import { tryMutation, tryQuery } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import type { CortexRunRow } from "./schema.js";

export interface InsertRunInput {
    runId: string;
    analysisId: string;
    threadId?: string | null;
    workflowName: string;
    planId?: string | null;
    mandateJti?: string | null; // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    mandateExpiresAt?: string | null; // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
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
    const now = new Date().toISOString();
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

function isPartialUniqueViolation(err: unknown): boolean {
    if (err === null || typeof err !== "object") return false;
    const e = err as { code?: string; constraint?: string };
    return e.code === "23505" && e.constraint === "idx_cortex_runs_active_plan";
}

/**
 * Recover the active run row for `(analysisId, planId)` after `insertRun`
 * raises `RunDedupCollisionError`. The partial-unique index guarantees at
 * most one match.
 */
export function queryActiveRun(pool: Querier, analysisId: string, planId: string | null): ResultAsync<CortexRunRow | null, DbError> {
    return tryQuery("runs.queryActiveRun", async () => {
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1
              AND plan_id IS NOT DISTINCT FROM $2
              AND status IN ('running','suspended_insufficient_funds')`,
            values: [analysisId, planId],
        });
        const row = result.rows[0];
        return row ? mapRunRow(row) : null;
    });
}

export function updateRunStatus(
    pool: Querier,
    runId: string,
    status: "running" | "completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds",
    error?: string | null,
): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    const isTerminal = status === "completed" || status === "partial" || status === "failed" || status === "canceled";
    return tryMutation("runs.updateRunStatus", async () => {
        await pool.query({
            text: `UPDATE cortex_runs
            SET status = $1, completed_at = $2, error = $3
            WHERE run_id = $4`,
            values: [status, isTerminal ? now : null, error ?? null, runId],
        });
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

export function queryRun(pool: Querier, runId: string): ResultAsync<CortexRunRow | null, DbError> {
    return tryQuery("runs.queryRun", async () => {
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE run_id = $1`,
            values: [runId],
        });
        const row = result.rows[0];
        return row ? mapRunRow(row) : null;
    });
}

export function queryRunsByAnalysis(
    pool: Querier,
    analysisId: string,
    { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): ResultAsync<CortexRunRow[], DbError> {
    return tryQuery("runs.queryRunsByAnalysis", async () => {
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1
            ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
            values: [analysisId, limit, offset],
        });
        return result.rows.map(mapRunRow);
    });
}

export function queryRunsByThread(
    pool: Querier,
    analysisId: string,
    threadId: string,
    { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): ResultAsync<CortexRunRow[], DbError> {
    return tryQuery("runs.queryRunsByThread", async () => {
        const result = await pool.query({
            text: `SELECT run_id, analysis_id, thread_id, workflow_name,
                   status, started_at, completed_at, error, parts,
                   mandate_jti, mandate_expires_at, plan_id -- oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
            FROM cortex_runs
            WHERE analysis_id = $1 AND thread_id = $2
            ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
            values: [analysisId, threadId, limit, offset],
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

function mapRunRow(row: Record<string, unknown>): CortexRunRow {
    // JSONB is parsed by `pg` into native arrays/objects. Treat legacy TEXT
    // rows (if anything slipped through) as strings and parse them.
    let parts: unknown[] | null = null;
    if (Array.isArray(row.parts)) {
        parts = row.parts as unknown[];
    } else if (typeof row.parts === "string") {
        try {
            parts = JSON.parse(row.parts);
        } catch {
            /* malformed — treat as null */
        }
    }
    return {
        runId: row.run_id as string,
        analysisId: row.analysis_id as string,
        threadId: (row.thread_id as string) ?? null,
        workflowName: row.workflow_name as string,
        status: row.status as CortexRunRow["status"],
        startedAt: row.started_at as string,
        completedAt: (row.completed_at as string) ?? null,
        error: (row.error as string) ?? null,
        parts,
        mandateJti: (row.mandate_jti as string) ?? null, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
        mandateExpiresAt: (row.mandate_expires_at as string) ?? null, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
        planId: (row.plan_id as string) ?? null,
    };
}
