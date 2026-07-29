import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import {
    insertRun,
    queryNonTerminalRunsByAnalysis,
    queryRun,
    queryRunsForInspection,
    reserveRunById,
    RunIdentityCollisionError,
    setRunSynthesisOutcome,
    updateRunStatus,
} from "./runs.js";

describe("runs: synthesis outcome", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs_synthesis_outcome");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("round-trips a synthesis status + reason through queryRun", async () => {
        (await insertRun(pool, { runId: "run-synth", analysisId: "analysis-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await setRunSynthesisOutcome(pool, "run-synth", "skipped_blocker", "some reason"))._unsafeUnwrap();

        const row = (await queryRun(pool, "run-synth"))._unsafeUnwrap();
        expect(row?.synthesisStatus).toBe("skipped_blocker");
        expect(row?.synthesisReason).toBe("some reason");
    });

    it("reads null status + reason on a freshly inserted run", async () => {
        (await insertRun(pool, { runId: "run-fresh", analysisId: "analysis-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const row = (await queryRun(pool, "run-fresh"))._unsafeUnwrap();
        expect(row?.synthesisStatus).toBeNull();
        expect(row?.synthesisReason).toBeNull();
    });

    it("treats a deterministic run id as the same delivery even after it is terminal", async () => {
        const first = (
            await reserveRunById(pool, {
                runId: "run-deterministic",
                analysisId: "analysis-1",
                workflowName: "executeAnalysis",
            })
        )._unsafeUnwrap();
        expect(first.inserted).toBe(true);

        (await updateRunStatus(pool, "run-deterministic", "completed"))._unsafeUnwrap();

        const replay = (
            await reserveRunById(pool, {
                runId: "run-deterministic",
                analysisId: "analysis-1",
                workflowName: "executeAnalysis",
            })
        )._unsafeUnwrap();
        expect(replay.inserted).toBe(false);
        expect(replay.row.runId).toBe("run-deterministic");
        expect(replay.row.status).toBe("completed");
    });

    it("allows exactly one winner when the same deterministic run id is reserved concurrently", async () => {
        const attempts = await Promise.all([
            (async () =>
                (
                    await reserveRunById(pool, {
                        runId: "run-concurrent",
                        analysisId: "analysis-1",
                        workflowName: "executeAnalysis",
                    })
                )._unsafeUnwrap())(),
            (async () =>
                (
                    await reserveRunById(pool, {
                        runId: "run-concurrent",
                        analysisId: "analysis-1",
                        workflowName: "executeAnalysis",
                    })
                )._unsafeUnwrap())(),
        ]);
        expect(attempts.filter((reservation) => reservation.inserted)).toHaveLength(1);
        expect(attempts.every((reservation) => reservation.row.runId === "run-concurrent")).toBe(true);
    });

    it("surfaces a cross-analysis collision instead of treating it as redelivery", async () => {
        (
            await reserveRunById(pool, {
                runId: "run-cross-analysis",
                analysisId: "analysis-1",
                workflowName: "executeAnalysis",
            })
        )._unsafeUnwrap();

        await expect(
            (async () =>
                (
                    await reserveRunById(pool, {
                        runId: "run-cross-analysis",
                        analysisId: "analysis-2",
                        workflowName: "executeAnalysis",
                    })
                )._unsafeUnwrap())(),
        ).rejects.toBeInstanceOf(RunIdentityCollisionError);
    });
});

describe("runs: conversation and inspection projections", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs_conversation_inspection");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("orders running before suspended before terminal prior to pagination", async () => {
        const analysisId = "analysis-order";
        for (const runId of ["run-old-running", "run-new-running", "run-suspended", "run-completed"]) {
            (await insertRun(pool, { runId, analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        }
        (await updateRunStatus(pool, "run-suspended", "suspended_insufficient_funds"))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-completed", "completed"))._unsafeUnwrap();
        await pool.query({
            text: `UPDATE cortex_runs
                   SET started_at = CASE run_id
                       WHEN 'run-old-running' THEN '2026-01-01T00:00:00.000Z'
                       WHEN 'run-new-running' THEN '2026-01-04T00:00:00.000Z'
                       WHEN 'run-suspended' THEN '2026-01-03T00:00:00.000Z'
                       WHEN 'run-completed' THEN '2026-01-05T00:00:00.000Z'
                   END
                   WHERE analysis_id = $1`,
            values: [analysisId],
        });

        const first = (await queryRunsForInspection(pool, analysisId, { limit: 3 }))._unsafeUnwrap();
        expect(first.total).toBe(4);
        expect(first.runs.map((run) => run.runId)).toEqual(["run-new-running", "run-old-running", "run-suspended"]);

        const second = (await queryRunsForInspection(pool, analysisId, { limit: 3, offset: 3 }))._unsafeUnwrap();
        expect(second.total).toBe(4);
        expect(second.runs.map((run) => run.runId)).toEqual(["run-completed"]);
    });

    it("bounds non-terminal detail while reporting the true analysis-wide total", async () => {
        const analysisId = "analysis-activity";
        for (let index = 0; index < 22; index += 1) {
            const runId = `run-activity-${String(index).padStart(2, "0")}`;
            (await insertRun(pool, { runId, analysisId, threadId: index === 0 ? "other-thread" : null, workflowName: "executeAnalysis" }))._unsafeUnwrap();
            if (index >= 20) {
                (await updateRunStatus(pool, runId, "suspended_insufficient_funds"))._unsafeUnwrap();
            }
        }
        (await insertRun(pool, { runId: "run-terminal", analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-terminal", "completed"))._unsafeUnwrap();

        const activity = (await queryNonTerminalRunsByAnalysis(pool, analysisId, 20))._unsafeUnwrap();
        expect(activity.total).toBe(22);
        expect(activity.runs).toHaveLength(20);
        expect(activity.runs.every((run) => run.status === "running")).toBe(true);
        expect(activity.runs.some((run) => run.runId === "run-terminal")).toBe(false);
    });
});
