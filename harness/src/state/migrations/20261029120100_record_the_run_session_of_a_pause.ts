/**
 * A pause row of a run or a profile keeps the run session of its workflow. A
 * resume renews the run credential from it before the work goes on, and a
 * turn, whose credential comes with the person, keeps none.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordTheRunSessionOfAPause: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_paused_work ADD COLUMN IF NOT EXISTS run_session JSONB`.execute(db);
    },
};
