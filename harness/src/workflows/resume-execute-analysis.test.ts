/**
 * Tests for `prepareExecuteAnalysisResume` (the resume contract for the
 * `executeAnalysis` parent workflow).
 *
 * Covers:
 *  - Happy path: bumps `cortex_runs.attempt_count` and returns the new value.
 *  - Repeated calls bump monotonically (idempotent in the harmless sense).
 *  - Missing workflow id → `MissingRunError`.
 *  - The workflowId / runId are preserved across resumes (they're the same
 *    bare UUID after the run-mandate-passport-chain change).
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { insertRun, queryRun } from "../state/index.js";
import { MissingRunError, prepareExecuteAnalysisResume } from "./resume-execute-analysis.js";

describe("prepareExecuteAnalysisResume", () => {
    let drop: () => Promise<void>;
    let pool: Pool;

    afterEach(async () => {
        await drop?.();
    });

    it("bumps attempt_count from 0 -> 1 and preserves runId/workflowId", async () => {
        ({ pool, drop } = await withSchema("resume_helper_bump"));
        await insertRun(pool, {
            runId: "run-1",
            analysisId: "a1",
            workflowName: "executeAnalysis",
        });

        const result = await prepareExecuteAnalysisResume(pool, "run-1");
        expect(result.runId).toBe("run-1");
        expect(result.workflowId).toBe("run-1");
        expect(result.attempt).toBe(1);
        expect(result.previousStatus).toBe("running");

        const row = (await queryRun(pool, "run-1"))._unsafeUnwrap();
        expect(row).not.toBeNull();
        expect(row!.attemptCount).toBe(1);
        expect(row!.runId).toBe("run-1");
    });

    it("repeated calls bump monotonically", async () => {
        ({ pool, drop } = await withSchema("resume_helper_repeat"));
        await insertRun(pool, {
            runId: "run-1",
            analysisId: "a1",
            workflowName: "executeAnalysis",
        });

        const first = await prepareExecuteAnalysisResume(pool, "run-1");
        const second = await prepareExecuteAnalysisResume(pool, "run-1");
        const third = await prepareExecuteAnalysisResume(pool, "run-1");

        expect(first.attempt).toBe(1);
        expect(second.attempt).toBe(2);
        expect(third.attempt).toBe(3);
    });

    it("throws MissingRunError for an unknown workflow id", async () => {
        ({ pool, drop } = await withSchema("resume_helper_missing"));
        let caught: unknown;
        try {
            await prepareExecuteAnalysisResume(pool, "ghost-nope");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(MissingRunError);
        expect((caught as MissingRunError).workflowId).toBe("ghost-nope");
    });
});
