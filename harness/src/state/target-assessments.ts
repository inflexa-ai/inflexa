/**
 * Harness-side typed query helpers for `cortex_target_assessments`.
 *
 * Owns the helpers the DBOS workflow body and harness HTTP routes call:
 *  - `insertAssessment` accepts an optional `workflowId` and persists it on
 *    insert (defaults to the assessment id; for DBOS-shaped rows the
 *    assessmentId IS the DBOS workflowID).
 *  - `markAssessmentSuspended` flips the row to the new
 *    `suspended_insufficient_funds` status, idempotent on replay.
 *  - `markAssessmentRunning` is used by the resume entry point after
 *    `DBOS.resumeWorkflow` completes.
 *  - All row mappers surface `workflowId` alongside `workflowRunId`.
 *
 * Soft-deleted rows (`status = 'deleted'`) are never resurrected — every
 * mutating helper carries an `AND status != 'deleted'` guard, so a user
 * deleting a row mid-run causes terminal workflow writes to no-op.
 */

import { randomUUID } from "node:crypto";

import type { ResultAsync } from "neverthrow";

import {
    TargetAssessmentStatusSchema,
    TargetAssessmentErrorSchema,
    TargetAssessmentListRowSchema,
    TargetAssessmentRowSchema,
    type TargetAssessmentStatus,
    type TargetAssessmentError,
    type TargetAssessmentListRow,
    type TargetAssessmentRow,
} from "@inflexa-ai/harness/contracts/target-assessment-row.js";

import { tryQuery, tryMutation, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

export { TargetAssessmentStatusSchema, TargetAssessmentErrorSchema, TargetAssessmentListRowSchema, TargetAssessmentRowSchema };
export type { TargetAssessmentStatus, TargetAssessmentError, TargetAssessmentListRow, TargetAssessmentRow };

export interface InsertAssessmentInput {
    id?: string;
    /**
     * DBOS workflow id for the executeTargetAssessment workflow. Defaults to
     * the assessment id when omitted — the trigger route always passes the
     * id explicitly so a future split between the two ids stays trivial.
     */
    workflowId?: string;
    organizationId: string;
    targetId: string;
    targetLabel: string;
    goal?: string | null;
    billingContextId: string;
    requestedBy: string;
}

interface AssessmentRowDb {
    id: string;
    organization_id: string;
    target_id: string;
    target_label: string;
    goal: string | null;
    status: string;
    progress: string | null;
    dossier: Record<string, unknown> | string | null;
    billing_context_id: string;
    error: TargetAssessmentError | string | null;
    requested_by: string;
    workflow_run_id: string | null;
    workflow_id: string | null;
    created_at: string | Date;
    updated_at: string | Date;
    completed_at: string | Date | null;
}

function toIso(value: string | Date | null): string | null {
    if (value === null) return null;
    if (value instanceof Date) return value.toISOString();
    return value;
}

function parseJsonb<T>(raw: T | string | null): T | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }
    return raw;
}

function mapListRow(row: Omit<AssessmentRowDb, "dossier">): TargetAssessmentListRow {
    const created = toIso(row.created_at);
    const updated = toIso(row.updated_at);
    if (!created || !updated) {
        throw new Error(`cortex_target_assessments(${row.id}): missing created_at or updated_at`);
    }
    return {
        id: row.id,
        organizationId: row.organization_id,
        targetId: row.target_id,
        targetLabel: row.target_label,
        goal: row.goal,
        status: row.status as TargetAssessmentStatus,
        progress: row.progress,
        billingContextId: row.billing_context_id,
        error: parseJsonb<TargetAssessmentError>(row.error),
        requestedBy: row.requested_by,
        workflowRunId: row.workflow_run_id,
        workflowId: row.workflow_id,
        createdAt: created,
        updatedAt: updated,
        completedAt: toIso(row.completed_at),
    };
}

function mapRow(row: AssessmentRowDb): TargetAssessmentRow {
    return {
        ...mapListRow(row),
        dossier: parseJsonb<Record<string, unknown>>(row.dossier),
    };
}

const SELECT_LIST_COLUMNS = `id, organization_id, target_id, target_label, goal,
  status, progress, billing_context_id, error, requested_by,
  workflow_run_id, workflow_id, created_at, updated_at, completed_at`;
const SELECT_COLUMNS = `${SELECT_LIST_COLUMNS}, dossier`;

export function insertAssessment(pool: Querier, input: InsertAssessmentInput): ResultAsync<string, DbError> {
    const id = input.id ?? randomUUID();
    const workflowId = input.workflowId ?? id;
    return tryMutation("targetAssessments.insertAssessment", async () => {
        await pool.query({
            text: `INSERT INTO cortex_target_assessments
        (id, organization_id, target_id, target_label, goal, status,
         billing_context_id, requested_by, workflow_id)
        VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8)`,
            values: [id, input.organizationId, input.targetId, input.targetLabel, input.goal ?? null, input.billingContextId, input.requestedBy, workflowId],
        });
        return id;
    });
}

export function updateProgress(pool: Querier, id: string, progress: string, status?: TargetAssessmentStatus): ResultAsync<void, DbError> {
    return tryMutation("targetAssessments.updateProgress", async () => {
        if (status) {
            await pool.query({
                text: `UPDATE cortex_target_assessments
          SET progress = $1, status = $2, updated_at = NOW()
          WHERE id = $3 AND status != 'deleted'`,
                values: [progress, status, id],
            });
        } else {
            await pool.query({
                text: `UPDATE cortex_target_assessments
          SET progress = $1, updated_at = NOW()
          WHERE id = $2 AND status != 'deleted'`,
                values: [progress, id],
            });
        }
    });
}

export function setDossier(pool: Querier, id: string, dossier: Record<string, unknown>): ResultAsync<void, DbError> {
    return tryMutation("targetAssessments.setDossier", async () => {
        await pool.query({
            text: `UPDATE cortex_target_assessments
        SET dossier = $1::jsonb,
            status = 'completed',
            progress = 'Completed',
            error = NULL,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $2 AND status != 'deleted'`,
            values: [JSON.stringify(dossier), id],
        });
    });
}

export function markFailed(pool: Querier, id: string, error: TargetAssessmentError): ResultAsync<void, DbError> {
    return tryMutation("targetAssessments.markFailed", async () => {
        await pool.query({
            text: `UPDATE cortex_target_assessments
        SET status = 'failed',
            error = $1::jsonb,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $2 AND status != 'deleted'`,
            values: [JSON.stringify(error), id],
        });
    });
}

/**
 * Flip the row to the new `suspended_insufficient_funds` status used when
 * an LLM step self-cancels the workflow on a 402 (budget exhausted).
 * Idempotent on DBOS replay — a second call from the terminal handler on
 * the recovery path is a no-op against an already-suspended row. Soft-
 * deleted rows are NOT resurrected.
 */
export function markAssessmentSuspended(pool: Querier, id: string): ResultAsync<void, DbError> {
    return tryMutation("targetAssessments.markAssessmentSuspended", async () => {
        await pool.query({
            text: `UPDATE cortex_target_assessments
        SET status = 'suspended_insufficient_funds',
            progress = 'Suspended — insufficient funds',
            updated_at = NOW()
        WHERE id = $1 AND status != 'deleted'`,
            values: [id],
        });
    });
}

/**
 * Flip a suspended row back to `running` on `DBOS.resumeWorkflow`. Called
 * from the resume entry point AFTER the resume call returns success.
 * No-op on a soft-deleted row.
 */
export function markAssessmentRunning(pool: Querier, id: string): ResultAsync<void, DbError> {
    return tryMutation("targetAssessments.markAssessmentRunning", async () => {
        await pool.query({
            text: `UPDATE cortex_target_assessments
        SET status = 'running',
            progress = 'Resuming',
            error = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status != 'deleted'`,
            values: [id],
        });
    });
}

export function getAssessment(pool: Querier, id: string, organizationId: string): ResultAsync<TargetAssessmentRow | null, DbError> {
    // The raw read is wrapped; `mapRow`/`mapListRow` runs via `.map()` outside
    // the catch so its corrupt-row throw (missing created_at) propagates as a
    // control-flow throw rather than being captured as a `DbError`.
    return tryQuery("targetAssessments.getAssessment", async () => {
        const result = await pool.query<AssessmentRowDb>({
            text: `SELECT ${SELECT_COLUMNS}
        FROM cortex_target_assessments
        WHERE id = $1 AND organization_id = $2`,
            values: [id, organizationId],
        });
        return result.rows[0] ?? null;
    }).map((row) => (row ? mapRow(row) : null));
}

export interface ListAssessmentsOptions {
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
}

export function listAssessmentsByOrg(
    pool: Querier,
    organizationId: string,
    options: ListAssessmentsOptions = {},
): ResultAsync<TargetAssessmentListRow[], DbError> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const includeDeleted = options.includeDeleted ?? false;

    const filterDeleted = includeDeleted ? "" : `AND status != 'deleted'`;
    // `mapListRow` runs via `.map()` outside the catch so its corrupt-row throw
    // propagates as a control-flow throw, not a captured `DbError`.
    return tryQuery("targetAssessments.listAssessmentsByOrg", async () => {
        const result = await pool.query<Omit<AssessmentRowDb, "dossier">>({
            text: `SELECT ${SELECT_LIST_COLUMNS}
        FROM cortex_target_assessments
        WHERE organization_id = $1 ${filterDeleted}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
            values: [organizationId, limit, offset],
        });
        return result.rows;
    }).map((rows) => rows.map(mapListRow));
}

/**
 * Soft-delete a row. A missing/already-deleted row returns `ok(0)` — absence
 * rides the ok channel; `rowCount === 0` is not a failure.
 */
export function softDeleteAssessment(pool: Querier, id: string, organizationId: string): ResultAsync<number, DbError> {
    return tryMutation("targetAssessments.softDeleteAssessment", async () => {
        const result = await pool.query({
            text: `UPDATE cortex_target_assessments
        SET status = 'deleted', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
            values: [id, organizationId],
        });
        return result.rowCount ?? 0;
    });
}
