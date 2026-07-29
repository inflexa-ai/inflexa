import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { insertRun, queryRun, reserveRunById, RunIdentityCollisionError, setRunSynthesisOutcome, updateRunStatus } from "./runs.js";

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
