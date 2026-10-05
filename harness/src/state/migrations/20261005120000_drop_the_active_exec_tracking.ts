/**
 * Drop the in-flight exec id of a step row, and the partial index of the rows
 * that hold a sandbox. The exec id is the function id of its DBOS step, thus
 * nothing outside the step reads it, and no query reads the rows by status.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const dropActiveExecTracking: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS exec_id`.execute(db);
        await sql`DROP INDEX IF EXISTS idx_cortex_step_exec_active_sandbox`.execute(db);
    },
};
