/**
 * Narrow the one-active-run index to the `running` status. A run that a host
 * suspended is terminal, thus it no longer blocks a new run of its plan. A drop
 * and a new index replace the index, because Postgres cannot change the
 * predicate of an index.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const narrowTheActiveRunIndex: Migration = {
    async up(db) {
        await sql`DROP INDEX IF EXISTS idx_cortex_runs_active_plan`.execute(db);
        await sql`CREATE UNIQUE INDEX idx_cortex_runs_active_plan ON cortex_runs(analysis_id, plan_id) WHERE status = 'running'`.execute(db);
    },
};
