/**
 * Record the template that rendered an artifact. The row of a script that `run_template` wrote holds the template,
 * its version, its method, and the release, thus the methods of a step and the report name the template of a result.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordTheTemplateOfAnArtifact: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_artifacts ADD COLUMN IF NOT EXISTS template JSONB`.execute(db);
    },
};
