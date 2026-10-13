/**
 * Index the runs by their completion time and the live threads by their update
 * time, thus the reads over each analysis walk an index and do not sort the
 * whole history. The thread index is partial on the live rows, the predicate of
 * the read.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const indexTheEndedRunsAndTheRecentThreads: Migration = {
    async up(db) {
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_runs_completed ON cortex_runs(completed_at DESC, run_id DESC)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_analysis_threads_recent ON cortex_analysis_threads(updated_at DESC, thread_id) WHERE deleted_at IS NULL`.execute(
            db,
        );
    },
};
