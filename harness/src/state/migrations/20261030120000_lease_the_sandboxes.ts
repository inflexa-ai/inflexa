/**
 * Record each sandbox lease. A row is one generation of a lease and its lease
 * workflow: the request, the grant, the current machine, and the release. The
 * lease table replaces the sandbox handle on the step rows.
 */

import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const leaseTheSandboxes: Migration = {
    async up(db) {
        await sql`CREATE TABLE IF NOT EXISTS cortex_sandbox_leases (
            lease_workflow_id TEXT PRIMARY KEY,
            lease_key TEXT NOT NULL,
            generation INTEGER NOT NULL,
            analysis_id TEXT NOT NULL,
            owner_workflow_id TEXT NOT NULL,
            work_kind TEXT NOT NULL,
            work_id TEXT NOT NULL,
            requested JSONB NOT NULL,
            granted JSONB,
            state TEXT NOT NULL,
            release_reason TEXT,
            machine JSONB,
            machine_generation INTEGER NOT NULL DEFAULT 0,
            exec_salt TEXT NOT NULL DEFAULT gen_random_uuid()::text,
            requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            granted_at TIMESTAMPTZ,
            last_used_at TIMESTAMPTZ,
            released_at TIMESTAMPTZ
        )`.execute(db);
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_cortex_sandbox_leases_active_key ON cortex_sandbox_leases(lease_key) WHERE state <> 'released'`.execute(
            db,
        );
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_sandbox_leases_waiting ON cortex_sandbox_leases(requested_at) WHERE state = 'requested'`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_cortex_sandbox_leases_analysis ON cortex_sandbox_leases(analysis_id)`.execute(db);
        await sql`ALTER TABLE cortex_step_executions DROP COLUMN IF EXISTS sandbox_ref`.execute(db);
    },
};
