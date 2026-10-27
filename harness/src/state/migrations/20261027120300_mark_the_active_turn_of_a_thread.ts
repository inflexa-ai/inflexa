/**
 * Mark the turn that runs on a thread. The open of a turn claims the thread,
 * and the end of the turn releases it, thus a second turn on the same thread
 * is refused before it writes a row.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const markTheActiveTurnOfAThread: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_analysis_threads ADD COLUMN IF NOT EXISTS active_turn_id TEXT`.execute(db);
    },
};
