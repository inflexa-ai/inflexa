/**
 * Record the person of each work, and the usage of each step. A row that exists before this migration keeps a NULL
 * value in each new column, and no backfill runs. The two message-id tables are created empty and take no lock on
 * `messages`: an index on the display envelope would hold a lock that stops each write of `messages` for the whole
 * build. Only the backfill sets the completion time, because a replica on an earlier version can still write rows
 * with no record after this migration runs.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordThePersonOfWork: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS user_id TEXT`.execute(db);
        await sql`ALTER TABLE cortex_analysis_threads ADD COLUMN IF NOT EXISTS user_id TEXT`.execute(db);
        await sql`ALTER TABLE cortex_analysis_threads ADD COLUMN IF NOT EXISTS active_turn_user_id TEXT`.execute(db);
        await sql`ALTER TABLE cortex_analysis_state ADD COLUMN IF NOT EXISTS data_profile_user_id TEXT`.execute(db);
        await sql`ALTER TABLE cortex_paused_work ADD COLUMN IF NOT EXISTS user_id TEXT`.execute(db);
        await sql`ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS usage JSONB`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_analysis_threads_user ON cortex_analysis_threads(user_id, updated_at DESC, thread_id) WHERE deleted_at IS NULL`.execute(
            db,
        );
        await sql`CREATE TABLE IF NOT EXISTS cortex_message_ids (
            thread_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            seq BIGINT NOT NULL,
            PRIMARY KEY (thread_id, message_id)
        )`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_message_ids_seq ON cortex_message_ids (thread_id, seq)`.execute(db);
        await sql`CREATE TABLE IF NOT EXISTS cortex_message_id_backfill (
            id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
            after_thread_id TEXT,
            after_seq BIGINT,
            completed_at TIMESTAMPTZ
        )`.execute(db);
        await sql`INSERT INTO cortex_message_id_backfill (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`.execute(db);
    },
};
