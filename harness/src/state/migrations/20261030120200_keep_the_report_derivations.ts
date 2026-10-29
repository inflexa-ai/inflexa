/**
 * A report session derives a table in a script, thus the session state keeps its list of derivations again. A
 * database that ran the drop gets the column back with no rows in it. Each other database keeps its column.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const keepTheReportDerivations: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_report_session_state ADD COLUMN IF NOT EXISTS derivations JSONB`.execute(db);
    },
};
