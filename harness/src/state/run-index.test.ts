import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { loadRunIndex } from "./run-index.js";

const ANALYSIS = "analysis-runs";

async function seedAnalysis(pool: Pool, analysisId = ANALYSIS): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state (analysis_id, status, created_at, updated_at)
               VALUES ($1, 'active', $2, $2)`,
        values: [analysisId, now],
    });
}

async function seedPlan(pool: Pool, planId: string, plan: unknown, analysisId = ANALYSIS): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_plans (plan_id, analysis_id, plan, created_at)
               VALUES ($1, $2, $3::jsonb, $4)`,
        values: [planId, analysisId, JSON.stringify(plan), "2026-07-01T00:00:00.000Z"],
    });
}

interface SeedRun {
    runId: string;
    status: string;
    startedAt: string;
    completedAt?: string | null;
    workflowName?: string;
    planId?: string | null;
}

async function seedRun(pool: Pool, run: SeedRun, analysisId = ANALYSIS): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, completed_at, plan_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        values: [run.runId, analysisId, run.workflowName ?? "executeAnalysis", run.status, run.startedAt, run.completedAt ?? null, run.planId ?? null],
    });
}

async function seedStep(pool: Pool, runId: string, stepId: string, status: string, analysisId = ANALYSIS): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_step_executions (run_id, step_id, analysis_id, wave, agent_id, status, started_at)
               VALUES ($1, $2, $3, 0, 'some-agent', $4, '2026-07-01T00:00:00.000Z')`,
        values: [runId, stepId, analysisId, status],
    });
}

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("run-index"));
    await seedAnalysis(pool);
});

afterEach(async () => {
    await drop();
});

describe("loadRunIndex", () => {
    it("returns an empty input for an analysis with no runs", async () => {
        const index = await loadRunIndex(pool, ANALYSIS);
        expect(index.entries).toHaveLength(0);
        expect(index.olderCount).toBe(0);
    });

    it("excludes in-flight (running / suspended) runs", async () => {
        await seedRun(pool, { runId: "run-done", status: "completed", startedAt: "2026-07-05T10:00:00.000Z", completedAt: "2026-07-05T11:00:00.000Z" });
        await seedRun(pool, { runId: "run-live", status: "running", startedAt: "2026-07-06T10:00:00.000Z" });
        await seedRun(pool, { runId: "run-susp", status: "suspended_insufficient_funds", startedAt: "2026-07-07T10:00:00.000Z" });

        const index = await loadRunIndex(pool, ANALYSIS);
        expect(index.entries.map((e) => e.runId)).toEqual(["run-done"]);
    });

    it("orders terminal runs newest first and aggregates step outcomes with failed names", async () => {
        await seedRun(pool, { runId: "run-old", status: "completed", startedAt: "2026-07-01T10:00:00.000Z", completedAt: "2026-07-01T11:00:00.000Z" });
        await seedRun(pool, { runId: "run-new", status: "partial", startedAt: "2026-07-09T10:00:00.000Z", completedAt: "2026-07-09T12:00:00.000Z" });

        for (const s of ["s1", "s2", "s3"]) await seedStep(pool, "run-new", s, "completed");
        await seedStep(pool, "run-new", "s4", "failed");
        await seedStep(pool, "run-old", "s1", "completed");

        const index = await loadRunIndex(pool, ANALYSIS);
        expect(index.entries.map((e) => e.runId)).toEqual(["run-new", "run-old"]);

        const newEntry = index.entries[0]!;
        expect(newEntry.status).toBe("partial");
        expect(newEntry.steps).toEqual({ completed: 3, total: 4, failedStepNames: ["s4"] });
        expect(newEntry.completedAt).toBe("2026-07-09T12:00:00.000Z");
    });

    it("caps at 10 indexed runs and counts the older terminal overflow", async () => {
        for (let i = 0; i < 13; i++) {
            const dd = String(i + 1).padStart(2, "0");
            await seedRun(pool, {
                runId: `run-${dd}`,
                status: "completed",
                startedAt: `2026-07-${dd}T10:00:00.000Z`,
                completedAt: `2026-07-${dd}T11:00:00.000Z`,
            });
        }

        const index = await loadRunIndex(pool, ANALYSIS);
        expect(index.entries).toHaveLength(10);
        expect(index.olderCount).toBe(3);
        // Newest first: run-13 .. run-04 are indexed.
        expect(index.entries[0]!.runId).toBe("run-13");
        expect(index.entries.at(-1)!.runId).toBe("run-04");
    });

    it("uses the plan title as the run's title facet", async () => {
        await seedPlan(pool, "pln-0000aaaa", {
            title: "AD lesional vs control",
            analytical_narrative: "n",
            created_at: "2026-07-01T00:00:00.000Z",
            steps: [],
        });
        await seedRun(pool, {
            runId: "run-planned",
            status: "completed",
            startedAt: "2026-07-05T10:00:00.000Z",
            completedAt: "2026-07-05T11:00:00.000Z",
            planId: "pln-0000aaaa",
        });

        const index = await loadRunIndex(pool, ANALYSIS);
        expect(index.entries[0]!.title).toBe("AD lesional vs control");
    });

    it("degrades a plan-less run_ephemeral to its workflow name and no steps", async () => {
        await seedRun(pool, {
            runId: "run-ephem",
            status: "completed",
            startedAt: "2026-07-05T10:00:00.000Z",
            completedAt: "2026-07-05T11:00:00.000Z",
            workflowName: "runEphemeral",
            planId: null,
        });

        const index = await loadRunIndex(pool, ANALYSIS);
        expect(index.entries[0]!.title).toBe("runEphemeral");
        expect(index.entries[0]!.steps).toEqual({ completed: 0, total: 0, failedStepNames: [] });
    });
});
