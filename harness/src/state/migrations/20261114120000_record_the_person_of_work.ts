/**
 * Record the person of each work, and the usage of each step. A row that exists before this migration keeps a NULL
 * value in each new column, and no backfill runs. The GIN index on the message ids of the display envelope finds the
 * rows that hold one message.
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
        await sql`CREATE INDEX IF NOT EXISTS idx_messages_display_message_ids ON messages USING GIN ((display_envelope -> 'messages') jsonb_path_ops)`.execute(
            db,
        );
    },
};
