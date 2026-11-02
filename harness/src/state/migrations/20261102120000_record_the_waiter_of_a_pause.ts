/**
 * A pause row names what waits. A row that a wait wrote before this column keeps a NULL waiter, which reads as no
 * waiter, and the migration deletes no row.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordTheWaiterOfAPause: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_paused_work ADD COLUMN IF NOT EXISTS waiter JSONB`.execute(db);
    },
};
