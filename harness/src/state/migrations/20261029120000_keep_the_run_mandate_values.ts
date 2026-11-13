/**
 * Keeps the values of `mandate_jti` for the migration that references the run mandate. It is not an entry of its own:
 * `index.ts` runs it inside the entry `20261029120000_reference_the_run_mandate`, before the released code. That code
 * drops `mandate_jti` when any schema of the database holds `mandate_id`, and the values go with the column. This step
 * reads only the current schema. It copies the values into `mandate_id`, thus the drop of the released code removes only
 * the copy.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const keepTheRunMandateValues: Migration = {
    async up(db) {
        await sql`DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'cortex_runs' AND column_name = 'mandate_jti')
                AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'cortex_runs' AND column_name = 'mandate_id') THEN
                ALTER TABLE cortex_runs ADD COLUMN mandate_id TEXT;
                UPDATE cortex_runs SET mandate_id = mandate_jti WHERE mandate_jti IS NOT NULL;
            END IF;
        END $$`.execute(db); // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    },
};
