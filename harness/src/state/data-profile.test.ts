import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import {
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
        const [aR, bR] = await Promise.all([tryStartDataProfile(pool, "a-race"), tryStartDataProfile(pool, "a-race")]);
        const a = aR._unsafeUnwrap();
        const b = bR._unsafeUnwrap();
        expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it("tryStartDataProfile: no-op when not pending", async () => {
        await seedAnalysis(pool, "a-noop", "completed");
        const claimed = (await tryStartDataProfile(pool, "a-noop"))._unsafeUnwrap();
        expect(claimed).toBe(false);
    });

    it("tryRerunDataProfile: completed → running, preserves data_profile_result", async () => {
        await seedAnalysis(pool, "a-rerun", "pending");
        await tryStartDataProfile(pool, "a-rerun");
        await completeDataProfile(pool, "a-rerun", SAMPLE_RESULT);

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
        await tryStartDataProfile(pool, "a-retry");
        await completeDataProfile(pool, "a-retry", SAMPLE_RESULT);
        await failDataProfile(pool, "a-retry", "sandbox crashed");

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
        await tryStartDataProfile(pool, "a-fail-preserve");
        await completeDataProfile(pool, "a-fail-preserve", SAMPLE_RESULT);
        await tryRerunDataProfile(pool, "a-fail-preserve");
        await failDataProfile(pool, "a-fail-preserve", "timeout");

        const status = (await loadDataProfileStatus(pool, "a-fail-preserve"))._unsafeUnwrap();
        expect(status?.status).toBe("failed");
        expect(status?.error).toBe("timeout");
        expect(status?.result).toEqual(SAMPLE_RESULT);
    });

    it("expireStaleDataProfile marks old running profiles as failed", async () => {
        await seedAnalysis(pool, "a-stale", "pending");
        await tryStartDataProfile(pool, "a-stale");

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
        await tryStartDataProfile(pool, "a-fresh");

        const expired = (await expireStaleDataProfile(pool, "a-fresh", 10 * 60 * 1000))._unsafeUnwrap();
        expect(expired).toBe(false);

        const status = (await loadDataProfileStatus(pool, "a-fresh"))._unsafeUnwrap();
        expect(status?.status).toBe("running");
    });
});
