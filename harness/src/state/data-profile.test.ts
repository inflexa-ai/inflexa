import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import {
    clearDataProfile,
    completeDataProfile,
    failDataProfile,
    loadDataProfileStatus,
    tryRerunDataProfile,
    tryRetryDataProfile,
    tryStartDataProfile,
    expireStaleDataProfile,
} from "./data-profile.js";

/**
 * Insert an analysis-state row. `seed` defaults to a non-empty set because every claim
 * into `running` requires one — a status-transition test that left it NULL would be
 * asserting the seed conjunct, not the transition it names. Pass `null` or `[]`
 * explicitly to exercise the unseeded refusals.
 */
async function seedAnalysis(pool: Pool, analysisId: string, dpStatus: string | null = "pending", seed: string[] | null = ["file-seed"]): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, seed_input_file_ids, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3::jsonb, $4, $5)`,
        values: [analysisId, dpStatus, seed === null ? null : JSON.stringify(seed), now, now],
    });
}

/** Read `data_profile_status` straight off the row, bypassing `loadDataProfileStatus`'s NULL-collapse. */
async function rawStatus(pool: Pool, analysisId: string): Promise<string | null> {
    const res = await pool.query<{ data_profile_status: string | null }>({
        text: "SELECT data_profile_status FROM cortex_analysis_state WHERE analysis_id = $1",
        values: [analysisId],
    });
    return res.rows[0]?.data_profile_status ?? null;
}

/** Rewrite `seed_input_file_ids` directly — the column every claim's CAS conjunct reads. */
async function setSeed(pool: Pool, analysisId: string, seed: string[] | null): Promise<void> {
    await pool.query({
        text: `UPDATE cortex_analysis_state SET seed_input_file_ids = $1::jsonb WHERE analysis_id = $2`,
        values: [seed === null ? null : JSON.stringify(seed), analysisId],
    });
}

const SAMPLE_RESULT = {
    summary: "3 RNA-seq count matrices",
    files: [
        { path: "data/inputs/f1/counts.csv", description: "Raw count matrix" },
        { path: "data/inputs/f2/metadata.csv", description: "Sample metadata" },
    ],
    inputFileIds: ["file-aaa", "file-bbb"],
    inputFiles: [
        { fileId: "file-aaa", size: 1024, mtimeMs: 1_780_000_000_000 },
        { fileId: "file-bbb", size: 2048, mtimeMs: 1_780_000_001_000 },
    ],
    profiledAt: "2026-06-09T10:00:00.000Z",
};

describe("data-profile state transitions", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_state_transitions");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("tryStartDataProfile: pending → running", async () => {
        await seedAnalysis(pool, "a-start", "pending");
        const claimed = (await tryStartDataProfile(pool, "a-start"))._unsafeUnwrap();
        expect(claimed).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-start"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
        expect(status?.startedAt).not.toBeNull();
    });

    it("tryStartDataProfile: only one caller wins the race", async () => {
        await seedAnalysis(pool, "a-race", "pending");
        // Both claims start before either is awaited — the eager ResultAsync fires
        // its query on construction, so the two UPDATEs race at the DB. Awaiting one
        // before constructing the other would serialize them and mask the race.
        const raceA = tryStartDataProfile(pool, "a-race");
        const raceB = tryStartDataProfile(pool, "a-race");
        const a = (await raceA)._unsafeUnwrap();
        const b = (await raceB)._unsafeUnwrap();
        expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it("tryStartDataProfile: no-op when not pending", async () => {
        await seedAnalysis(pool, "a-noop", "completed");
        const claimed = (await tryStartDataProfile(pool, "a-noop"))._unsafeUnwrap();
        expect(claimed).toBe(false);
    });

    it("tryRerunDataProfile: completed → running, preserves data_profile_result", async () => {
        await seedAnalysis(pool, "a-rerun", "pending");
        (await tryStartDataProfile(pool, "a-rerun"))._unsafeUnwrap();
        (await completeDataProfile(pool, "a-rerun", SAMPLE_RESULT))._unsafeUnwrap();

        const before = (await loadDataProfileStatus(pool, "a-rerun"))._unsafeUnwrap();
        expect(before?.status).toBe("completed");
        expect(before?.result).not.toBeNull();
        expect(before?.completedAt).not.toBeNull();

        const claimed = (await tryRerunDataProfile(pool, "a-rerun"))._unsafeUnwrap();
        expect(claimed).toBe(true);

        const after = (await loadDataProfileStatus(pool, "a-rerun"))._unsafeUnwrap();
        expect(after?.status).toBe("running");
        expect(after?.result).toEqual(SAMPLE_RESULT);
        expect(after?.completedAt).toBeNull();
        expect(after?.error).toBeNull();
        expect(after?.startedAt).not.toBeNull();
    });

    it("tryRerunDataProfile: no-op when not completed", async () => {
        await seedAnalysis(pool, "a-rerun-noop", "running");
        const claimed = (await tryRerunDataProfile(pool, "a-rerun-noop"))._unsafeUnwrap();
        expect(claimed).toBe(false);
    });

    it("tryRetryDataProfile: failed → running, preserves data_profile_result", async () => {
        await seedAnalysis(pool, "a-retry", "pending");
        (await tryStartDataProfile(pool, "a-retry"))._unsafeUnwrap();
        (await completeDataProfile(pool, "a-retry", SAMPLE_RESULT))._unsafeUnwrap();
        // Reach `failed` the only legitimate way: re-claim `completed → running` (the
        // re-profile route), then fail from `running` — `failDataProfile` CAS's on
        // `running`, so a direct `completed → failed` would now no-op.
        (await tryRerunDataProfile(pool, "a-retry"))._unsafeUnwrap();
        (await failDataProfile(pool, "a-retry", "sandbox crashed"))._unsafeUnwrap();

        const before = (await loadDataProfileStatus(pool, "a-retry"))._unsafeUnwrap();
        expect(before?.status).toBe("failed");
        expect(before?.result).toEqual(SAMPLE_RESULT);

        const claimed = (await tryRetryDataProfile(pool, "a-retry"))._unsafeUnwrap();
        expect(claimed).toBe(true);

        const after = (await loadDataProfileStatus(pool, "a-retry"))._unsafeUnwrap();
        expect(after?.status).toBe("running");
        expect(after?.result).toEqual(SAMPLE_RESULT);
        expect(after?.error).toBeNull();
        expect(after?.completedAt).toBeNull();
    });

    it("tryRetryDataProfile: no-op when not failed", async () => {
        await seedAnalysis(pool, "a-retry-noop", "completed");
        const claimed = (await tryRetryDataProfile(pool, "a-retry-noop"))._unsafeUnwrap();
        expect(claimed).toBe(false);
    });

    it("failDataProfile preserves prior data_profile_result", async () => {
        await seedAnalysis(pool, "a-fail-preserve", "pending");
        (await tryStartDataProfile(pool, "a-fail-preserve"))._unsafeUnwrap();
        (await completeDataProfile(pool, "a-fail-preserve", SAMPLE_RESULT))._unsafeUnwrap();
        (await tryRerunDataProfile(pool, "a-fail-preserve"))._unsafeUnwrap();
        (await failDataProfile(pool, "a-fail-preserve", "timeout"))._unsafeUnwrap();

        const status = (await loadDataProfileStatus(pool, "a-fail-preserve"))._unsafeUnwrap();
        expect(status?.status).toBe("failed");
        expect(status?.error).toBe("timeout");
        expect(status?.result).toEqual(SAMPLE_RESULT);
    });

    it("expireStaleDataProfile marks old running profiles as failed", async () => {
        await seedAnalysis(pool, "a-stale", "pending");
        (await tryStartDataProfile(pool, "a-stale"))._unsafeUnwrap();

        // Backdate started_at to 15 minutes ago
        await pool.query({
            text: `UPDATE cortex_analysis_state
             SET data_profile_started_at = $1
             WHERE analysis_id = $2`,
            values: [new Date(Date.now() - 15 * 60 * 1000).toISOString(), "a-stale"],
        });

        const expired = (await expireStaleDataProfile(pool, "a-stale", 10 * 60 * 1000))._unsafeUnwrap();
        expect(expired).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-stale"))._unsafeUnwrap();
        expect(status?.status).toBe("failed");
        expect(status?.error).toBe("Data profiling timed out");
    });

    it("expireStaleDataProfile: no-op when within timeout", async () => {
        await seedAnalysis(pool, "a-fresh", "pending");
        (await tryStartDataProfile(pool, "a-fresh"))._unsafeUnwrap();

        const expired = (await expireStaleDataProfile(pool, "a-fresh", 10 * 60 * 1000))._unsafeUnwrap();
        expect(expired).toBe(false);

        const status = (await loadDataProfileStatus(pool, "a-fresh"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });

    it("clearDataProfile: completed → cleared, nulls all six columns", async () => {
        await seedAnalysis(pool, "a-clear-done", "pending");
        (await tryStartDataProfile(pool, "a-clear-done"))._unsafeUnwrap();
        (await completeDataProfile(pool, "a-clear-done", SAMPLE_RESULT))._unsafeUnwrap();
        // Seed the sixth column the clear must null — the seed helper leaves it null.
        await pool.query({
            text: `UPDATE cortex_analysis_state SET seed_input_file_ids = $1::jsonb WHERE analysis_id = $2`,
            values: [JSON.stringify(["file-aaa", "file-bbb"]), "a-clear-done"],
        });

        const cleared = (await clearDataProfile(pool, "a-clear-done"))._unsafeUnwrap();
        expect(cleared).toBe(true);

        const raw = await pool.query({
            text: `SELECT data_profile_status, data_profile_error, data_profile_started_at,
                   data_profile_completed_at, data_profile_result, seed_input_file_ids
            FROM cortex_analysis_state WHERE analysis_id = $1`,
            values: ["a-clear-done"],
        });
        const row = raw.rows[0];
        expect(row.data_profile_status).toBeNull();
        expect(row.data_profile_error).toBeNull();
        expect(row.data_profile_started_at).toBeNull();
        expect(row.data_profile_completed_at).toBeNull();
        expect(row.data_profile_result).toBeNull();
        expect(row.seed_input_file_ids).toBeNull();

        // A cleared profile reads back as "no profile" — the same null a
        // never-profiled analysis returns.
        const status = (await loadDataProfileStatus(pool, "a-clear-done"))._unsafeUnwrap();
        expect(status).toBeNull();
    });

    it("clearDataProfile: failed → cleared", async () => {
        await seedAnalysis(pool, "a-clear-failed", "failed");
        const cleared = (await clearDataProfile(pool, "a-clear-failed"))._unsafeUnwrap();
        expect(cleared).toBe(true);
        expect((await loadDataProfileStatus(pool, "a-clear-failed"))._unsafeUnwrap()).toBeNull();
    });

    it("clearDataProfile: pending → cleared", async () => {
        await seedAnalysis(pool, "a-clear-pending", "pending");
        const cleared = (await clearDataProfile(pool, "a-clear-pending"))._unsafeUnwrap();
        expect(cleared).toBe(true);
        expect((await loadDataProfileStatus(pool, "a-clear-pending"))._unsafeUnwrap()).toBeNull();
    });

    it("clearDataProfile: running → skipped, changes nothing", async () => {
        await seedAnalysis(pool, "a-clear-running", "pending");
        (await tryStartDataProfile(pool, "a-clear-running"))._unsafeUnwrap();

        const cleared = (await clearDataProfile(pool, "a-clear-running"))._unsafeUnwrap();
        expect(cleared).toBe(false);

        const status = (await loadDataProfileStatus(pool, "a-clear-running"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
        expect(status?.startedAt).not.toBeNull();
    });

    it("clearDataProfile: absent row → skipped", async () => {
        const cleared = (await clearDataProfile(pool, "a-clear-missing"))._unsafeUnwrap();
        expect(cleared).toBe(false);
    });

    it("clear-then-reseed-then-reprofile lifecycle: the cleared row is claimable once reseeded", async () => {
        await seedAnalysis(pool, "a-reprofile", "pending");
        (await tryStartDataProfile(pool, "a-reprofile"))._unsafeUnwrap();
        (await completeDataProfile(pool, "a-reprofile", SAMPLE_RESULT))._unsafeUnwrap();
        (await clearDataProfile(pool, "a-reprofile"))._unsafeUnwrap();

        // The clear nulled status AND seed. Status alone is claimable; the seed is not,
        // so the row stays unclaimable until the inputs (and their seed) return.
        expect((await tryStartDataProfile(pool, "a-reprofile"))._unsafeUnwrap()).toBe(false);

        await setSeed(pool, "a-reprofile", ["file-returned"]);
        expect((await tryStartDataProfile(pool, "a-reprofile"))._unsafeUnwrap()).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-reprofile"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
        expect(status?.startedAt).not.toBeNull();
    });

    it("tryStartDataProfile: claims a NULL-status row once it carries a seed", async () => {
        await seedAnalysis(pool, "a-start-null", "pending");
        (await clearDataProfile(pool, "a-start-null"))._unsafeUnwrap();
        // The clear leaves status NULL — confirm the precondition, then reseed and claim.
        expect((await loadDataProfileStatus(pool, "a-start-null"))._unsafeUnwrap()).toBeNull();
        await setSeed(pool, "a-start-null", ["file-aaa"]);

        const claimed = (await tryStartDataProfile(pool, "a-start-null"))._unsafeUnwrap();
        expect(claimed).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-start-null"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });
});

// A `running` row must always name the files it is profiling. The conjunct lives in each
// claim's CAS rather than in a caller's pre-read, because `clearDataProfile` can null the
// seed of any non-`running` row at any moment — so a read-then-claim is a race. `[]` is a
// real value meaning "zero files" (NULL means "leave the stored seed alone" to the upsert),
// and is refused identically.
describe("the seed conjunct on every claim into running", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_seed_conjunct");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    const claims = [
        { name: "tryStartDataProfile", status: "pending", claim: tryStartDataProfile },
        { name: "tryStartDataProfile (NULL status)", status: null, claim: tryStartDataProfile },
        { name: "tryRerunDataProfile", status: "completed", claim: tryRerunDataProfile },
        { name: "tryRetryDataProfile", status: "failed", claim: tryRetryDataProfile },
    ] as const;

    for (const { name, status, claim } of claims) {
        const slug = name.replace(/\W+/g, "-").toLowerCase();

        it(`${name}: refuses a NULL seed`, async () => {
            const id = `null-${slug}`;
            await seedAnalysis(pool, id, status, null);
            expect((await claim(pool, id))._unsafeUnwrap()).toBe(false);
            expect(await rawStatus(pool, id)).toBe(status);
        });

        it(`${name}: refuses an empty seed`, async () => {
            const id = `empty-${slug}`;
            await seedAnalysis(pool, id, status, []);
            expect((await claim(pool, id))._unsafeUnwrap()).toBe(false);
            expect(await rawStatus(pool, id)).toBe(status);
        });

        it(`${name}: claims a non-empty seed`, async () => {
            const id = `ok-${slug}`;
            await seedAnalysis(pool, id, status, ["file-aaa"]);
            expect((await claim(pool, id))._unsafeUnwrap()).toBe(true);
            expect(await rawStatus(pool, id)).toBe("running");
        });
    }

    it("no claim can ever leave a running row with no recorded input set", async () => {
        // The invariant, stated as a query. Seed every claimable status unseeded, fire every
        // claim at it, then assert the forbidden state does not exist anywhere in the schema.
        await seedAnalysis(pool, "inv-pending", "pending", null);
        await seedAnalysis(pool, "inv-null", null, []);
        await seedAnalysis(pool, "inv-completed", "completed", null);
        await seedAnalysis(pool, "inv-failed", "failed", []);
        for (const id of ["inv-pending", "inv-null", "inv-completed", "inv-failed"]) {
            (await tryStartDataProfile(pool, id))._unsafeUnwrap();
            (await tryRerunDataProfile(pool, id))._unsafeUnwrap();
            (await tryRetryDataProfile(pool, id))._unsafeUnwrap();
        }

        const seedless = await pool.query<{ analysis_id: string }>(
            `SELECT analysis_id FROM cortex_analysis_state
             WHERE data_profile_status = 'running'
               AND (seed_input_file_ids IS NULL OR jsonb_array_length(seed_input_file_ids) = 0)`,
        );
        expect(seedless.rows).toEqual([]);
    });
});

// A terminal write (`completeDataProfile` / `failDataProfile`) runs as plain workflow-body
// code and can reach the ledger after the row it targets was cleared (emptied inputs) or
// expired (stale-timeout) out from under it — including on a DBOS recovery replay. Both
// writes CAS on `data_profile_status = 'running'` so a late write finds no running row and
// no-ops, instead of resurrecting the seedless-`completed` state the seed CAS forbids.
describe("terminal writes CAS on running — a cleared row is never resurrected", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("dp_terminal_cas");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    /**
     * Drive a claimed-`running` row through the finding's expiry-zombie interleave:
     * the stale-timeout expiry flips `running → failed`, then `clearDataProfile`
     * succeeds on that `failed` row (its guard only defers on `running`). Leaves the
     * row cleared while a notionally-still-live workflow holds the claim.
     */
    async function runningThenExpiredThenCleared(id: string): Promise<void> {
        await seedAnalysis(pool, id, "pending");
        (await tryStartDataProfile(pool, id))._unsafeUnwrap();
        await pool.query({
            text: `UPDATE cortex_analysis_state SET data_profile_started_at = $1 WHERE analysis_id = $2`,
            values: [new Date(Date.now() - 15 * 60 * 1000).toISOString(), id],
        });
        (await expireStaleDataProfile(pool, id, 10 * 60 * 1000))._unsafeUnwrap();
        expect((await clearDataProfile(pool, id))._unsafeUnwrap()).toBe(true);
    }

    it("completeDataProfile no-ops after a clear and leaves the row cleared", async () => {
        await runningThenExpiredThenCleared("a-complete-after-clear");

        const stamped = (await completeDataProfile(pool, "a-complete-after-clear", SAMPLE_RESULT))._unsafeUnwrap();
        expect(stamped).toBe(false);

        // Reads back as "no profile"; nothing resurrected — status, result, and seed all NULL.
        expect((await loadDataProfileStatus(pool, "a-complete-after-clear"))._unsafeUnwrap()).toBeNull();
        const raw = await pool.query<{ data_profile_status: string | null; data_profile_result: unknown; seed_input_file_ids: string[] | null }>({
            text: "SELECT data_profile_status, data_profile_result, seed_input_file_ids FROM cortex_analysis_state WHERE analysis_id = $1",
            values: ["a-complete-after-clear"],
        });
        expect(raw.rows[0]?.data_profile_status).toBeNull();
        expect(raw.rows[0]?.data_profile_result).toBeNull();
        expect(raw.rows[0]?.seed_input_file_ids).toBeNull();
    });

    it("failDataProfile no-ops after a clear and leaves the row cleared", async () => {
        await runningThenExpiredThenCleared("a-fail-after-clear");

        const stamped = (await failDataProfile(pool, "a-fail-after-clear", "sandbox crashed"))._unsafeUnwrap();
        expect(stamped).toBe(false);

        expect((await loadDataProfileStatus(pool, "a-fail-after-clear"))._unsafeUnwrap()).toBeNull();
        expect(await rawStatus(pool, "a-fail-after-clear")).toBeNull();
    });

    it("completeDataProfile still stamps a genuinely running row", async () => {
        await seedAnalysis(pool, "a-complete-running", "pending");
        (await tryStartDataProfile(pool, "a-complete-running"))._unsafeUnwrap();

        const stamped = (await completeDataProfile(pool, "a-complete-running", SAMPLE_RESULT))._unsafeUnwrap();
        expect(stamped).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-complete-running"))._unsafeUnwrap();
        expect(status?.status).toBe("completed");
        expect(status?.result).toEqual(SAMPLE_RESULT);
    });

    it("failDataProfile still stamps a genuinely running row", async () => {
        await seedAnalysis(pool, "a-fail-running", "pending");
        (await tryStartDataProfile(pool, "a-fail-running"))._unsafeUnwrap();

        const stamped = (await failDataProfile(pool, "a-fail-running", "boom"))._unsafeUnwrap();
        expect(stamped).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-fail-running"))._unsafeUnwrap();
        expect(status?.status).toBe("failed");
        expect(status?.error).toBe("boom");
    });
});
