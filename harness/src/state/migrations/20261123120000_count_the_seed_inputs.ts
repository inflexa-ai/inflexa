/**
 * Keep the count of the seeded input set, not one id for each file. A seed of a large input set grew the
 * row with its file count, and a claim into `running` reads only whether the set is empty. The copy
 * keeps the count of each row that names files, thus a seeded row stays claimable.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const countTheSeedInputs: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_analysis_state ADD COLUMN IF NOT EXISTS seed_input_count INTEGER`.execute(db);
        await sql`UPDATE cortex_analysis_state SET seed_input_count = jsonb_array_length(seed_input_file_ids)
            WHERE jsonb_typeof(seed_input_file_ids) = 'array'`.execute(db);
        await sql`ALTER TABLE cortex_analysis_state DROP COLUMN IF EXISTS seed_input_file_ids`.execute(db);
    },
};
