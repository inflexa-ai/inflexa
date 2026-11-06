/**
 * Record the model of a thread. A thread with no model runs on the model of the host, and a fallback pins the
 * thread to the model that answered a declined request.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const pinTheModelOfAThread: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_analysis_threads ADD COLUMN IF NOT EXISTS model TEXT`.execute(db);
    },
};
