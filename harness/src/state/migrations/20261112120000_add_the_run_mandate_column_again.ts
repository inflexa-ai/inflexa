/**
 * The migration that references the run mandate probed the catalog of each schema, not only the current one. A
 * database where a different schema held `mandate_id` made it drop `mandate_jti` and add nothing. A schema that ran
 * it that way gets the column back with no values in it. Each other schema keeps its column.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const addTheRunMandateColumnAgain: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_runs ADD COLUMN IF NOT EXISTS mandate_id TEXT`.execute(db); // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    },
};
