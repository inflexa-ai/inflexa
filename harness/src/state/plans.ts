/**
 * `cortex_plans` operations — plan insert (minted id), upsert (caller id),
 * and analysis-scoped lookup.
 */

import { randomUUID } from "node:crypto";

import { PLAN_ID_RE } from "../contracts/schemas/chat-parts.js";

import type { ResultAsync } from "neverthrow";
import type { QueryConfig } from "pg";
import { z } from "zod";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

/**
 * What the plan reads of the pool: one row-reading query over concrete rows.
 * A real `Pool` and a `Querier`-typed caller satisfy it; a computed test fake
 * satisfies it directly, where the row-generic `Querier` refuses it.
 */
export type PlanRowQuerier = {
    query(queryTextOrConfig: string | QueryConfig, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * `cortex_plans.plan_id` shape contract — `pln-` followed by 8 lowercase hex
 * chars. The chat trigger (`tools/execute-analysis.ts`) enforces the same regex on
 * its tool input; `upsertPlan` re-asserts it because it accepts a caller-derived
 * id rather than minting one. The shape itself is the `PLAN_ID_RE` home in
 * `contracts/schemas/chat-parts.ts`.
 */

export type InsertPlanInput = {
    analysisId: string;
    plan: unknown;
    parentPlanId?: string | null;
};

/**
 * Enforce tenant scope for a `parentPlanId`: the parent row must exist AND belong
 * to `analysisId`. Shared by {@link insertPlan} and {@link upsertPlan} — the
 * `cortex_plans` FK enforces existence only, not tenant scope, so without this a
 * plan could be parented under another analysis's plan.
 *
 * Both violations (parent missing / parent in another analysis) are control-flow
 * throws, NOT `DbError`: they short-circuit before the child INSERT, so the throw
 * surfaces verbatim above the Result boundary rather than riding the err channel
 * as a query failure. `label` scopes the driver-call telemetry to the caller.
 */
function checkParentScope(pool: Querier, parentPlanId: string, analysisId: string, label: string): ResultAsync<void, DbError> {
    return tryQuery(label, () =>
        pool.query<{ analysis_id: string }>({
            text: "SELECT analysis_id FROM cortex_plans WHERE plan_id = $1",
            values: [parentPlanId],
        }),
    ).map((parent) => {
        if ((parent.rowCount ?? 0) === 0) {
            throw new Error(`parent plan ${parentPlanId} not found`);
        }
        if (parent.rows[0]?.analysis_id !== analysisId) {
            throw new Error(`parent plan ${parentPlanId} belongs to a different analysis`);
        }
    });
}

/**
 * Insert a plan and return the generated planId.
 * Validates that parentPlanId (if set) belongs to the same analysis —
 * the FK alone only enforces existence, not tenant scope.
 *
 * The tenant-scope checks (parent missing / parent belongs to another
 * analysis) are control-flow throws, NOT `DbError`: they short-circuit the
 * chain by throwing before any driver call, so `tryQuery` never captures them
 * as a query failure and they surface verbatim to the caller.
 */
export function insertPlan(pool: Querier, input: InsertPlanInput): ResultAsync<string, DbError> {
    const insert = (): ResultAsync<string, DbError> => {
        const planId = `pln-${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        return tryMutation("plans.insertPlan", async () => {
            await pool.query({
                text: `INSERT INTO cortex_plans
              (plan_id, analysis_id, plan, parent_plan_id, created_at)
              VALUES ($1, $2, $3, $4, $5)`,
                values: [planId, input.analysisId, JSON.stringify(input.plan), input.parentPlanId ?? null, now],
            });
            return planId;
        });
    };

    if (!input.parentPlanId) return insert();
    return checkParentScope(pool, input.parentPlanId, input.analysisId, "plans.insertPlan.parentScope").andThen(insert);
}

export type UpsertPlanInput = {
    /** Caller-derived id — must match the `pln-<8hex>` contract. */
    planId: string;
    analysisId: string;
    plan: unknown;
    parentPlanId?: string | null;
};

/**
 * Insert a plan under a caller-supplied id, or no-op if that id already exists
 * (`ON CONFLICT (plan_id) DO NOTHING`). Unlike {@link insertPlan}, the id is
 * given by the caller — used when the id is derived deterministically (e.g. a
 * content hash) so that re-running the same plan is idempotent rather than
 * minting a fresh row every time.
 *
 * Re-upserting an existing planId is a success no-op: exactly one row survives.
 * The same parent-scope check as `insertPlan` applies (parent must belong to
 * the same analysis) and is a control-flow throw, not a `DbError`.
 *
 * An id off the `pln-<8hex>` shape is a caller/contract error, not a storage
 * failure: it throws synchronously before any driver call, surfacing verbatim
 * above the Result boundary rather than riding the err channel as a `DbError`
 * (mirroring the parent-scope violations, which throw before the INSERT).
 */
export function upsertPlan(pool: Querier, input: UpsertPlanInput): ResultAsync<void, DbError> {
    if (!PLAN_ID_RE.test(input.planId)) {
        throw new Error(`upsertPlan: invalid plan id "${input.planId}" — expected the pln-<8hex> shape`);
    }

    const upsert = (): ResultAsync<void, DbError> => {
        const now = new Date().toISOString();
        return tryMutation("plans.upsertPlan", async () => {
            await pool.query({
                text: `INSERT INTO cortex_plans
              (plan_id, analysis_id, plan, parent_plan_id, created_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (plan_id) DO NOTHING`,
                values: [input.planId, input.analysisId, JSON.stringify(input.plan), input.parentPlanId ?? null, now],
            });
        });
    };

    if (!input.parentPlanId) return upsert();
    return checkParentScope(pool, input.parentPlanId, input.analysisId, "plans.upsertPlan.parentScope").andThen(upsert);
}

/**
 * Analysis-scoped plan lookup. Returns `ok(null)` for unknown planIds OR
 * for planIds that belong to a different analysis — indistinguishable
 * to the caller, which is the multi-tenancy invariant. Absence is NOT an
 * error.
 */
export function loadPlan(pool: Querier, planId: string, opts: { analysisId: string }): ResultAsync<unknown, DbError> {
    return tryQuery("plans.loadPlan", async () => {
        const result = await pool.query<{ plan: unknown }>({
            text: `SELECT plan FROM cortex_plans
             WHERE plan_id = $1 AND analysis_id = $2`,
            values: [planId, opts.analysisId],
        });
        return result.rows[0]?.plan ?? null;
    });
}

/** A stored plan with its lineage, as {@link loadPlanRecord} reads it. */
export type PlanRecord = {
    planId: string;
    /** The stored document, as the store holds it. A reader parses it. */
    plan: unknown;
    parentPlanId: string | null;
    /** The newest plan of the same analysis that names this plan as its parent. */
    supersededBy: string | null;
    createdAt: string;
};

/** The `cortex_plans` row of {@link loadPlanRecord}, as the SELECT returns it. */
const PlanRecordRowSchema = z.object({
    plan: z.json(),
    parent_plan_id: z.string().nullable(),
    created_at: z.string(),
    superseded_by: z.string().nullable(),
});

/**
 * Analysis-scoped read of one plan with its parent and the newest plan that
 * replaced it, in one statement. Returns `ok(null)` for an unknown planId OR a
 * planId of a different analysis, as {@link loadPlan} does.
 *
 * `created_at` is ISO 8601 text, thus the text order is the time order; the plan
 * id breaks a tie so that the answer is stable.
 */
export function loadPlanRecord(pool: PlanRowQuerier, planId: string, opts: { analysisId: string }): ResultAsync<PlanRecord | null, DbError> {
    return tryQuery("plans.loadPlanRecord", async () => {
        const result = await pool.query({
            text: `SELECT p.plan, p.parent_plan_id, p.created_at,
                     (SELECT c.plan_id FROM cortex_plans c
                       WHERE c.parent_plan_id = p.plan_id AND c.analysis_id = p.analysis_id
                       ORDER BY c.created_at DESC, c.plan_id DESC LIMIT 1) AS superseded_by
                FROM cortex_plans p
               WHERE p.plan_id = $1 AND p.analysis_id = $2`,
            values: [planId, opts.analysisId],
        });
        const raw = result.rows[0];
        if (!raw) return null;
        const row = PlanRecordRowSchema.parse(raw);
        return { planId, plan: row.plan, parentPlanId: row.parent_plan_id, supersededBy: row.superseded_by, createdAt: row.created_at };
    });
}
