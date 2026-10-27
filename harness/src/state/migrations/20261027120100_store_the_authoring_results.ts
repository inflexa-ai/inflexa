/**
 * Store the result of each authoring call that a durable step landed, keyed by
 * the report thread and the step. The result lands in the transaction of the
 * document. A rerun of the step after the landing, before its checkpoint, then
 * gives the stored result and does not apply the operation a second time.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const storeTheAuthoringResults: Migration = {
    async up(db) {
        await sql`CREATE TABLE IF NOT EXISTS cortex_authoring_results (
  thread_id    TEXT NOT NULL,
  call_key     TEXT NOT NULL,
  analysis_id  TEXT NOT NULL,
  result       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, call_key)
)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_authoring_results_analysis ON cortex_authoring_results (analysis_id)`.execute(db);
    },
};
