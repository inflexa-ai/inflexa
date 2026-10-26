/**
 * Record the intent of each `edit_file` call inside a durable step, keyed by
 * the step. A rerun of the step after the write, before its checkpoint, then
 * gives back the result of the edit and does not apply it a second time.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const addTheEditIntents: Migration = {
    async up(db) {
        await sql`CREATE TABLE IF NOT EXISTS cortex_edit_intents (
  step_key     TEXT PRIMARY KEY,
  analysis_id  TEXT NOT NULL,
  path         TEXT NOT NULL,
  hash_before  TEXT NOT NULL,
  hash_after   TEXT NOT NULL,
  result       JSONB NOT NULL,
  call_record  JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_edit_intents_analysis ON cortex_edit_intents (analysis_id)`.execute(db);
    },
};
