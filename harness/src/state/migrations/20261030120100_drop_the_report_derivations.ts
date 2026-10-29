/**
 * A report session derives no table, thus the session state keeps no list of derivations.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const dropTheReportDerivations: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_report_session_state DROP COLUMN IF EXISTS derivations`.execute(db);
    },
};
