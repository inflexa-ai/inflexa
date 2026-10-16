import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { countingQuerier } from "../../__tests__/setup/counting-querier.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../analyses.js";
import { loadPlan, loadPlanRecord, upsertPlan } from "../plans.js";
import { errorMessage } from "../../lib/thrown.js";

async function countPlans(pool: Pool, planId: string): Promise<number> {
    const r = await pool.query<{ n: number }>({
        text: "SELECT count(*)::int AS n FROM cortex_plans WHERE plan_id = $1",
        values: [planId],
    });
    return r.rows[0].n;
}

describe("upsertPlan", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("plans_upsert");
        pool = ctx.pool;
        drop = ctx.drop;
        // cortex_plans.analysis_id has an FK to cortex_analysis_state — seed both
        // analyses the parent-scope cases reference.
        (await upsertAnalysis(pool, "analysis-1", null))._unsafeUnwrap();
        (await upsertAnalysis(pool, "analysis-2", null))._unsafeUnwrap();
    });

    afterAll(async () => {
        await drop();
    });

    it("persists a fresh plan that loadPlan round-trips", async () => {
        const plan = { title: "t", steps: [{ id: "s1" }] };
        (await upsertPlan(pool, { planId: "pln-00000001", analysisId: "analysis-1", plan }))._unsafeUnwrap();

        const loaded = (await loadPlan(pool, "pln-00000001", { analysisId: "analysis-1" }))._unsafeUnwrap();
        expect(loaded).toEqual(plan);
    });

    it("re-upserting the same id is a no-op success — one row survives, first payload kept", async () => {
        const first = { v: 1 };
        const second = { v: 2 };
        (await upsertPlan(pool, { planId: "pln-0000000a", analysisId: "analysis-1", plan: first }))._unsafeUnwrap();
        (await upsertPlan(pool, { planId: "pln-0000000a", analysisId: "analysis-1", plan: second }))._unsafeUnwrap();

        expect(await countPlans(pool, "pln-0000000a")).toBe(1);
        // ON CONFLICT DO NOTHING leaves the original row untouched.
        const loaded = (await loadPlan(pool, "pln-0000000a", { analysisId: "analysis-1" }))._unsafeUnwrap();
        expect(loaded).toEqual(first);
    });

    it("rejects an id that is not the pln-<8hex> shape before any write", () => {
        expect(() => upsertPlan(pool, { planId: "not-a-plan-id", analysisId: "analysis-1", plan: {} })).toThrow("pln-<8hex>");
    });

    it("enforces the parent-scope check when the parent belongs to another analysis", async () => {
        (await upsertPlan(pool, { planId: "pln-000000b0", analysisId: "analysis-1", plan: {} }))._unsafeUnwrap();

        let message = "";
        try {
            (
                await upsertPlan(pool, {
                    planId: "pln-000000b1",
                    analysisId: "analysis-2",
                    plan: {},
                    parentPlanId: "pln-000000b0",
                })
            )._unsafeUnwrap();
        } catch (err) {
            message = errorMessage(err);
        }
        expect(message).toContain("different analysis");
        // The child row was never written — the throw short-circuits before INSERT.
        expect(await countPlans(pool, "pln-000000b1")).toBe(0);
    });

    it("accepts a parent in the same analysis", async () => {
        (await upsertPlan(pool, { planId: "pln-000000c0", analysisId: "analysis-1", plan: {} }))._unsafeUnwrap();
        (
            await upsertPlan(pool, {
                planId: "pln-000000c1",
                analysisId: "analysis-1",
                plan: {},
                parentPlanId: "pln-000000c0",
            })
        )._unsafeUnwrap();
        expect(await countPlans(pool, "pln-000000c1")).toBe(1);
    });
});

async function seedPlan(pool: Pool, row: { planId: string; analysisId: string; parentPlanId?: string; createdAt: string; plan?: unknown }): Promise<void> {
    await pool.query({
        text: "INSERT INTO cortex_plans (plan_id, analysis_id, plan, parent_plan_id, created_at) VALUES ($1, $2, $3, $4, $5)",
        values: [row.planId, row.analysisId, JSON.stringify(row.plan ?? { steps: [] }), row.parentPlanId ?? null, row.createdAt],
    });
}

describe("loadPlanRecord", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("plans_record"));
        (await upsertAnalysis(pool, "a1", null))._unsafeUnwrap();
        (await upsertAnalysis(pool, "a2", null))._unsafeUnwrap();
    });

    afterAll(async () => {
        await drop();
    });

    it("names the newer plan on a revised plan, and the parent on the revision", async () => {
        const plan = { title: "first", steps: [{ id: "s1" }] };
        await seedPlan(pool, { planId: "pln-0000000a", analysisId: "a1", createdAt: "2026-10-01T00:00:00.000Z", plan });
        await seedPlan(pool, { planId: "pln-0000000b", analysisId: "a1", parentPlanId: "pln-0000000a", createdAt: "2026-10-02T00:00:00.000Z" });

        const first = (await loadPlanRecord(pool, "pln-0000000a", { analysisId: "a1" }))._unsafeUnwrap();
        expect(first).toEqual({
            planId: "pln-0000000a",
            plan,
            parentPlanId: null,
            supersededBy: "pln-0000000b",
            createdAt: "2026-10-01T00:00:00.000Z",
        });

        const revision = (await loadPlanRecord(pool, "pln-0000000b", { analysisId: "a1" }))._unsafeUnwrap();
        expect(revision?.parentPlanId).toBe("pln-0000000a");
        expect(revision?.supersededBy).toBeNull();
    });

    it("names the revision with the later creation time when two plans name the parent", async () => {
        await seedPlan(pool, { planId: "pln-000000c0", analysisId: "a1", createdAt: "2026-10-01T00:00:00.000Z" });
        await seedPlan(pool, { planId: "pln-000000c2", analysisId: "a1", parentPlanId: "pln-000000c0", createdAt: "2026-10-03T00:00:00.000Z" });
        await seedPlan(pool, { planId: "pln-000000c1", analysisId: "a1", parentPlanId: "pln-000000c0", createdAt: "2026-10-02T00:00:00.000Z" });

        const record = (await loadPlanRecord(pool, "pln-000000c0", { analysisId: "a1" }))._unsafeUnwrap();
        expect(record?.supersededBy).toBe("pln-000000c2");
    });

    it("breaks a tie of creation times with the highest plan id", async () => {
        const at = "2026-10-04T00:00:00.000Z";
        await seedPlan(pool, { planId: "pln-000000d0", analysisId: "a1", createdAt: "2026-10-01T00:00:00.000Z" });
        await seedPlan(pool, { planId: "pln-000000d1", analysisId: "a1", parentPlanId: "pln-000000d0", createdAt: at });
        await seedPlan(pool, { planId: "pln-000000d2", analysisId: "a1", parentPlanId: "pln-000000d0", createdAt: at });

        const record = (await loadPlanRecord(pool, "pln-000000d0", { analysisId: "a1" }))._unsafeUnwrap();
        expect(record?.supersededBy).toBe("pln-000000d2");
    });

    it("gives null for an unknown plan and for a plan of a different analysis", async () => {
        await seedPlan(pool, { planId: "pln-000000e0", analysisId: "a2", createdAt: "2026-10-01T00:00:00.000Z" });

        expect((await loadPlanRecord(pool, "pln-000000e0", { analysisId: "a1" }))._unsafeUnwrap()).toBeNull();
        expect((await loadPlanRecord(pool, "pln-ffffffff", { analysisId: "a1" }))._unsafeUnwrap()).toBeNull();
    });

    it("sends one statement for a found plan and for an absent plan", async () => {
        const found = countingQuerier(pool);
        (await loadPlanRecord(found.querier, "pln-0000000a", { analysisId: "a1" }))._unsafeUnwrap();
        expect(found.calls()).toBe(1);

        const absent = countingQuerier(pool);
        (await loadPlanRecord(absent.querier, "pln-ffffffff", { analysisId: "a1" }))._unsafeUnwrap();
        expect(absent.calls()).toBe(1);
    });
});

describe("the plan and run indexes", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("plans_indexes"));
    });

    afterAll(async () => {
        await drop();
    });

    async function indexDefinition(name: string): Promise<string | undefined> {
        const { rows } = await pool.query<{ indexdef: string }>({
            text: "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
            values: [name],
        });
        return rows[0]?.indexdef;
    }

    it("indexes the plans by their parent", async () => {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion reads the engine's index DDL, whose grammar (qualified table, method, column list) no builtin parses
        expect(await indexDefinition("idx_cortex_plans_parent")).toMatch(/ON \S*cortex_plans USING btree \(parent_plan_id\)$/);
    });

    it("indexes the runs by analysis, plan, start time, and run id", async () => {
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion reads the engine's index DDL, whose grammar (qualified table, method, column list) no builtin parses
        expect(await indexDefinition("idx_cortex_runs_plan")).toMatch(/ON \S*cortex_runs USING btree \(analysis_id, plan_id, started_at DESC, run_id DESC\)$/);
    });
});
