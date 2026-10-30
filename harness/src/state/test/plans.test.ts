// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the parent index definition that the migration declares, over the qualified table name
const PARENT_INDEX_DDL = /ON \S*cortex_plans USING btree \(parent_plan_id\)$/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the runs index definition that the migration declares, over the qualified table name
const RUNS_INDEX_DDL = /ON \S*cortex_runs USING btree \(analysis_id, plan_id, started_at DESC, run_id DESC\)$/;

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { countingQuerier } from "../../__tests__/setup/counting-querier.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../analyses.js";
import type { Querier } from "../db.js";
import { loadPlan, loadPlanRecord, queryPlanPage, upsertPlan } from "../plans.js";

async function countPlans(pool: Pool, planId: string): Promise<number> {
    const r = await pool.query<{ n: number }>({
        text: "SELECT count(*)::int AS n FROM cortex_plans WHERE plan_id = $1",
        values: [planId],
    });
    const row = r.rows[0];
    if (row === undefined) throw new Error("the count query returned no row");
    return row.n;
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
            message = errorMessageOf(err) ?? textOf(err);
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

async function seedRun(pool: Pool, row: { runId: string; analysisId: string; planId: string | null; startedAt: string }): Promise<void> {
    await pool.query({
        text: `INSERT INTO cortex_runs (run_id, analysis_id, workflow_name, status, started_at, plan_id)
               VALUES ($1, $2, 'executeAnalysis', 'completed', $3, $4)`,
        values: [row.runId, row.analysisId, row.startedAt, row.planId],
    });
}

describe("queryPlanPage", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("plans_page"));
        for (const analysisId of ["pg-order", "pg-tie", "pg-runs", "pg-title", "pg-pages", "pg-iso-1", "pg-iso-2", "pg-stmt", "pg-empty", "pg-bad"]) {
            (await upsertAnalysis(pool, analysisId, null))._unsafeUnwrap();
        }
    });

    afterAll(async () => {
        await drop();
    });

    it("gives the newest plan first, with the lineage of each plan", async () => {
        await seedPlan(pool, { planId: "pln-0000000a", analysisId: "pg-order", createdAt: "2026-10-01T00:00:00.000Z" });
        await seedPlan(pool, { planId: "pln-0000000b", analysisId: "pg-order", parentPlanId: "pln-0000000a", createdAt: "2026-10-02T00:00:00.000Z" });

        const page = (await queryPlanPage(pool, "pg-order", { limit: 10, offset: 0 }))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.entries).toEqual([
            {
                planId: "pln-0000000b",
                createdAt: "2026-10-02T00:00:00.000Z",
                title: null,
                parentPlanId: "pln-0000000a",
                supersededBy: null,
                newestRunId: null,
            },
            {
                planId: "pln-0000000a",
                createdAt: "2026-10-01T00:00:00.000Z",
                title: null,
                parentPlanId: null,
                supersededBy: "pln-0000000b",
                newestRunId: null,
            },
        ]);
    });

    it("orders equal creation times by the highest plan id first", async () => {
        const at = "2026-10-01T00:00:00.000Z";
        await seedPlan(pool, { planId: "pln-00000901", analysisId: "pg-tie", createdAt: at });
        await seedPlan(pool, { planId: "pln-00000902", analysisId: "pg-tie", createdAt: at });

        const page = (await queryPlanPage(pool, "pg-tie", { limit: 10, offset: 0 }))._unsafeUnwrap();

        expect(page.entries.map((e) => e.planId)).toEqual(["pln-00000902", "pln-00000901"]);
    });

    it("gives the newest run of each plan, null for a plan with no run, and ignores the runs of a different analysis", async () => {
        await seedPlan(pool, { planId: "pln-00000a01", analysisId: "pg-runs", createdAt: "2026-10-02T00:00:00.000Z" });
        await seedPlan(pool, { planId: "pln-00000a02", analysisId: "pg-runs", createdAt: "2026-10-01T00:00:00.000Z" });
        await seedRun(pool, { runId: "pg-r1", analysisId: "pg-runs", planId: "pln-00000a01", startedAt: "2026-10-03T00:00:00.000Z" });
        await seedRun(pool, { runId: "pg-r2", analysisId: "pg-runs", planId: "pln-00000a01", startedAt: "2026-10-04T00:00:00.000Z" });
        await seedRun(pool, { runId: "pg-r3", analysisId: "pg-order", planId: "pln-00000a02", startedAt: "2026-10-05T00:00:00.000Z" });

        const page = (await queryPlanPage(pool, "pg-runs", { limit: 10, offset: 0 }))._unsafeUnwrap();

        expect(page.entries.map((e) => [e.planId, e.newestRunId])).toEqual([
            ["pln-00000a01", "pg-r2"],
            ["pln-00000a02", null],
        ]);
    });

    it("gives the string title of the document, and null for a missing or a non-string title", async () => {
        await seedPlan(pool, { planId: "pln-00000b01", analysisId: "pg-title", createdAt: "2026-10-04T00:00:00.000Z", plan: { title: "Liver DE", steps: [] } });
        await seedPlan(pool, { planId: "pln-00000b02", analysisId: "pg-title", createdAt: "2026-10-03T00:00:00.000Z", plan: { steps: [] } });
        await seedPlan(pool, { planId: "pln-00000b03", analysisId: "pg-title", createdAt: "2026-10-02T00:00:00.000Z", plan: { title: 7 } });
        await seedPlan(pool, { planId: "pln-00000b04", analysisId: "pg-title", createdAt: "2026-10-01T00:00:00.000Z", plan: "not a document" });

        const page = (await queryPlanPage(pool, "pg-title", { limit: 10, offset: 0 }))._unsafeUnwrap();

        expect(page.entries.map((e) => [e.planId, e.title])).toEqual([
            ["pln-00000b01", "Liver DE"],
            ["pln-00000b02", null],
            ["pln-00000b03", null],
            ["pln-00000b04", null],
        ]);
    });

    it("gives disjoint pages, and an empty page past the end with the total", async () => {
        for (const [planId, day] of [
            ["pln-00000c01", "01"],
            ["pln-00000c02", "02"],
            ["pln-00000c03", "03"],
        ] as const) {
            await seedPlan(pool, { planId, analysisId: "pg-pages", createdAt: `2026-10-${day}T00:00:00.000Z` });
        }

        const first = (await queryPlanPage(pool, "pg-pages", { limit: 2, offset: 0 }))._unsafeUnwrap();
        const second = (await queryPlanPage(pool, "pg-pages", { limit: 2, offset: 2 }))._unsafeUnwrap();
        const past = (await queryPlanPage(pool, "pg-pages", { limit: 2, offset: 4 }))._unsafeUnwrap();

        expect(first.entries.map((e) => e.planId)).toEqual(["pln-00000c03", "pln-00000c02"]);
        expect(second.entries.map((e) => e.planId)).toEqual(["pln-00000c01"]);
        expect(past.entries).toEqual([]);
        expect([first.total, second.total, past.total]).toEqual([3, 3, 3]);
    });

    it("leaves the plans of a different analysis out of the entries, the total, and supersededBy", async () => {
        await seedPlan(pool, { planId: "pln-00000d01", analysisId: "pg-iso-1", createdAt: "2026-10-01T00:00:00.000Z" });
        await seedPlan(pool, { planId: "pln-00000d02", analysisId: "pg-iso-2", parentPlanId: "pln-00000d01", createdAt: "2026-10-02T00:00:00.000Z" });

        const page = (await queryPlanPage(pool, "pg-iso-1", { limit: 10, offset: 0 }))._unsafeUnwrap();

        expect(page.total).toBe(1);
        expect(page.entries).toMatchObject([{ planId: "pln-00000d01", supersededBy: null }]);
    });

    it("gives an empty page for an analysis with no plan", async () => {
        const page = (await queryPlanPage(pool, "pg-empty", { limit: 10, offset: 0 }))._unsafeUnwrap();

        expect(page).toEqual({ entries: [], total: 0 });
    });

    it("gives the same supersededBy as loadPlanRecord", async () => {
        await seedPlan(pool, { planId: "pln-00000e00", analysisId: "pg-bad", createdAt: "2026-10-01T00:00:00.000Z" });
        const at = "2026-10-02T00:00:00.000Z";
        await seedPlan(pool, { planId: "pln-00000e01", analysisId: "pg-bad", parentPlanId: "pln-00000e00", createdAt: at });
        await seedPlan(pool, { planId: "pln-00000e02", analysisId: "pg-bad", parentPlanId: "pln-00000e00", createdAt: at });

        const page = (await queryPlanPage(pool, "pg-bad", { limit: 10, offset: 0 }))._unsafeUnwrap();
        const record = (await loadPlanRecord(pool, "pln-00000e00", { analysisId: "pg-bad" }))._unsafeUnwrap();

        expect(page.entries.find((e) => e.planId === "pln-00000e00")?.supersededBy).toBe("pln-00000e02");
        expect(record?.supersededBy).toBe("pln-00000e02");
    });

    it("sends two statements whatever the limit", async () => {
        for (let i = 0; i < 5; i += 1) {
            await seedPlan(pool, { planId: `pln-00000f0${i}`, analysisId: "pg-stmt", createdAt: `2026-10-0${i + 1}T00:00:00.000Z` });
        }
        const small = countingQuerier(pool);
        const large = countingQuerier(pool);

        (await queryPlanPage(small.querier, "pg-stmt", { limit: 1, offset: 0 }))._unsafeUnwrap();
        (await queryPlanPage(large.querier, "pg-stmt", { limit: 200, offset: 0 }))._unsafeUnwrap();

        expect(small.calls()).toBe(2);
        expect(large.calls()).toBe(2);
    });

    it("rides the error channel with the op on a driver failure", async () => {
        const rejecting: Querier = { query: () => Promise.reject(new Error("connection lost")) };

        const error = (await queryPlanPage(rejecting, "a1", { limit: 10, offset: 0 })).match(
            () => null,
            (failure) => failure,
        );

        expect(error).toMatchObject({ type: "query_failed", op: "plans.queryPlanPage" });
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
        const parentDef = await indexDefinition("idx_cortex_plans_parent");
        expect(parentDef !== undefined && PARENT_INDEX_DDL.test(parentDef)).toBe(true);
    });

    it("indexes the runs by analysis, plan, start time, and run id", async () => {
        const runsDef = await indexDefinition("idx_cortex_runs_plan");
        expect(runsDef !== undefined && RUNS_INDEX_DDL.test(runsDef)).toBe(true);
    });
});
