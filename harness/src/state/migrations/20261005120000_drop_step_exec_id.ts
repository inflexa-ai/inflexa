/**
 * Drop the in-flight exec id of a step row. The exec id is the function id of
 * its DBOS step, thus nothing outside the step reads it.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const dropStepExecId: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS exec_id`.execute(db);
    },
};
