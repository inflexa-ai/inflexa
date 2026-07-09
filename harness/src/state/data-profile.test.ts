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

async function seedAnalysis(pool: Pool, analysisId: string, dpStatus = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3, $4)`,
        values: [analysisId, dpStatus, now, now],
    });
}

const SAMPLE_RESULT = {
    summary: "3 RNA-seq count matrices",
    files: [
        { path: "data/inputs/f1/counts.csv", description: "Raw count matrix" },
        { path: "data/inputs/f2/metadata.csv", description: "Sample metadata" },
    ],
    inputFileIds: ["file-aaa", "file-bbb"],
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

    it("clear-then-reprofile lifecycle: cleared row is claimable by tryStartDataProfile", async () => {
        await seedAnalysis(pool, "a-reprofile", "pending");
        (await tryStartDataProfile(pool, "a-reprofile"))._unsafeUnwrap();
        (await completeDataProfile(pool, "a-reprofile", SAMPLE_RESULT))._unsafeUnwrap();
        (await clearDataProfile(pool, "a-reprofile"))._unsafeUnwrap();

        const claimed = (await tryStartDataProfile(pool, "a-reprofile"))._unsafeUnwrap();
        expect(claimed).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-reprofile"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
        expect(status?.startedAt).not.toBeNull();
    });

    it("tryStartDataProfile: claims a NULL-status row (seeded then cleared)", async () => {
        await seedAnalysis(pool, "a-start-null", "pending");
        (await clearDataProfile(pool, "a-start-null"))._unsafeUnwrap();
        // The clear leaves status NULL — confirm the precondition, then claim.
        expect((await loadDataProfileStatus(pool, "a-start-null"))._unsafeUnwrap()).toBeNull();

        const claimed = (await tryStartDataProfile(pool, "a-start-null"))._unsafeUnwrap();
        expect(claimed).toBe(true);

        const status = (await loadDataProfileStatus(pool, "a-start-null"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });
});
