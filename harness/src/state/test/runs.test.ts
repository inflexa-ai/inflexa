import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { countingQuerier } from "../../__tests__/setup/counting-querier.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../analyses.js";
import { insertPlan } from "../plans.js";
import {
    countRunsByAnalysis,
    insertRun,
    markRunCanceledIfActive,
    queryActiveRun,
    queryActiveRunsByAnalysis,
    queryNewestPlanRun,
    queryNonTerminalRunsByAnalysis,
    queryRun,
    queryRunIdsByPlan,
    queryRunsByAnalysis,
    queryRunsByThread,
    queryRunsForInspection,
    reserveRunById,
    RunDedupCollisionError,
    RunIdentityCollisionError,
    setRunSynthesisOutcome,
    updateRunStatus,
} from "../runs.js";

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

    it("orders running before each other run prior to pagination", async () => {
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
        expect(first.runs.map((run) => run.runId)).toEqual(["run-new-running", "run-old-running", "run-completed"]);

        const second = (await queryRunsForInspection(pool, analysisId, { limit: 3, offset: 3 }))._unsafeUnwrap();
        expect(second.total).toBe(4);
        expect(second.runs.map((run) => run.runId)).toEqual(["run-suspended"]);
    });

    it("bounds non-terminal detail while reporting the true analysis-wide total", async () => {
        const analysisId = "analysis-activity";
        for (let index = 0; index < 22; index += 1) {
            const runId = `run-activity-${String(index).padStart(2, "0")}`;
            (await insertRun(pool, { runId, analysisId, threadId: index === 0 ? "other-thread" : null, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        }
        (await insertRun(pool, { runId: "run-activity-suspended", analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-activity-suspended", "suspended_insufficient_funds"))._unsafeUnwrap();
        (await insertRun(pool, { runId: "run-terminal", analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-terminal", "completed"))._unsafeUnwrap();

        const activity = (await queryNonTerminalRunsByAnalysis(pool, analysisId, 20))._unsafeUnwrap();
        expect(activity.total).toBe(22);
        expect(activity.runs).toHaveLength(20);
        expect(activity.runs.every((run) => run.status === "running")).toBe(true);
        expect(activity.runs.some((run) => run.runId === "run-terminal" || run.runId === "run-activity-suspended")).toBe(false);
    });
});

// `queryRunsByAnalysis` is windowed by `started_at DESC LIMIT`, which drops the OLDEST running run
// first — precisely the long analysis a host's live surfaces most need. This query exists so live
// work is never a function of how many runs started after it.
describe("runs: active-run query", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs-active");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("returns only non-terminal runs, and finds one buried under newer finished runs", async () => {
        (await insertRun(pool, { runId: "run-long", analysisId: "a-active", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        // Twenty newer runs, all finished — far past any window a listing would apply.
        for (let i = 0; i < 20; i++) {
            const id = `run-new-${i}`;
            (await insertRun(pool, { runId: id, analysisId: "a-active", workflowName: "executeAnalysis" }))._unsafeUnwrap();
            (await updateRunStatus(pool, id, "completed"))._unsafeUnwrap();
        }

        const active = (await queryActiveRunsByAnalysis(pool, "a-active"))._unsafeUnwrap();
        expect(active.map((r) => r.runId)).toEqual(["run-long"]);
    });

    it("treats a suspended run and a canceled run as not active", async () => {
        (await insertRun(pool, { runId: "run-susp", analysisId: "a-susp", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-susp", "suspended_insufficient_funds"))._unsafeUnwrap();
        (await insertRun(pool, { runId: "run-cancel", analysisId: "a-susp", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-cancel", "canceled"))._unsafeUnwrap();

        expect((await queryActiveRunsByAnalysis(pool, "a-susp"))._unsafeUnwrap()).toEqual([]);
    });

    it("scopes to the analysis and returns empty when nothing is live", async () => {
        (await insertRun(pool, { runId: "run-other", analysisId: "a-other", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        expect((await queryActiveRunsByAnalysis(pool, "a-empty"))._unsafeUnwrap()).toEqual([]);
        expect((await queryActiveRunsByAnalysis(pool, "a-other"))._unsafeUnwrap().map((r) => r.runId)).toEqual(["run-other"]);
    });
});

describe("runs: markRunCanceledIfActive", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs_mark_canceled_if_active");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("transitions a running run to canceled, stamping completed_at and the reason", async () => {
        (await insertRun(pool, { runId: "run-active", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const transitioned = (await markRunCanceledIfActive(pool, "run-active", "external_cancel"))._unsafeUnwrap();
        expect(transitioned).toBe(true);

        const row = (await queryRun(pool, "run-active"))._unsafeUnwrap();
        expect(row?.status).toBe("canceled");
        expect(row?.error).toBe("external_cancel");
        expect(row?.completedAt).not.toBeNull();
    });

    it("refuses a suspended run and reports no transition", async () => {
        (await insertRun(pool, { runId: "run-susp", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-susp", "suspended_insufficient_funds", "budget_exceeded"))._unsafeUnwrap();

        expect((await markRunCanceledIfActive(pool, "run-susp", "external_cancel"))._unsafeUnwrap()).toBe(false);
        const row = (await queryRun(pool, "run-susp"))._unsafeUnwrap();
        expect(row?.status).toBe("suspended_insufficient_funds");
        expect(row?.error).toBe("budget_exceeded");
    });

    it("refuses to clobber a completed run and reports no transition", async () => {
        (await insertRun(pool, { runId: "run-done", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-done", "completed"))._unsafeUnwrap();
        const before = (await queryRun(pool, "run-done"))._unsafeUnwrap();

        const transitioned = (await markRunCanceledIfActive(pool, "run-done", "external_cancel"))._unsafeUnwrap();
        expect(transitioned).toBe(false);

        const after = (await queryRun(pool, "run-done"))._unsafeUnwrap();
        expect(after?.status).toBe("completed");
        expect(after?.completedAt).toBe(before?.completedAt ?? null);
        expect(after?.error).toBeNull();
    });

    it("reports no transition for a run that does not exist", async () => {
        expect((await markRunCanceledIfActive(pool, "run-nowhere", "external_cancel"))._unsafeUnwrap()).toBe(false);
    });
});

describe("runs: updateRunStatus", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs_update_run_status");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("changes a running run, stamps completed_at and the error, and reports the change", async () => {
        (await insertRun(pool, { runId: "run-running", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const changed = (await updateRunStatus(pool, "run-running", "suspended_insufficient_funds", "budget_exceeded"))._unsafeUnwrap();
        expect(changed).toBe(true);

        const row = (await queryRun(pool, "run-running"))._unsafeUnwrap();
        expect(row?.status).toBe("suspended_insufficient_funds");
        expect(row?.error).toBe("budget_exceeded");
        expect(row?.completedAt).not.toBeNull();
    });

    it("keeps a canceled run canceled when a later write lands", async () => {
        (await insertRun(pool, { runId: "run-canceled", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        expect((await markRunCanceledIfActive(pool, "run-canceled", "external_cancel"))._unsafeUnwrap()).toBe(true);
        const before = (await queryRun(pool, "run-canceled"))._unsafeUnwrap();

        const changed = (await updateRunStatus(pool, "run-canceled", "completed"))._unsafeUnwrap();
        expect(changed).toBe(false);

        const after = (await queryRun(pool, "run-canceled"))._unsafeUnwrap();
        expect(after?.status).toBe("canceled");
        expect(after?.error).toBe("external_cancel");
        expect(after?.completedAt).toBe(before?.completedAt ?? null);
    });

    it("keeps a completed run completed when a failed write lands", async () => {
        (await insertRun(pool, { runId: "run-completed", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        expect((await updateRunStatus(pool, "run-completed", "completed"))._unsafeUnwrap()).toBe(true);
        const before = (await queryRun(pool, "run-completed"))._unsafeUnwrap();

        const changed = (await updateRunStatus(pool, "run-completed", "failed", "workflow start failed"))._unsafeUnwrap();
        expect(changed).toBe(false);

        const after = (await queryRun(pool, "run-completed"))._unsafeUnwrap();
        expect(after?.status).toBe("completed");
        expect(after?.error).toBeNull();
        expect(after?.completedAt).toBe(before?.completedAt ?? null);
    });

    it("reports no change for a run that does not exist", async () => {
        expect((await updateRunStatus(pool, "run-nowhere", "completed"))._unsafeUnwrap()).toBe(false);
    });

    it("writes an error text that holds a NUL character, and stores the text without it", async () => {
        (await insertRun(pool, { runId: "run-nul", analysisId: "a-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const changed = (await updateRunStatus(pool, "run-nul", "failed", `step failed:\u0000 bad\u0000bytes`))._unsafeUnwrap();
        expect(changed).toBe(true);

        const row = (await queryRun(pool, "run-nul"))._unsafeUnwrap();
        expect(row?.status).toBe("failed");
        expect(row?.error).toBe("step failed: badbytes");
    });
});

describe("runs: a suspended run is terminal", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs_suspended_terminal");
        pool = ctx.pool;
        drop = ctx.drop;
        (await upsertAnalysis(pool, "a-plan", null))._unsafeUnwrap();
    });

    afterAll(async () => {
        await drop();
    });

    async function planId(): Promise<string> {
        return (await insertPlan(pool, { analysisId: "a-plan", plan: { steps: [] } }))._unsafeUnwrap();
    }

    it("stamps completed_at and keeps the error when the status is suspended_insufficient_funds", async () => {
        (await insertRun(pool, { runId: "run-stamp", analysisId: "a-plan", workflowName: "executeAnalysis" }))._unsafeUnwrap();

        (await updateRunStatus(pool, "run-stamp", "suspended_insufficient_funds", "budget_exceeded"))._unsafeUnwrap();

        const row = (await queryRun(pool, "run-stamp"))._unsafeUnwrap();
        expect(row?.status).toBe("suspended_insufficient_funds");
        expect(row?.error).toBe("budget_exceeded");
        expect(row?.completedAt).not.toBeNull();
    });

    it("returns no active run for a plan whose only run is suspended", async () => {
        const plan = await planId();
        (await insertRun(pool, { runId: "run-only-susp", analysisId: "a-plan", planId: plan, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-only-susp", "suspended_insufficient_funds"))._unsafeUnwrap();

        expect((await queryActiveRun(pool, "a-plan", plan))._unsafeUnwrap()).toBeNull();
    });

    it("lets a new run of the plan start beside a suspended run", async () => {
        const plan = await planId();
        (await insertRun(pool, { runId: "run-first", analysisId: "a-plan", planId: plan, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await updateRunStatus(pool, "run-first", "suspended_insufficient_funds"))._unsafeUnwrap();

        (await insertRun(pool, { runId: "run-second", analysisId: "a-plan", planId: plan, workflowName: "executeAnalysis" }))._unsafeUnwrap();

        expect((await queryActiveRun(pool, "a-plan", plan))._unsafeUnwrap()?.runId).toBe("run-second");
    });

    it("still refuses a second running run of the plan", async () => {
        const plan = await planId();
        (await insertRun(pool, { runId: "run-a", analysisId: "a-plan", planId: plan, workflowName: "executeAnalysis" }))._unsafeUnwrap();

        await expect(
            (async () => (await insertRun(pool, { runId: "run-b", analysisId: "a-plan", planId: plan, workflowName: "executeAnalysis" }))._unsafeUnwrap())(),
        ).rejects.toBeInstanceOf(RunDedupCollisionError);
    });
});

describe("queryRunIdsByPlan", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("runs_ids_by_plan"));
        (await upsertAnalysis(pool, "a-ids", null))._unsafeUnwrap();
        (await upsertAnalysis(pool, "a-other", null))._unsafeUnwrap();
    });

    afterAll(async () => {
        await drop();
    });

    async function seedRun(runId: string, analysisId: string, planId: string | null, startedAt: string): Promise<void> {
        await pool.query({
            text: `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, plan_id)
                   VALUES ($1, $2, 'executeAnalysis', 'completed', $3, $4)`,
            values: [runId, analysisId, startedAt, planId],
        });
    }

    async function seedPlan(analysisId: string): Promise<string> {
        return (await insertPlan(pool, { analysisId, plan: { steps: [] } }))._unsafeUnwrap();
    }

    it("gives the run ids of the plan, newest first, and not the runs of another plan", async () => {
        const p1 = await seedPlan("a-ids");
        const p2 = await seedPlan("a-ids");
        await seedRun("r1", "a-ids", p1, "2026-10-01T00:00:00.000Z");
        await seedRun("r2", "a-ids", p1, "2026-10-02T00:00:00.000Z");
        await seedRun("r3", "a-ids", p2, "2026-10-03T00:00:00.000Z");

        expect((await queryRunIdsByPlan(pool, { analysisId: "a-ids", planId: p1, limit: 10 }))._unsafeUnwrap()).toEqual(["r2", "r1"]);
    });

    it("breaks a tie of start times with the highest run id", async () => {
        const p = await seedPlan("a-ids");
        const at = "2026-10-05T00:00:00.000Z";
        await seedRun("tie-a", "a-ids", p, at);
        await seedRun("tie-b", "a-ids", p, at);

        expect((await queryRunIdsByPlan(pool, { analysisId: "a-ids", planId: p, limit: 10 }))._unsafeUnwrap()).toEqual(["tie-b", "tie-a"]);
    });

    it("bounds the ids by the limit, and keeps the newest", async () => {
        const p = await seedPlan("a-ids");
        await seedRun("l1", "a-ids", p, "2026-10-01T00:00:00.000Z");
        await seedRun("l2", "a-ids", p, "2026-10-02T00:00:00.000Z");
        await seedRun("l3", "a-ids", p, "2026-10-03T00:00:00.000Z");

        expect((await queryRunIdsByPlan(pool, { analysisId: "a-ids", planId: p, limit: 2 }))._unsafeUnwrap()).toEqual(["l3", "l2"]);
    });

    it("gives an empty list for a plan with no run, and for a plan of another analysis", async () => {
        const p = await seedPlan("a-ids");
        const q = await seedPlan("a-other");
        await seedRun("o1", "a-other", q, "2026-10-01T00:00:00.000Z");

        expect((await queryRunIdsByPlan(pool, { analysisId: "a-ids", planId: p, limit: 10 }))._unsafeUnwrap()).toEqual([]);
        expect((await queryRunIdsByPlan(pool, { analysisId: "a-ids", planId: q, limit: 10 }))._unsafeUnwrap()).toEqual([]);
    });

    it("sends one statement", async () => {
        const p = await seedPlan("a-ids");
        const counted = countingQuerier(pool);
        (await queryRunIdsByPlan(counted.querier, { analysisId: "a-ids", planId: p, limit: 5 }))._unsafeUnwrap();
        expect(counted.calls()).toBe(1);
    });
});

describe("queryNewestPlanRun", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("runs_newest_plan_run"));
        (await upsertAnalysis(pool, "a-newest", null))._unsafeUnwrap();
        (await upsertAnalysis(pool, "a-other", null))._unsafeUnwrap();
    });

    afterAll(async () => {
        await drop();
    });

    async function seedPlan(analysisId: string): Promise<string> {
        return (await insertPlan(pool, { analysisId, plan: { steps: [] } }))._unsafeUnwrap();
    }

    async function seedRun(runId: string, analysisId: string, planId: string, startedAt: string): Promise<void> {
        (await insertRun(pool, { runId, analysisId, planId, workflowName: "executeAnalysis", startedAt }))._unsafeUnwrap();
        (await updateRunStatus(pool, runId, "completed"))._unsafeUnwrap();
    }

    it("gives the run with the latest start and its start time", async () => {
        const p = await seedPlan("a-newest");
        await seedRun("n1", "a-newest", p, "2026-10-01T00:00:00.000Z");
        await seedRun("n2", "a-newest", p, "2026-10-02T00:00:00.000Z");

        expect((await queryNewestPlanRun(pool, { analysisId: "a-newest", planId: p }))._unsafeUnwrap()).toEqual({
            runId: "n2",
            startedAt: "2026-10-02T00:00:00.000Z",
        });
    });

    it("breaks a tie of start times with the highest run id", async () => {
        const p = await seedPlan("a-newest");
        const at = "2026-10-05T00:00:00.000Z";
        await seedRun("tie-a", "a-newest", p, at);
        await seedRun("tie-b", "a-newest", p, at);

        expect((await queryNewestPlanRun(pool, { analysisId: "a-newest", planId: p }))._unsafeUnwrap()?.runId).toBe("tie-b");
    });

    it("gives null for a plan with no run, and for a plan of another analysis", async () => {
        const p = await seedPlan("a-newest");
        const q = await seedPlan("a-other");
        await seedRun("o1", "a-other", q, "2026-10-01T00:00:00.000Z");

        expect((await queryNewestPlanRun(pool, { analysisId: "a-newest", planId: p }))._unsafeUnwrap()).toBeNull();
        expect((await queryNewestPlanRun(pool, { analysisId: "a-newest", planId: q }))._unsafeUnwrap()).toBeNull();
    });

    it("writes the start time that insertRun receives", async () => {
        const p = await seedPlan("a-newest");
        const startedAt = "2031-01-02T03:04:05.678Z";
        (await insertRun(pool, { runId: "written", analysisId: "a-newest", planId: p, workflowName: "executeAnalysis", startedAt }))._unsafeUnwrap();

        expect((await queryRun(pool, "written"))._unsafeUnwrap()?.startedAt).toBe(startedAt);
    });

    it("writes the start time that reserveRunById receives", async () => {
        const p = await seedPlan("a-newest");
        const startedAt = "2032-02-03T04:05:06.789Z";
        const reservation = (
            await reserveRunById(pool, { runId: "reserved-written", analysisId: "a-newest", planId: p, workflowName: "executeAnalysis", startedAt })
        )._unsafeUnwrap();

        expect(reservation.inserted).toBe(true);
        expect(reservation.row.startedAt).toBe(startedAt);
        expect((await queryRun(pool, "reserved-written"))._unsafeUnwrap()?.startedAt).toBe(startedAt);
    });
});

describe("the text filter of the run reads", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("runs_text_filter"));
        for (const analysisId of ["t-dex", "t-win", "t-wild", "t-scope", "t-scope-other", "t-comb", "t-count", "t-notitle"]) {
            (await upsertAnalysis(pool, analysisId, null))._unsafeUnwrap();
        }
    });

    afterAll(async () => {
        await drop();
    });

    async function seedPlan(analysisId: string, plan: unknown): Promise<string> {
        return (await insertPlan(pool, { analysisId, plan }))._unsafeUnwrap();
    }

    async function seedRun(
        runId: string,
        analysisId: string,
        startedAt: string,
        opts: { planId?: string | null; threadId?: string | null; status?: "running" | "completed" } = {},
    ): Promise<void> {
        await pool.query({
            text: `INSERT INTO cortex_runs (run_id, analysis_id, thread_id, workflow_name, status, started_at, plan_id)
                   VALUES ($1, $2, $3, 'executeAnalysis', $4, $5, $6)`,
            values: [runId, analysisId, opts.threadId ?? null, opts.status ?? "completed", startedAt, opts.planId ?? null],
        });
    }

    const ids = (rows: { runId: string }[]): string[] => rows.map((r) => r.runId);

    it("finds the runs by the plan title or the run id, with no regard to case, newest first", async () => {
        const old = await seedPlan("t-dex", { title: "Gene index" });
        const mid = await seedPlan("t-dex", { title: "Pathway enrichment" });
        await seedRun("r-old", "t-dex", "2026-10-01T00:00:00.000Z", { planId: old });
        await seedRun("r-mid", "t-dex", "2026-10-02T00:00:00.000Z", { planId: mid });
        await seedRun("r-dex9", "t-dex", "2026-10-03T00:00:00.000Z");

        const upper = (await queryRunsByAnalysis(pool, "t-dex", { q: "DEX" }))._unsafeUnwrap();
        const lower = (await queryRunsByAnalysis(pool, "t-dex", { q: "dex" }))._unsafeUnwrap();
        const count = (await countRunsByAnalysis(pool, "t-dex", { q: "DEX" }))._unsafeUnwrap();

        expect(ids(upper)).toEqual(["r-dex9", "r-old"]);
        expect(ids(lower)).toEqual(["r-dex9", "r-old"]);
        expect(count).toBe(2);
    });

    it("matches a run id without a plan, and ignores a title that is not a string", async () => {
        const numeric = await seedPlan("t-notitle", { title: 42 });
        const untitled = await seedPlan("t-notitle", { steps: [] });
        await seedRun("n-42", "t-notitle", "2026-10-01T00:00:00.000Z");
        await seedRun("n-numeric", "t-notitle", "2026-10-02T00:00:00.000Z", { planId: numeric });
        await seedRun("n-untitled", "t-notitle", "2026-10-03T00:00:00.000Z", { planId: untitled });

        const rows = (await queryRunsByAnalysis(pool, "t-notitle", { q: "42" }))._unsafeUnwrap();

        expect(ids(rows)).toEqual(["n-42"]);
        expect((await countRunsByAnalysis(pool, "t-notitle", { q: "42" }))._unsafeUnwrap()).toBe(1);
    });

    it("selects the runs before the window, and the count agrees", async () => {
        const hit = await seedPlan("t-win", { title: "Volcano plot" });
        const miss = await seedPlan("t-win", { title: "Heatmap" });
        for (let i = 1; i <= 3; i += 1) await seedRun(`w-hit-${i}`, "t-win", `2026-10-0${i}T00:00:00.000Z`, { planId: hit });
        for (let i = 4; i <= 8; i += 1) await seedRun(`w-miss-${i}`, "t-win", `2026-10-0${i}T00:00:00.000Z`, { planId: miss });

        const first = (await queryRunsByAnalysis(pool, "t-win", { q: "volcano", limit: 2, offset: 0 }))._unsafeUnwrap();
        const second = (await queryRunsByAnalysis(pool, "t-win", { q: "volcano", limit: 2, offset: 2 }))._unsafeUnwrap();

        expect(ids(first)).toEqual(["w-hit-3", "w-hit-2"]);
        expect(ids(second)).toEqual(["w-hit-1"]);
        expect((await countRunsByAnalysis(pool, "t-win", { q: "volcano" }))._unsafeUnwrap()).toBe(3);
    });

    it("matches a wildcard character only as itself", async () => {
        const underscore = await seedPlan("t-wild", { title: "a_b" });
        const other = await seedPlan("t-wild", { title: "axb" });
        const percent = await seedPlan("t-wild", { title: "100% done" });
        await seedRun("wild-1", "t-wild", "2026-10-01T00:00:00.000Z", { planId: underscore });
        await seedRun("wild-2", "t-wild", "2026-10-02T00:00:00.000Z", { planId: other });
        await seedRun("wild-3", "t-wild", "2026-10-03T00:00:00.000Z", { planId: percent });

        expect(ids((await queryRunsByAnalysis(pool, "t-wild", { q: "a_b" }))._unsafeUnwrap())).toEqual(["wild-1"]);
        expect(ids((await queryRunsByAnalysis(pool, "t-wild", { q: "%" }))._unsafeUnwrap())).toEqual(["wild-3"]);
        expect((await countRunsByAnalysis(pool, "t-wild", { q: "a_b" }))._unsafeUnwrap()).toBe(1);
    });

    it("gives no title to a plan of a different analysis", async () => {
        const foreign = await seedPlan("t-scope-other", { title: "volcano" });
        await seedRun("scope-1", "t-scope", "2026-10-01T00:00:00.000Z", { planId: foreign });

        expect(ids((await queryRunsByAnalysis(pool, "t-scope", { q: "volcano" }))._unsafeUnwrap())).toEqual([]);
        expect((await countRunsByAnalysis(pool, "t-scope", { q: "volcano" }))._unsafeUnwrap()).toBe(0);
    });

    it("combines the text with the thread and with the active set", async () => {
        // The active-plan index admits one running run for each plan, thus each running run gets its own plan.
        const planOf = (title: string): Promise<string> => seedPlan("t-comb", { title });
        await seedRun("c-1", "t-comb", "2026-10-01T00:00:00.000Z", { planId: await planOf("Volcano"), threadId: "t1", status: "running" });
        await seedRun("c-2", "t-comb", "2026-10-02T00:00:00.000Z", { planId: await planOf("Volcano"), threadId: "t1", status: "completed" });
        await seedRun("c-3", "t-comb", "2026-10-03T00:00:00.000Z", { planId: await planOf("Volcano"), threadId: "t2", status: "running" });
        await seedRun("c-4", "t-comb", "2026-10-04T00:00:00.000Z", { planId: await planOf("Heatmap"), threadId: "t1", status: "running" });

        const thread = (await queryRunsByThread(pool, "t-comb", "t1", { q: "volcano" }))._unsafeUnwrap();
        const active = (await queryActiveRunsByAnalysis(pool, "t-comb", { q: "volcano" }))._unsafeUnwrap();

        expect(ids(thread)).toEqual(["c-2", "c-1"]);
        expect(ids(active)).toEqual(["c-3", "c-1"]);
    });

    it("selects each run without a text, and sends one statement for the count", async () => {
        for (let i = 1; i <= 4; i += 1) await seedRun(`k-${i}`, "t-count", `2026-10-0${i}T00:00:00.000Z`);
        const counted = countingQuerier(pool);

        const total = (await countRunsByAnalysis(counted.querier, "t-count"))._unsafeUnwrap();
        const filtered = (await countRunsByAnalysis(counted.querier, "t-count", { q: "k-" }))._unsafeUnwrap();

        expect(total).toBe(4);
        expect(filtered).toBe(4);
        expect(counted.calls()).toBe(2);
        expect(ids((await queryRunsByAnalysis(pool, "t-count"))._unsafeUnwrap())).toEqual(["k-4", "k-3", "k-2", "k-1"]);
    });
});

describe("a driver failure of the run count", () => {
    // The read under test calls only `query`, thus an object with a rejecting `query` stands for the whole interface.
    const rejecting = {
        query: () => Promise.reject(new Error("connection lost")),
    } as unknown as Parameters<typeof countRunsByAnalysis>[0];

    it("rides the error channel of countRunsByAnalysis, with the op", async () => {
        const error = (await countRunsByAnalysis(rejecting, "a1", { q: "x" })).match(
            () => null,
            (failure) => failure,
        );

        expect(error).toMatchObject({ type: "query_failed", op: "runs.countRunsByAnalysis" });
    });
});
