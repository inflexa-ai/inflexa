/**
 * Record the workflow that waits for each ask, the reach of the grant that an `always` answer records, and the grants
 * of a user that apply in each analysis. A row with no workflow resolves to the active turn of its thread at the
 * answer (`selectAskWorkflow`).
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordTheWaiterAndTheUserGrants: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_asks ADD COLUMN IF NOT EXISTS workflow_id TEXT`.execute(db);
        await sql`ALTER TABLE cortex_asks ADD COLUMN IF NOT EXISTS grant_scope TEXT`.execute(db);
        await sql`CREATE TABLE IF NOT EXISTS cortex_user_grants (
            user_id TEXT NOT NULL,
            grant_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, grant_key)
        )`.execute(db);
    },
};
