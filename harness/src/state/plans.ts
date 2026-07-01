/**
 * `cortex_plans` operations — plan insert + analysis-scoped lookup.
 */

import { randomUUID } from "node:crypto";

import type { ResultAsync } from "neverthrow";

import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Querier } from "./db.js";

export interface InsertPlanInput {
    analysisId: string;
    plan: unknown;
    parentPlanId?: string | null;
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

    const parentPlanId = input.parentPlanId;
    return tryQuery("plans.insertPlan.parentScope", () =>
        pool.query<{ analysis_id: string }>({
            text: "SELECT analysis_id FROM cortex_plans WHERE plan_id = $1",
            values: [parentPlanId],
        }),
    ).andThen((parent) => {
        if ((parent.rowCount ?? 0) === 0) {
            throw new Error(`parent plan ${parentPlanId} not found`);
        }
        if (parent.rows[0].analysis_id !== input.analysisId) {
            throw new Error(`parent plan ${parentPlanId} belongs to a different analysis`);
        }
        return insert();
    });
}

/**
 * Analysis-scoped plan lookup. Returns `ok(null)` for unknown planIds OR
 * for planIds that belong to a different analysis — indistinguishable
 * to the caller, which is the multi-tenancy invariant. Absence is NOT an
 * error.
 */
export function loadPlan(pool: Querier, planId: string, opts: { analysisId: string }): ResultAsync<unknown | null, DbError> {
    return tryQuery("plans.loadPlan", async () => {
        const result = await pool.query<{ plan: unknown }>({
            text: `SELECT plan FROM cortex_plans
             WHERE plan_id = $1 AND analysis_id = $2`,
            values: [planId, opts.analysisId],
        });
        return result.rows[0]?.plan ?? null;
    });
}
