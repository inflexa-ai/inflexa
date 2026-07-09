import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../auth/local-run-authorizer.js";
import { loadDataProfileStatus } from "../state/data-profile.js";
import { triggerDataProfile, type DataProfileTriggerDeps } from "./data-profile.js";

/**
 * Seed a `cortex_analysis_state` row at the given `data_profile_status` (pass `null`
 * for the cleared/never-profiled state). Mirrors the helper in
 * `state/data-profile.test.ts`: it leaves `seed_input_file_ids` NULL, which is
 * exactly the unseeded state both the trigger's guard and the claim CAS refuse.
 */
async function seedAnalysis(pool: Pool, analysisId: string, dpStatus: string | null = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3, $4)`,
        values: [analysisId, dpStatus, now, now],
    });
}

/** Write `seed_input_file_ids` directly — the column the guard and the CAS both read. */
async function setSeed(pool: Pool, analysisId: string, seed: string[] | null): Promise<void> {
    await pool.query({
        text: `UPDATE cortex_analysis_state SET seed_input_file_ids = $1::jsonb WHERE analysis_id = $2`,
        values: [seed === null ? null : JSON.stringify(seed), analysisId],
    });
}

/**
 * Deps whose `authorize` never settles. The trigger dispatches the workflow
 * fire-and-forget through `DBOS.startWorkflow`; with no DBOS engine that dispatch
 * rejects and the trigger's compensation flips the freshly-claimed `running` row back
 * to `failed`. Parking `authorize` — the first await on the fire-and-forget path —
 * holds the dispatch open so compensation can never race our read of the committed CAS
 * result. The guard and the claim both run to completion upstream of that await.
 */
function parkedDispatchDeps(pool: Pool): DataProfileTriggerDeps {
    return {
        pool,
        runAuthorizer: {
            authorize: () => new Promise(() => {}),
            async revoke() {},
        },
        workflow: async () => {},
    };
}

/**
 * Deps whose workflow throws on entry. A tripwire: every refusal below must return
 * BEFORE any claim, so a regression that lets an unseeded row through surfaces as a
 * thrown failure rather than a silent pass.
 */
function tripwireDeps(pool: Pool): DataProfileTriggerDeps {
    return {
        pool,
        runAuthorizer: createLocalRunAuthorizer(),
        workflow: () => {
            throw new Error("workflow must not be launched for an unseeded trigger");
        },
    };
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

    it("refuses a NULL-seed row and leaves it unclaimed", async () => {
        // `seedAnalysis` leaves `seed_input_file_ids` NULL — the unseeded ledger.
        await seedAnalysis(pool, "a-noseed", "pending");

        const result = await triggerDataProfile(tripwireDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-noseed",
            stagedInputs: [],
        });

        expect(result).toBe("failed");

        // State, not interactions: the row is untouched at 'pending' — never claimed.
        expect(await rawStatus(pool, "a-noseed")).toBe("pending");
        const status = (await loadDataProfileStatus(pool, "a-noseed"))._unsafeUnwrap();
        expect(status?.status).toBe("pending");
    });

    it("refuses an empty-seed row — `[]` names zero files, and is not a seed", async () => {
        // `upsertAnalysis` writes NULL to mean "leave the stored seed alone", so `[]`
        // reaches the ledger as a real value. It must be refused exactly like NULL.
        await seedAnalysis(pool, "a-emptyseed", "pending");
        await setSeed(pool, "a-emptyseed", []);

        const result = await triggerDataProfile(tripwireDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-emptyseed",
            stagedInputs: [],
        });

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-emptyseed")).toBe("pending");
    });

    it("claims a NULL-status seeded row — the cleared-then-reseeded state", async () => {
        // THE production lifecycle this guard was written for, and the one the claim's
        // `data_profile_status IS NULL` clause exists to serve: `clearDataProfile` nulls
        // status AND seed; a later seed upsert repopulates the seed via COALESCE without
        // ever rewriting status. Seeding 'pending' here instead would let the CAS's
        // pre-existing `= 'pending'` branch win, and the NULL clause would go untested.
        await seedAnalysis(pool, "a-cleared", null);
        await setSeed(pool, "a-cleared", ["file-aaa", "file-bbb"]);

        const result = await triggerDataProfile(parkedDispatchDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-cleared",
            stagedInputs: [],
        });

        expect(result).toBe("started");
        expect(await rawStatus(pool, "a-cleared")).toBe("running");
    });

    it("claims a pending seeded row", async () => {
        await seedAnalysis(pool, "a-seeded", "pending");
        await setSeed(pool, "a-seeded", ["file-aaa", "file-bbb"]);

        const result = await triggerDataProfile(parkedDispatchDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-seeded",
            stagedInputs: [],
        });

        expect(result).toBe("started");
        expect(await rawStatus(pool, "a-seeded")).toBe("running");
        const status = (await loadDataProfileStatus(pool, "a-seeded"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });

    it("re-claims a completed seeded row as a restart", async () => {
        await seedAnalysis(pool, "a-completed", "completed");
        await setSeed(pool, "a-completed", ["file-aaa"]);

        const result = await triggerDataProfile(parkedDispatchDeps(pool), {
            auth: makeLocalAuth(),
            analysisId: "a-completed",
            stagedInputs: [],
        });

        expect(result).toBe("restarted");
        expect(await rawStatus(pool, "a-completed")).toBe("running");
    });

    it("a seed wiped after the guard's read cannot produce a seedless running row", async () => {
        // The TOCTOU the CAS conjunct closes. The guard's pre-read is advisory: here it
        // observes a seed that a concurrent `clearDataProfile` then wipes. The claim must
        // still refuse, because a `running` row that names no input set is the state the
        // whole invariant exists to forbid.
        await seedAnalysis(pool, "a-raced", null);
        await setSeed(pool, "a-raced", ["file-aaa"]);

        const raced: DataProfileTriggerDeps = {
            ...tripwireDeps(pool),
            pool: {
                ...pool,
                // Wipe the seed the instant the guard finishes reading it, before the CAS runs.
                query: async (...args: Parameters<Pool["query"]>) => {
                    const res = await pool.query(...args);
                    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
                    if (text.includes("SELECT seed_input_file_ids")) await setSeed(pool, "a-raced", null);
                    return res;
                },
                // The spread above loses `Pool`'s prototype methods; only `query` is exercised
                // by `triggerDataProfile`, and it is replaced. The cast asserts exactly that.
            } as unknown as Pool,
        };

        const result = await triggerDataProfile(raced, {
            auth: makeLocalAuth(),
            analysisId: "a-raced",
            stagedInputs: [],
        });

        expect(result).toBe("failed");
        expect(await rawStatus(pool, "a-raced")).toBeNull();
    });
});
