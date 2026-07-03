import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { upsertAnalysis } from "./analyses.js";
import { loadPlan, upsertPlan } from "./plans.js";

async function countPlans(pool: Pool, planId: string): Promise<number> {
    const r = await pool.query<{ n: number }>({
        text: "SELECT count(*)::int AS n FROM cortex_plans WHERE plan_id = $1",
        values: [planId],
    });
    return Number(r.rows[0].n);
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
        unwrapOrThrow(await upsertAnalysis(pool, "analysis-1", null, null));
        unwrapOrThrow(await upsertAnalysis(pool, "analysis-2", null, null));
    });

    afterAll(async () => {
        await drop();
    });

    it("persists a fresh plan that loadPlan round-trips", async () => {
        const plan = { title: "t", steps: [{ id: "s1" }] };
        unwrapOrThrow(await upsertPlan(pool, { planId: "pln-00000001", analysisId: "analysis-1", plan }));

        const loaded = unwrapOrThrow(await loadPlan(pool, "pln-00000001", { analysisId: "analysis-1" }));
        expect(loaded).toEqual(plan);
    });

    it("re-upserting the same id is a no-op success — one row survives, first payload kept", async () => {
        const first = { v: 1 };
        const second = { v: 2 };
        unwrapOrThrow(await upsertPlan(pool, { planId: "pln-0000000a", analysisId: "analysis-1", plan: first }));
        unwrapOrThrow(await upsertPlan(pool, { planId: "pln-0000000a", analysisId: "analysis-1", plan: second }));

        expect(await countPlans(pool, "pln-0000000a")).toBe(1);
        // ON CONFLICT DO NOTHING leaves the original row untouched.
        const loaded = unwrapOrThrow(await loadPlan(pool, "pln-0000000a", { analysisId: "analysis-1" }));
        expect(loaded).toEqual(first);
    });

    it("rejects an id that is not the pln-<8hex> shape before any write", () => {
        expect(() => upsertPlan(pool, { planId: "not-a-plan-id", analysisId: "analysis-1", plan: {} })).toThrow(/pln-<8hex>/);
    });

    it("enforces the parent-scope check when the parent belongs to another analysis", async () => {
        unwrapOrThrow(await upsertPlan(pool, { planId: "pln-000000b0", analysisId: "analysis-1", plan: {} }));

        let message = "";
        try {
            await upsertPlan(pool, {
                planId: "pln-000000b1",
                analysisId: "analysis-2",
                plan: {},
                parentPlanId: "pln-000000b0",
            });
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain("different analysis");
        // The child row was never written — the throw short-circuits before INSERT.
        expect(await countPlans(pool, "pln-000000b1")).toBe(0);
    });

    it("accepts a parent in the same analysis", async () => {
        unwrapOrThrow(await upsertPlan(pool, { planId: "pln-000000c0", analysisId: "analysis-1", plan: {} }));
        unwrapOrThrow(
            await upsertPlan(pool, {
                planId: "pln-000000c1",
                analysisId: "analysis-1",
                plan: {},
                parentPlanId: "pln-000000c0",
            }),
        );
        expect(await countPlans(pool, "pln-000000c1")).toBe(1);
    });
});
