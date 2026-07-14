import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { insertStepExecution, queryStepsByRun, seedStepExecutions, updateStepExecution } from "./step-executions.js";
import { createBlockerHolder, createReportBlockerTool } from "../tools/sandbox/report-blocker.js";
import type { ToolContext } from "../tools/define-tool.js";

async function seedRunning(pool: Pool, runId: string, stepId: string): Promise<void> {
    (
        await insertStepExecution(pool, {
            runId,
            stepId,
            analysisId: "analysis-1",
            wave: 0,
            agentId: "scientific-executor",
        })
    )._unsafeUnwrap();
}

async function readStep(pool: Pool, runId: string, stepId: string) {
    const rows = (await queryStepsByRun(pool, runId))._unsafeUnwrap();
    return rows.find((r) => r.stepId === stepId);
}

describe("step-executions: blocked status", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("step_exec_blocked");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("round-trips a blocked status + blocked_reason", async () => {
        await seedRunning(pool, "run-blocked", "step-1");
        (
            await updateStepExecution(pool, "run-blocked", "step-1", {
                status: "blocked",
                durationMs: 1234,
                error: "required input file missing",
                blockedReason: "required input file missing",
                attempts: 1,
                lastErrorClass: "blocked",
                finishReason: "end_turn",
                hitMaxSteps: false,
            })
        )._unsafeUnwrap();

        const row = await readStep(pool, "run-blocked", "step-1");
        expect(row?.status).toBe("blocked");
        expect(row?.blockedReason).toBe("required input file missing");
        expect(row?.error).toBe("required input file missing");
        expect(row?.finishReason).toBe("end_turn");
        expect(row?.durationMs).toBe(1234);
        expect(row?.completedAt).not.toBeNull();
    });

    it("leaves blocked_reason null for non-blocked terminal statuses", async () => {
        await seedRunning(pool, "run-completed", "step-1");
        (
            await updateStepExecution(pool, "run-completed", "step-1", {
                status: "completed",
                durationMs: 10,
                finishReason: "end_turn",
                hitMaxSteps: false,
            })
        )._unsafeUnwrap();

        const row = await readStep(pool, "run-completed", "step-1");
        expect(row?.status).toBe("completed");
        expect(row?.blockedReason).toBeNull();
    });
});

describe("step-executions: pending seeding", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("step_exec_seed");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    function seedRows(runId: string, stepIds: string[], wave = 0) {
        return stepIds.map((stepId) => ({ runId, stepId, analysisId: "analysis-1", wave, agentId: "scientific-executor" }));
    }

    it("seeds pending rows with null started_at", async () => {
        (await seedStepExecutions(pool, seedRows("run-seed", ["s1", "s2", "s3"])))._unsafeUnwrap();

        const rows = (await queryStepsByRun(pool, "run-seed"))._unsafeUnwrap();
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.status).toBe("pending");
            expect(row.startedAt).toBeNull();
            expect(row.completedAt).toBeNull();
        }
    });

    it("replay never regresses an advanced row (DO NOTHING)", async () => {
        (await seedStepExecutions(pool, seedRows("run-replay", ["s1", "s2"])))._unsafeUnwrap();
        await seedRunning(pool, "run-replay", "s1");
        (await updateStepExecution(pool, "run-replay", "s1", { status: "completed", durationMs: 5 }))._unsafeUnwrap();

        // The recovered parent replays the seed — including a step it now also knows about (s3).
        (await seedStepExecutions(pool, seedRows("run-replay", ["s1", "s2", "s3"])))._unsafeUnwrap();

        expect((await readStep(pool, "run-replay", "s1"))?.status).toBe("completed");
        expect((await readStep(pool, "run-replay", "s2"))?.status).toBe("pending");
        expect((await readStep(pool, "run-replay", "s3"))?.status).toBe("pending");
    });

    it("mark-running flips a seeded pending row", async () => {
        (await seedStepExecutions(pool, seedRows("run-flip", ["s1"])))._unsafeUnwrap();
        await seedRunning(pool, "run-flip", "s1");

        const row = await readStep(pool, "run-flip", "s1");
        expect(row?.status).toBe("running");
        expect(row?.startedAt).not.toBeNull();
    });

    it("orders by wave, started_at NULLS LAST, step_id", async () => {
        // Wave 0: one running row; wave 0 pending siblings; wave 1 pending.
        (await seedStepExecutions(pool, [...seedRows("run-order", ["s3", "s2"], 0), ...seedRows("run-order", ["s9"], 1)]))._unsafeUnwrap();
        await seedRunning(pool, "run-order", "s5");

        const ids = (await queryStepsByRun(pool, "run-order"))._unsafeUnwrap().map((r) => r.stepId);
        expect(ids).toEqual(["s5", "s2", "s3", "s9"]);
    });

    it("no-ops on an empty seed", async () => {
        (await seedStepExecutions(pool, []))._unsafeUnwrap();
        const rows = (await queryStepsByRun(pool, "run-empty"))._unsafeUnwrap();
        expect(rows).toHaveLength(0);
    });
});

describe("report_blocker tool", () => {
    const ctx = {} as ToolContext;

    it("records the blocker outcome into the holder", async () => {
        const holder = createBlockerHolder();
        const tool = createReportBlockerTool(holder);

        expect(holder.outcome).toBeNull();
        const result = (await tool.execute({ reason: "no usable data" }, ctx))._unsafeUnwrap();

        expect(holder.outcome).toEqual({ kind: "blocker", reason: "no usable data" });
        expect((result as { recorded: boolean }).recorded).toBe(true);
    });

    it("keeps the first reason when called twice", async () => {
        const holder = createBlockerHolder();
        const tool = createReportBlockerTool(holder);

        await tool.execute({ reason: "first" }, ctx);
        await tool.execute({ reason: "second" }, ctx);

        expect(holder.outcome).toEqual({ kind: "blocker", reason: "first" });
    });
});
