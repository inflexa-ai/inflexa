/**
 * Record the key of each `update_working_memory` call that a durable step
 * applied, in the transaction of the edit. A rerun of the step after the edit,
 * before its checkpoint, then finds its key and changes nothing.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordTheAppliedMemoryEdits: Migration = {
    async up(db) {
        await sql`CREATE TABLE IF NOT EXISTS cortex_applied_memory_edits (
  call_key     TEXT PRIMARY KEY,
  analysis_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_applied_memory_edits_analysis ON cortex_applied_memory_edits (analysis_id)`.execute(db);
    },
};
