/**
 * `cortex_step_executions` operations — step lifecycle and retry telemetry.
 */

import type { ResultAsync } from "neverthrow";
import type { QueryConfig } from "pg";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";
import { StepExecutionRowSchema, type StepExecutionRow } from "./schema.js";

/**
 * The row-reading surface of this module: one query over the text or config form, whose rows the
 * mapStepExecutionRow parser types. A computed test fake satisfies this shape directly, where the
 * row-generic of `Querier` cannot be implemented by a fake that computes its rows.
 */
export type StepRowQuerier = {
    query(queryTextOrConfig: string | QueryConfig, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export type SeedStepExecutionRow = {
    runId: string;
    stepId: string;
    analysisId: string;
    wave: number;
    agentId: string;
};

/**
 * Seed one `pending` row per plan step at run start (`started_at` NULL — no
 * attempt has happened yet; `attempts`/`hit_max_steps` lean on their column
 * defaults). `ON CONFLICT DO NOTHING`, NOT the mark-running upsert: on DBOS
 * recovery the parent body replays this seed against rows a prior execution
 * already advanced, and an upsert would reset them — DO NOTHING makes the seed
 * idempotent and monotone (it can only ever add missing rows). From the first
 * seed, `queryStepsByRun` returns the run's full DAG, so consumers can render
 * honest done/total progress including not-yet-started steps.
 */
export function seedStepExecutions(pool: Querier, rows: readonly SeedStepExecutionRow[]): ResultAsync<void, DbError> {
    return tryMutation("stepExecutions.seedStepExecutions", async () => {
        if (rows.length === 0) return;
        const values: (string | number)[] = [];
        const tuples = rows.map((row) => {
            values.push(row.runId, row.stepId, row.analysisId, row.wave, row.agentId);
            const base = values.length - 5;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 'pending')`;
        });
        await pool.query({
            text: `INSERT INTO cortex_step_executions
          (run_id, step_id, analysis_id, wave, agent_id, status)
          VALUES ${tuples.join(", ")}
          ON CONFLICT (run_id, step_id) DO NOTHING`,
            values,
        });
    });
}

export type InsertStepExecutionInput = {
    runId: string;
    stepId: string;
    analysisId: string;
    wave: number;
    agentId: string;
    /** DBOS child workflow id (`"${parent}-${N}"`). Optional for legacy callers. */
    childWorkflowId?: string | null;
};

export function insertStepExecution(pool: Querier, input: InsertStepExecutionInput): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("stepExecutions.insertStepExecution", async () => {
        await pool.query({
            text: `INSERT INTO cortex_step_executions
          (run_id, step_id, analysis_id, wave, agent_id, status, started_at,
           attempts, last_error_class, finish_reason, hit_max_steps,
           child_workflow_id)
          VALUES ($1, $2, $3, $4, $5, 'running', $6, 1, NULL, NULL, 0, $7)
          ON CONFLICT (run_id, step_id) DO UPDATE SET
            wave = EXCLUDED.wave,
            agent_id = EXCLUDED.agent_id,
            status = EXCLUDED.status,
            started_at = EXCLUDED.started_at,
            completed_at = NULL,
            duration_ms = NULL,
            error = NULL,
            attempts = 1,
            last_error_class = NULL,
            finish_reason = NULL,
            hit_max_steps = 0,
            child_workflow_id = EXCLUDED.child_workflow_id`,
            values: [input.runId, input.stepId, input.analysisId, input.wave, input.agentId, now, input.childWorkflowId ?? null],
        });
    });
}

/**
 * Look up a step execution by its DBOS child workflow id. The parent
 * scheduler uses this to find the step row corresponding to a CANCELLED
 * child without holding the runId/stepId map in memory across recovery.
 */
export type UpdateStepExecutionInput = {
    /** Step status — `running` is allowed for mid-flight telemetry updates (retries). */
    status: "running" | "completed" | "failed" | "skipped" | "canceled" | "blocked";
    durationMs?: number | null;
    error?: string | null;
    /** Retry count (1-based). Writes to `attempts` column when provided. */
    attempts?: number | null;
    /** Classified error class for the previous attempt (null clears). */
    lastErrorClass?: string | null;
    /** Agent-declared blocker reason (see the harness-sandbox-agents spec); set when `status === "blocked"`. */
    blockedReason?: string | null;
    /** Agent-stream final-step finish reason ("stop", "tool-calls", ...). */
    finishReason?: string | null;
    /** True when `stepsUsed === maxSteps`. Stored as 0/1 in SQLite. */
    hitMaxSteps?: boolean | null;
};

/**
 * Update a step execution row. Columns are written conditionally so callers
 * can bump `attempts` / `lastErrorClass` on retry without clobbering timing
 * telemetry, or set `finishReason` / `hitMaxSteps` on success.
 *
 * `completed_at` is only stamped for terminal statuses (completed/failed/
 * skipped) — running updates leave it NULL for the next transition.
 */
export function updateStepExecution(pool: Querier, runId: string, stepId: string, update: UpdateStepExecutionInput): ResultAsync<void, DbError> {
    // Build the SET clause dynamically so retries can bump telemetry columns
    // without clobbering timing, and success paths can set finish_reason /
    // hit_max_steps without touching error. Placeholders are numbered
    // position-wise via the `values` array length.
    const sets: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    const push = (col: string, val: string | number | boolean | null): void => {
        values.push(val);
        sets.push(`${col} = $${values.length}`);
    };

    push("status", update.status);

    const isTerminal = update.status !== "running";
    if (isTerminal) {
        push("completed_at", new Date().toISOString());
        push("duration_ms", update.durationMs ?? null);
        push("error", update.error ?? null);
    }

    if (update.attempts != null) {
        push("attempts", update.attempts);
    }
    // Accept explicit null to clear (e.g., on success).
    if (update.lastErrorClass !== undefined) {
        push("last_error_class", update.lastErrorClass ?? null);
    }
    if (update.finishReason !== undefined) {
        push("finish_reason", update.finishReason ?? null);
    }
    if (update.hitMaxSteps !== undefined) {
        // `hit_max_steps` is INTEGER NOT NULL. node-postgres binds JS booleans as
        // PG `boolean` type and PG refuses the implicit boolean → integer cast,
        // so coerce to 0/1 at the bind site.
        push("hit_max_steps", update.hitMaxSteps === true ? 1 : 0);
    }
    if (update.blockedReason !== undefined) {
        push("blocked_reason", update.blockedReason ?? null);
    }

    values.push(runId);
    const runIdPos = values.length;
    values.push(stepId);
    const stepIdPos = values.length;

    return tryMutation("stepExecutions.updateStepExecution", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET ${sets.join(", ")}
          WHERE run_id = $${runIdPos} AND step_id = $${stepIdPos}`,
            values,
        });
    });
}

/**
 * Sweep a run's still-`pending` rows to `skipped` ("never ran, never will") at
 * finalisation, stamping `completed_at`. Only genuinely-terminal paths may call
 * this — the resumable budget-pause branch must NOT, because the resumed
 * workflow still executes those steps (see the workflow-failure-lifecycle
 * spec). `skipped`, not `canceled`: canceled means torn down mid-flight, and
 * these steps never started.
 */
export function sweepPendingStepExecutions(pool: Querier, runId: string): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("stepExecutions.sweepPendingStepExecutions", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET status = 'skipped', completed_at = $2
          WHERE run_id = $1 AND status = 'pending'`,
            values: [runId, now],
        });
    });
}

/**
 * Settle a run's still-`running` rows to `canceled` after an engine cancel.
 * A canceled child re-raises before it writes a terminal row, so this is the
 * only writer for a step that the cancel cut. `canceled`, not `skipped`: these
 * steps started. The `status = 'running'` guard keeps a terminal row that a
 * child wrote first. `started_at` and `completed_at` are ISO 8601 `TEXT`, so
 * the duration casts both; it is NULL when `started_at` is NULL.
 */
export function cancelRunningStepExecutions(pool: Querier, runId: string, reason: string): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    return tryMutation("stepExecutions.cancelRunningStepExecutions", async () => {
        await pool.query({
            text: `UPDATE cortex_step_executions
          SET status = 'canceled',
              completed_at = $2::text,
              duration_ms = (EXTRACT(EPOCH FROM ($2::text::timestamptz - started_at::timestamptz)) * 1000)::bigint,
              error = $3
          WHERE run_id = $1 AND status = 'running'`,
            values: [runId, now, reason],
        });
    });
}

export function queryStepsByRun(pool: StepRowQuerier, runId: string): ResultAsync<StepExecutionRow[], DbError> {
    return tryQuery("stepExecutions.queryStepsByRun", async () => {
        const result = await pool.query({
            text: `SELECT run_id, step_id, analysis_id, wave, agent_id,
                 status, started_at, completed_at, duration_ms, error,
                 attempts, last_error_class, finish_reason, hit_max_steps,
                 blocked_reason, child_workflow_id
          FROM cortex_step_executions
          WHERE run_id = $1
          ORDER BY wave, started_at NULLS LAST, step_id`,
            values: [runId],
        });
        return result.rows.map(mapStepExecutionRow);
    });
}

/** The step counts of one run, from {@link countStepsByRuns}. */
export type RunStepCounts = {
    runId: string;
    doneSteps: number;
    runningSteps: number;
    totalSteps: number;
};

/**
 * The step counts of each run of a list, in one statement. `totalSteps` counts each row, the `synthesis` row
 * included, and `doneSteps` counts the `completed` rows: the rule of the analysis summary reads. A step that
 * waits counts in `totalSteps` only. A run with no row has no entry, and a caller reads it as 0.
 */
export function countStepsByRuns(pool: Querier, analysisId: string, runIds: readonly string[]): ResultAsync<RunStepCounts[], DbError> {
    return tryQuery("stepExecutions.countStepsByRuns", async () => {
        if (runIds.length === 0) return [];
        const result = await pool.query<{ run_id: string; done: number; running: number; total: number }>({
            text: `SELECT run_id,
                 COUNT(*) FILTER (WHERE status = 'completed')::int AS done,
                 COUNT(*) FILTER (WHERE status = 'running')::int AS running,
                 COUNT(*)::int AS total
          FROM cortex_step_executions
          WHERE analysis_id = $1 AND run_id = ANY($2::text[])
          GROUP BY run_id`,
            values: [analysisId, [...runIds]],
        });
        return result.rows.map((r) => ({ runId: r.run_id, doneSteps: r.done, runningSteps: r.running, totalSteps: r.total }));
    });
}

function mapStepExecutionRow(row: Record<string, unknown>): StepExecutionRow {
    return StepExecutionRowSchema.parse({
        runId: row.run_id,
        stepId: row.step_id,
        analysisId: row.analysis_id,
        wave: Number(row.wave),
        agentId: row.agent_id,
        status: row.status,
        startedAt: row.started_at ?? null,
        completedAt: row.completed_at ?? null,
        // `duration_ms` is bigint, which `pg` delivers as a string; the schema wants the number.
        durationMs: row.duration_ms === undefined || row.duration_ms === null ? null : Number(row.duration_ms),
        error: row.error ?? null,
        attempts: row.attempts === undefined || row.attempts === null ? undefined : Number(row.attempts),
        lastErrorClass: row.last_error_class ?? null,
        finishReason: row.finish_reason ?? null,
        hitMaxSteps: row.hit_max_steps === 1 || row.hit_max_steps === true,
        blockedReason: row.blocked_reason ?? null,
        childWorkflowId: row.child_workflow_id ?? null,
    });
}
