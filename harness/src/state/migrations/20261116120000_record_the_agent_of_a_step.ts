/**
 * Record the name of the agent of a step and the hash of its prompt. A custom agent can change between two runs, thus
 * the id alone does not say which instructions a step ran on.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordTheAgentOfAStep: Migration = {
    async up(db) {
        await sql`ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS agent_name TEXT`.execute(db);
        await sql`ALTER TABLE cortex_step_executions ADD COLUMN IF NOT EXISTS prompt_hash TEXT`.execute(db);
    },
};
