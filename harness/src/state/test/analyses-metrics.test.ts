import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { countingQuerier } from "../../__tests__/setup/counting-querier.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { queryDataProfileStatusByAnalyses, queryLatestRunsByAnalyses, queryRunProgressByRuns, queryRunsEndedSince } from "../analyses-metrics.js";

async function seedAnalysis(pool: Pool, analysisId: string, dataProfileStatus: string | null = "pending"): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state (analysis_id, status, data_profile_status, created_at, updated_at)
               VALUES ($1, 'active', $2, $3, $3)`,
        values: [analysisId, dataProfileStatus, now],
    });
}

async function seedPlan(pool: Pool, planId: string, analysisId: string, plan: unknown): Promise<void> {
    await pool.query({
        text: "INSERT INTO cortex_plans (plan_id, analysis_id, plan, created_at) VALUES ($1, $2, $3::jsonb, $4)",
        values: [planId, analysisId, JSON.stringify(plan), new Date().toISOString()],
    });
}

async function seedRun(
    pool: Pool,
    run: {
        runId: string;
        analysisId: string;
        startedAt: string;
        status?: string;
        planId?: string | null;
        completedAt?: string | null;
        threadId?: string | null;
    },
): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, completed_at, plan_id, thread_id)
               VALUES ($1, $2, 'executeAnalysis', $3, $4, $5, $6, $7)`,
        values: [run.runId, run.analysisId, run.status ?? "running", run.startedAt, run.completedAt ?? null, run.planId ?? null, run.threadId ?? null],
    });
}

async function seedSteps(pool: Pool, runId: string, analysisId: string, statuses: readonly string[]): Promise<void> {
    for (const [index, status] of statuses.entries()) {
        await pool.query({
            text: `INSERT INTO cortex_step_executions (run_id, step_id, analysis_id, wave, agent_id, status)
                   VALUES ($1, $2, $3, 0, 'agent', $4)`,
            values: [runId, `s${index}`, analysisId, status],
        });
    }
}

describe("the indexes on the runs", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("runs_start_index"));
    });
    afterAll(async () => {
        await drop();
    });

    it("exists after the migrations, over the analysis, the start time, and the run id", async () => {
        const { rows } = await pool.query<{ indexdef: string }>(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_cortex_runs_analysis_started'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.indexdef).toContain("(analysis_id, started_at DESC, run_id DESC)");
    });

    it("has an index on the completion time and the run id after the migrations", async () => {
        const { rows } = await pool.query<{ indexdef: string }>(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_cortex_runs_completed'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.indexdef).toContain("(completed_at DESC, run_id DESC)");
    });
});

describe("queryLatestRunsByAnalyses", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("latest_runs_by_analyses"));
    });
    afterAll(async () => {
        await drop();
    });

    it("gives the newest run of each analysis, and no entry for an analysis with no run", async () => {
        await seedAnalysis(pool, "newest-a1");
        await seedAnalysis(pool, "newest-a2");
        await seedRun(pool, { runId: "newest-r1", analysisId: "newest-a1", startedAt: "2026-10-01T10:00:00.000Z", status: "completed" });
        await seedRun(pool, { runId: "newest-r2", analysisId: "newest-a1", startedAt: "2026-10-02T10:00:00.000Z", completedAt: "2026-10-02T11:00:00.000Z" });

        const entries = (await queryLatestRunsByAnalyses(pool, ["newest-a1", "newest-a2"]))._unsafeUnwrap();

        expect(entries).toEqual([
            {
                analysisId: "newest-a1",
                runId: "newest-r2",
                status: "running",
                planTitle: null,
                doneSteps: 0,
                totalSteps: 0,
                startedAt: "2026-10-02T10:00:00.000Z",
                completedAt: "2026-10-02T11:00:00.000Z",
            },
        ]);
    });

    it("breaks a tie of the start time with the run id, descending", async () => {
        await seedAnalysis(pool, "tie-a");
        await seedRun(pool, { runId: "tie-r1", analysisId: "tie-a", startedAt: "2026-10-03T10:00:00.000Z" });
        await seedRun(pool, { runId: "tie-r2", analysisId: "tie-a", startedAt: "2026-10-03T10:00:00.000Z" });

        const entries = (await queryLatestRunsByAnalyses(pool, ["tie-a"]))._unsafeUnwrap();

        expect(entries.map((entry) => entry.runId)).toEqual(["tie-r2"]);
    });

    it("counts the step rows of the newest run only, the synthesis row included", async () => {
        await seedAnalysis(pool, "steps-a");
        await seedRun(pool, { runId: "steps-old", analysisId: "steps-a", startedAt: "2026-10-01T10:00:00.000Z", status: "completed" });
        await seedSteps(pool, "steps-old", "steps-a", ["completed", "completed", "completed"]);
        await seedRun(pool, { runId: "steps-new", analysisId: "steps-a", startedAt: "2026-10-02T10:00:00.000Z" });
        await seedSteps(pool, "steps-new", "steps-a", ["completed", "completed", "running", "pending", "pending"]);

        const [entry] = (await queryLatestRunsByAnalyses(pool, ["steps-a"]))._unsafeUnwrap();

        expect(entry?.runId).toBe("steps-new");
        expect(entry?.totalSteps).toBe(5);
        expect(entry?.doneSteps).toBe(2);
    });

    it("gives the trimmed title of the plan of the run", async () => {
        await seedAnalysis(pool, "title-a");
        await seedPlan(pool, "pln-title001", "title-a", { title: "  Differential expression  ", steps: [] });
        await seedRun(pool, { runId: "title-r", analysisId: "title-a", startedAt: "2026-10-01T10:00:00.000Z", planId: "pln-title001" });

        const [entry] = (await queryLatestRunsByAnalyses(pool, ["title-a"]))._unsafeUnwrap();

        expect(entry?.planTitle).toBe("Differential expression");
    });

    it("trims with the rule of JavaScript trim(): a no-break space edges a title, or is the whole title", async () => {
        await seedAnalysis(pool, "nbsp-edged");
        await seedAnalysis(pool, "nbsp-only");
        await seedPlan(pool, "plan-nbsp-edged", "nbsp-edged", { title: "\u00a0Survival model\u00a0" });
        await seedPlan(pool, "plan-nbsp-only", "nbsp-only", { title: "\u00a0" });
        await seedRun(pool, { runId: "nbsp-edged-r", analysisId: "nbsp-edged", startedAt: "2026-10-01T10:00:00.000Z", planId: "plan-nbsp-edged" });
        await seedRun(pool, { runId: "nbsp-only-r", analysisId: "nbsp-only", startedAt: "2026-10-01T10:00:00.000Z", planId: "plan-nbsp-only" });

        const entries = (await queryLatestRunsByAnalyses(pool, ["nbsp-edged", "nbsp-only"]))._unsafeUnwrap();

        const titleOf = (id: string) => entries.find((entry) => entry.analysisId === id)?.planTitle;
        expect(titleOf("nbsp-edged")).toBe("Survival model");
        expect(titleOf("nbsp-only")).toBeNull();
    });

    it("gives a null title for a plan of a different analysis", async () => {
        await seedAnalysis(pool, "scope-a");
        await seedAnalysis(pool, "scope-other");
        await seedPlan(pool, "pln-scope0001", "scope-other", { title: "Not mine" });
        await seedRun(pool, { runId: "scope-r", analysisId: "scope-a", startedAt: "2026-10-01T10:00:00.000Z", planId: "pln-scope0001" });

        const [entry] = (await queryLatestRunsByAnalyses(pool, ["scope-a"]))._unsafeUnwrap();

        expect(entry?.runId).toBe("scope-r");
        expect(entry?.planTitle).toBeNull();
    });

    it("gives a null title for a blank title, a title that is not a string, a missing title, and a run with no plan", async () => {
        const plans = [
            { name: "blank", plan: { title: "   " } },
            { name: "number", plan: { title: 7 } },
            { name: "missing", plan: { steps: [] } },
        ];
        for (const { name, plan } of plans) {
            await seedAnalysis(pool, `null-${name}`);
            await seedPlan(pool, `plan-null-${name}`, `null-${name}`, plan);
            await seedRun(pool, { runId: `null-${name}-r`, analysisId: `null-${name}`, startedAt: "2026-10-01T10:00:00.000Z", planId: `plan-null-${name}` });
        }
        await seedAnalysis(pool, "null-noplan");
        await seedRun(pool, { runId: "null-noplan-r", analysisId: "null-noplan", startedAt: "2026-10-01T10:00:00.000Z" });

        const entries = (await queryLatestRunsByAnalyses(pool, ["null-blank", "null-number", "null-missing", "null-noplan"]))._unsafeUnwrap();

        expect(entries).toHaveLength(4);
        expect(entries.map((entry) => entry.planTitle)).toEqual([null, null, null, null]);
    });

    it("sends one query for a long list, and none for an empty list", async () => {
        const ids = Array.from({ length: 20 }, (_, index) => `many-${index}`);
        for (const id of ids) {
            await seedAnalysis(pool, id);
            await seedRun(pool, { runId: `${id}-r`, analysisId: id, startedAt: "2026-10-01T10:00:00.000Z" });
        }
        const counted = countingQuerier(pool);

        const entries = (await queryLatestRunsByAnalyses(counted.querier, ids))._unsafeUnwrap();
        expect(entries).toHaveLength(20);
        expect(counted.calls()).toBe(1);

        expect((await queryLatestRunsByAnalyses(counted.querier, []))._unsafeUnwrap()).toEqual([]);
        expect(counted.calls()).toBe(1);
    });
});

describe("queryRunProgressByRuns", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("run_progress_by_runs"));
    });
    afterAll(async () => {
        await drop();
    });

    it("gives an entry for each named run, with its thread, and none for an unknown id", async () => {
        await seedAnalysis(pool, "named-a1");
        await seedAnalysis(pool, "named-a2");
        await seedPlan(pool, "pln-named001", "named-a1", { title: " Pathway scan " });
        await seedRun(pool, {
            runId: "named-r1",
            analysisId: "named-a1",
            startedAt: "2026-10-01T10:00:00.000Z",
            planId: "pln-named001",
            threadId: "named-t1",
        });
        await seedRun(pool, {
            runId: "named-r2",
            analysisId: "named-a2",
            startedAt: "2026-10-02T10:00:00.000Z",
            status: "failed",
            completedAt: "2026-10-02T11:00:00.000Z",
        });

        const entries = (await queryRunProgressByRuns(pool, ["named-r1", "named-r2", "named-gone"]))._unsafeUnwrap();

        expect(entries).toEqual([
            {
                analysisId: "named-a2",
                runId: "named-r2",
                status: "failed",
                planTitle: null,
                doneSteps: 0,
                totalSteps: 0,
                startedAt: "2026-10-02T10:00:00.000Z",
                completedAt: "2026-10-02T11:00:00.000Z",
                threadId: null,
            },
            {
                analysisId: "named-a1",
                runId: "named-r1",
                status: "running",
                planTitle: "Pathway scan",
                doneSteps: 0,
                totalSteps: 0,
                startedAt: "2026-10-01T10:00:00.000Z",
                completedAt: null,
                threadId: "named-t1",
            },
        ]);
    });

    it("counts the step rows of each named run only", async () => {
        await seedAnalysis(pool, "count-a");
        await seedRun(pool, { runId: "count-r1", analysisId: "count-a", startedAt: "2026-10-01T10:00:00.000Z" });
        await seedSteps(pool, "count-r1", "count-a", ["completed", "completed", "running", "pending"]);
        await seedRun(pool, { runId: "count-r2", analysisId: "count-a", startedAt: "2026-10-02T10:00:00.000Z" });
        await seedSteps(pool, "count-r2", "count-a", ["completed", "failed"]);
        await seedRun(pool, { runId: "count-other", analysisId: "count-a", startedAt: "2026-10-03T10:00:00.000Z" });
        await seedSteps(pool, "count-other", "count-a", ["completed", "completed", "completed"]);

        const entries = (await queryRunProgressByRuns(pool, ["count-r1", "count-r2"]))._unsafeUnwrap();

        expect(entries.map((entry) => [entry.runId, entry.doneSteps, entry.totalSteps])).toEqual([
            ["count-r2", 1, 2],
            ["count-r1", 2, 4],
        ]);
    });

    it("gives a null title for a plan of a different analysis", async () => {
        await seedAnalysis(pool, "scope-a");
        await seedAnalysis(pool, "scope-other");
        await seedPlan(pool, "pln-pscope001", "scope-other", { title: "Not mine" });
        await seedRun(pool, { runId: "pscope-r", analysisId: "scope-a", startedAt: "2026-10-01T10:00:00.000Z", planId: "pln-pscope001" });

        const [entry] = (await queryRunProgressByRuns(pool, ["pscope-r"]))._unsafeUnwrap();

        expect(entry?.runId).toBe("pscope-r");
        expect(entry?.planTitle).toBeNull();
    });

    it("orders the entries newest start first, and breaks a tie with the run id, descending", async () => {
        await seedAnalysis(pool, "order-a");
        await seedRun(pool, { runId: "order-r1", analysisId: "order-a", startedAt: "2026-10-01T10:00:00.000Z" });
        await seedRun(pool, { runId: "order-r2", analysisId: "order-a", startedAt: "2026-10-03T10:00:00.000Z" });
        await seedRun(pool, { runId: "order-r3", analysisId: "order-a", startedAt: "2026-10-03T10:00:00.000Z" });

        const entries = (await queryRunProgressByRuns(pool, ["order-r1", "order-r2", "order-r3"]))._unsafeUnwrap();

        expect(entries.map((entry) => entry.runId)).toEqual(["order-r3", "order-r2", "order-r1"]);
    });

    it("sends one query for a long list, and none for an empty list", async () => {
        const ids = Array.from({ length: 20 }, (_, index) => `pmany-${index}`);
        await seedAnalysis(pool, "pmany-a");
        for (const id of ids) await seedRun(pool, { runId: id, analysisId: "pmany-a", startedAt: "2026-10-01T10:00:00.000Z" });
        const counted = countingQuerier(pool);

        const entries = (await queryRunProgressByRuns(counted.querier, ids))._unsafeUnwrap();
        expect(entries).toHaveLength(20);
        expect(counted.calls()).toBe(1);

        expect((await queryRunProgressByRuns(counted.querier, []))._unsafeUnwrap()).toEqual([]);
        expect(counted.calls()).toBe(1);
    });
});

describe("queryRunsEndedSince", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("runs_ended_since"));
    });
    afterAll(async () => {
        await drop();
    });

    const since = "2026-10-05T00:00:00.000Z";

    it("gives the terminal runs that ended at or after the time, newest completion first, and no run that ended before it", async () => {
        await seedAnalysis(pool, "since-a1");
        await seedAnalysis(pool, "since-a2");
        await seedRun(pool, {
            runId: "since-old",
            analysisId: "since-a1",
            startedAt: "2026-10-04T10:00:00.000Z",
            status: "completed",
            completedAt: "2026-10-04T11:00:00.000Z",
        });
        await seedRun(pool, { runId: "since-edge", analysisId: "since-a1", startedAt: "2026-10-04T23:00:00.000Z", status: "completed", completedAt: since });
        await seedRun(pool, {
            runId: "since-new",
            analysisId: "since-a2",
            startedAt: "2026-10-05T01:00:00.000Z",
            status: "failed",
            completedAt: "2026-10-05T02:00:00.000Z",
        });

        const entries = (await queryRunsEndedSince(pool, { since, limit: 10 }))._unsafeUnwrap();

        expect(entries).toEqual([
            { analysisId: "since-a2", runId: "since-new", status: "failed", completedAt: "2026-10-05T02:00:00.000Z" },
            { analysisId: "since-a1", runId: "since-edge", status: "completed", completedAt: since },
        ]);
    });

    it("gives each terminal status, and no run that still runs", async () => {
        await seedAnalysis(pool, "status-a");
        const statuses = ["completed", "partial", "failed", "canceled", "running", "suspended_insufficient_funds"];
        for (const [index, status] of statuses.entries()) {
            await seedRun(pool, {
                runId: `status-${status}`,
                analysisId: "status-a",
                startedAt: "2026-10-06T00:00:00.000Z",
                status,
                completedAt: `2026-10-06T0${index}:00:00.000Z`,
            });
        }

        const entries = (await queryRunsEndedSince(pool, { since: "2026-10-06T00:00:00.000Z", limit: 10 }))._unsafeUnwrap();

        expect(entries.map((entry) => entry.status)).toEqual(["suspended_insufficient_funds", "canceled", "failed", "partial", "completed"]);
    });

    it("bounds the result with the limit, and breaks a tie of the completion time with the run id, descending", async () => {
        await seedAnalysis(pool, "limit-a");
        for (const id of ["limit-r1", "limit-r2", "limit-r3", "limit-r4", "limit-r5"]) {
            await seedRun(pool, {
                runId: id,
                analysisId: "limit-a",
                startedAt: "2026-10-08T00:00:00.000Z",
                status: "completed",
                completedAt: "2026-10-08T01:00:00.000Z",
            });
        }

        const entries = (await queryRunsEndedSince(pool, { since: "2026-10-08T00:00:00.000Z", limit: 2 }))._unsafeUnwrap();

        expect(entries.map((entry) => entry.runId)).toEqual(["limit-r5", "limit-r4"]);
    });

    it("sends one query", async () => {
        const counted = countingQuerier(pool);

        (await queryRunsEndedSince(counted.querier, { since, limit: 5 }))._unsafeUnwrap();
        expect(counted.calls()).toBe(1);
    });
});

describe("queryDataProfileStatusByAnalyses", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("profile_status_by_analyses"));
    });
    afterAll(async () => {
        await drop();
    });

    it("gives the status, the completion time, and the file count of a completed profile with a partition", async () => {
        await seedAnalysis(pool, "done-a", "completed");
        await pool.query({
            text: `UPDATE cortex_analysis_state
                   SET data_profile_completed_at = $1, data_profile_result = $2::jsonb
                   WHERE analysis_id = 'done-a'`,
            values: ["2026-10-05T10:00:00.000Z", JSON.stringify({ summary: "x", partition: { keptFiles: 12 } })],
        });

        const entries = (await queryDataProfileStatusByAnalyses(pool, ["done-a"]))._unsafeUnwrap();

        expect(entries).toEqual([{ analysisId: "done-a", status: "completed", completedAt: "2026-10-05T10:00:00.000Z", profiledFiles: 12 }]);
    });

    it("falls back to the coverage total and to the summed kind counts, as the profile view does", async () => {
        await seedAnalysis(pool, "cov-a", "completed");
        await seedAnalysis(pool, "kinds-a", "completed");
        await pool.query({
            text: "UPDATE cortex_analysis_state SET data_profile_result = $1::jsonb WHERE analysis_id = 'cov-a'",
            values: [JSON.stringify({ coverage: { total: 9 } })],
        });
        await pool.query({
            text: "UPDATE cortex_analysis_state SET data_profile_result = $1::jsonb WHERE analysis_id = 'kinds-a'",
            values: [JSON.stringify({ kinds: [{ count: 3 }, { count: 4 }] })],
        });

        const entries = (await queryDataProfileStatusByAnalyses(pool, ["cov-a", "kinds-a"]))._unsafeUnwrap();

        const countOf = (id: string) => entries.find((entry) => entry.analysisId === id)?.profiledFiles;
        expect(countOf("cov-a")).toBe(9);
        expect(countOf("kinds-a")).toBe(7);
    });

    it("gives a null count for a running profile with no result", async () => {
        await seedAnalysis(pool, "run-a", "running");

        const entries = (await queryDataProfileStatusByAnalyses(pool, ["run-a"]))._unsafeUnwrap();

        expect(entries).toEqual([{ analysisId: "run-a", status: "running", completedAt: null, profiledFiles: null }]);
    });

    it("gives no entry for a cleared row, and none for an analysis with no row", async () => {
        await seedAnalysis(pool, "cleared-a", null);

        const entries = (await queryDataProfileStatusByAnalyses(pool, ["cleared-a", "absent-a"]))._unsafeUnwrap();

        expect(entries).toEqual([]);
    });

    it("sends one query for a long list, and none for an empty list", async () => {
        const ids = Array.from({ length: 20 }, (_, index) => `many-${index}`);
        for (const id of ids) await seedAnalysis(pool, id);
        const counted = countingQuerier(pool);

        const entries = (await queryDataProfileStatusByAnalyses(counted.querier, ids))._unsafeUnwrap();
        expect(entries).toHaveLength(20);
        expect(counted.calls()).toBe(1);

        expect((await queryDataProfileStatusByAnalyses(counted.querier, []))._unsafeUnwrap()).toEqual([]);
        expect(counted.calls()).toBe(1);
    });
});
