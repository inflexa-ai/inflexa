/**
 * Record whether a person set the title of a thread, thus an automatic title
 * never replaces a name that a person chose.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const threadTitleSetByUser: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_analysis_threads ADD COLUMN IF NOT EXISTS title_set_by_user BOOLEAN NOT NULL DEFAULT false`.execute(db);
    },
};
