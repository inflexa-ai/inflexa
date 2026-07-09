import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../auth/local-run-authorizer.js";
import { loadDataProfileStatus } from "../state/data-profile.js";
import { triggerDataProfile, type DataProfileTriggerDeps } from "./data-profile.js";

/**
 * Seed a `cortex_analysis_state` row at the given `data_profile_status`. Mirrors
 * the helper in `state/data-profile.test.ts`: it leaves `seed_input_file_ids`
 * NULL, which is exactly the unseeded state the trigger's seed-first guard
 * refuses.
 */
async function seedAnalysis(pool: Pool, analysisId: string, dpStatus = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3, $4)`,
        values: [analysisId, dpStatus, now, now],
    });
}

/** Read `data_profile_status` straight off the row, bypassing the NULL-collapse
 * in `loadDataProfileStatus`. */
async function rawStatus(pool: Pool, analysisId: string): Promise<string | null> {
    const res = await pool.query<{ data_profile_status: string | null }>({
        text: "SELECT data_profile_status FROM cortex_analysis_state WHERE analysis_id = $1",
        values: [analysisId],
    });
    return res.rows[0]?.data_profile_status ?? null;
}

describe("triggerDataProfile seed-first guard", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_trigger_guard");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("refuses an unseeded row and leaves it unclaimed", async () => {
        // `seedAnalysis` leaves `seed_input_file_ids` NULL — the unseeded ledger
        // the guard exists to refuse.
        await seedAnalysis(pool, "a-noseed", "pending");

        // The workflow is a tripwire: the guard must return BEFORE the claim
        // ladder, so this must never run. If the guard regressed and let the
        // unseeded row through, `tryStartDataProfile` would claim it and the
        // fire-and-forget dispatch would reach here — surfacing the regression as
        // a thrown failure rather than a silent pass.
        const deps: DataProfileTriggerDeps = {
            pool,
            runAuthorizer: createLocalRunAuthorizer(),
            workflow: () => {
                throw new Error("workflow must not be launched for an unseeded trigger");
            },
        };

        const result = await triggerDataProfile(deps, {
            auth: makeLocalAuth(),
            analysisId: "a-noseed",
            stagedInputs: [],
        });

        expect(result).toBe("failed");

        // State, not interactions: the guard returned before the CAS, so the row
        // is untouched at 'pending' — never claimed to 'running'.
        expect(await rawStatus(pool, "a-noseed")).toBe("pending");
        const status = (await loadDataProfileStatus(pool, "a-noseed"))._unsafeUnwrap();
        expect(status?.status).toBe("pending");
    });

    it("passes a seeded row through to a claimed start", async () => {
        await seedAnalysis(pool, "a-seeded", "pending");
        // Seed the input set the guard reads. The guard checks the DB column, not
        // `params.stagedInputs`, so a non-empty `seed_input_file_ids` is what lets
        // the row through — mirrors the raw UPDATE the clearDataProfile test uses.
        await pool.query({
            text: `UPDATE cortex_analysis_state SET seed_input_file_ids = $1::jsonb WHERE analysis_id = $2`,
            values: [JSON.stringify(["file-aaa", "file-bbb"]), "a-seeded"],
        });

        // The trigger fires the workflow dispatch fire-and-forget through
        // `DBOS.startWorkflow`; with no DBOS engine that dispatch rejects and the
        // trigger's compensation would flip the freshly-claimed 'running' row back
        // to 'failed'. Parking `authorize` (the first await on that fire-and-forget
        // path) holds the dispatch open so the compensation can never race our read
        // of the committed CAS result. The guard and the `tryStartDataProfile` CAS
        // both run to completion upstream of this await — only the downstream
        // dispatch is held.
        const deps: DataProfileTriggerDeps = {
            pool,
            runAuthorizer: {
                authorize: () => new Promise(() => {}),
                async revoke() {},
            },
            workflow: async () => {},
        };

        const result = await triggerDataProfile(deps, {
            auth: makeLocalAuth(),
            analysisId: "a-seeded",
            stagedInputs: [],
        });

        expect(result).toBe("started");

        // State, not interactions: the guard let the seeded row through and the
        // CAS claimed it to 'running'.
        expect(await rawStatus(pool, "a-seeded")).toBe("running");
        const status = (await loadDataProfileStatus(pool, "a-seeded"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });
});
