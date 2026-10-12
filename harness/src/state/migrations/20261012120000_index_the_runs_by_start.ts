/**
 * Index the runs of an analysis by their start time, thus the read of the
 * newest run of each analysis of a list reads one index entry for each
 * analysis, and its cost does not grow with the run history. The index on
 * `analysis_id` alone stays: a drop is a separate decision.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const indexTheRunsByStart: Migration = {
    async up(db) {
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_runs_analysis_started ON cortex_runs(analysis_id, started_at DESC, run_id DESC)`.execute(db);
    },
};
