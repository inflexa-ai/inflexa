/**
 * Record each workflow that waits in a pause. The row is the state that a host
 * reads when it lists the paused work of an analysis, for example after a
 * restart, and it names the topic that the resume sends to.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const recordThePausedWork: Migration = {
    async up(db) {
        await sql`CREATE TABLE IF NOT EXISTS cortex_paused_work (
            workflow_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL,
            work_kind TEXT NOT NULL,
            analysis_id TEXT NOT NULL,
            thread_id TEXT,
            state TEXT NOT NULL,
            cause JSONB NOT NULL,
            attempt INTEGER NOT NULL,
            retry_at TIMESTAMPTZ,
            topic TEXT NOT NULL,
            paused_at TIMESTAMPTZ NOT NULL
        )`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_paused_work_analysis ON cortex_paused_work(analysis_id)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_paused_work_work ON cortex_paused_work(work_id)`.execute(db);
    },
};
