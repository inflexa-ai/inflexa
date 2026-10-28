/**
 * The run ledger keeps a reference to the run credential, not a token: the id
 * of the mandate, which a realization resolves to a short-lived credential.
 * The reference has no expiry, because the run does not depend on a clock.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const referenceTheRunMandate: Migration = {
    async up(db) {
        // The baseline adds `mandate_jti` again on a database that ran it before, thus the column can stand beside
        // `mandate_id`. Then it holds no value that `mandate_id` does not.
        await sql`DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cortex_runs' AND column_name = 'mandate_jti') THEN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cortex_runs' AND column_name = 'mandate_id') THEN
                    ALTER TABLE cortex_runs DROP COLUMN mandate_jti;
                ELSE
                    ALTER TABLE cortex_runs RENAME COLUMN mandate_jti TO mandate_id;
                END IF;
            END IF;
        END $$`.execute(db); // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
        await sql`ALTER TABLE cortex_runs DROP COLUMN IF EXISTS mandate_expires_at`.execute(db); // oss-core-managed-ok: run-mandate ledger
    },
};
