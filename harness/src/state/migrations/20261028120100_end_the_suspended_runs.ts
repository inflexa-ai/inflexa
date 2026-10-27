/**
 * End the rows of the suspended state. A suspended run ended `CANCELLED` in the
 * engine, and no code can resume it, thus its row reads as `failed` with its
 * reason. An analysis has no suspended state any more, because paused work
 * records itself in `cortex_paused_work`.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const endTheSuspendedRuns: Migration = {
    async up(db) {
        await sql`UPDATE cortex_runs SET status = 'failed' WHERE status = 'suspended_insufficient_funds'`.execute(db);
        await sql`UPDATE cortex_analysis_state SET status = 'active' WHERE status = 'suspended_insufficient_funds'`.execute(db);
    },
};
