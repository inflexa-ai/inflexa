/**
 * Index the plans by their parent, thus the read of the plan that replaced a
 * plan, and the key check when a plan row goes away, read one index entry.
 * Index the runs by their plan, thus the read of the run ids of a plan reads
 * only the runs of that plan.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const indexThePlansByParentAndTheRunsByPlan: Migration = {
    async up(db) {
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_plans_parent ON cortex_plans(parent_plan_id)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_runs_plan ON cortex_runs(analysis_id, plan_id, started_at DESC, run_id DESC)`.execute(db);
    },
};
