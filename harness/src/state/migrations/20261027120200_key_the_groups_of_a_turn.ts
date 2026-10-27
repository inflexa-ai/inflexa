/**
 * Key each group of a chat turn on its first row. A turn workflow writes each
 * round in a step, and a step that runs again after its commit finds the key
 * and stores nothing, thus no row of a turn lands two times.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const keyTheGroupsOfATurn: Migration = {
    async up(db) {
        await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS round_key TEXT`.execute(db);
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_round_key ON messages(thread_id, round_key) WHERE round_key IS NOT NULL`.execute(db);
    },
};
