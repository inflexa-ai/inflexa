import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { upsertAnalysis } from "./analyses.js";
import { upsertPlan } from "./plans.js";
import { insertRun, ORPHANED_RUN_GRACE_MS, reconcileOrphanedRuns } from "./runs.js";

// reconcileOrphanedRuns reads the real `dbos.workflow_status`, thus it runs against a launched engine: a plain
// Postgres schema has no such table. Each test uses its own analysis id, so the rows of one test never reach
// the predicate of another.
describe("reconcileOrphanedRuns", () => {
    let rig: DbosTestRig;
    const NOW = Date.parse("2026-10-14T12:00:00.000Z");
    const OLD = new Date(NOW - ORPHANED_RUN_GRACE_MS - 1000).toISOString();
    const YOUNG = new Date(NOW - 1000).toISOString();

    beforeAll(async () => {
        rig = await setupDbosForTests("reconcile_orphaned_runs");
    });

    afterAll(async () => {
        await rig.drop();
    });

    /** The run row of a stored plan of its own analysis: `plan_id` references `cortex_plans`. Gives the plan id. */
    async function seedRun(analysisId: string, runId: string, startedAt: string): Promise<string> {
        const planId = `pln-${randomBytes(4).toString("hex")}`;
        (await upsertAnalysis(rig.pool, analysisId, null))._unsafeUnwrap();
        (await upsertPlan(rig.pool, { planId, analysisId, plan: { steps: [] } }))._unsafeUnwrap();
        (await insertRun(rig.pool, { runId, analysisId, threadId: null, workflowName: "executeAnalysis", planId }))._unsafeUnwrap();
        await rig.pool.query({ text: "UPDATE cortex_runs SET started_at = $1 WHERE run_id = $2", values: [startedAt, runId] });
        return planId;
    }

    async function statusOf(runId: string): Promise<{ status: string; error: string | null; completed_at: string | null }> {
        const { rows } = await rig.pool.query({ text: "SELECT status, error, completed_at FROM cortex_runs WHERE run_id = $1", values: [runId] });
        return rows[0];
    }

    it("fails a running run that started before the grace and has no workflow", async () => {
        const id = `orphan-${rig.nextWorkflowId("")}`;
        await seedRun(id, `${id}-run`, OLD);

        const reset = (await reconcileOrphanedRuns(rig.pool, { now: NOW }))._unsafeUnwrap();

        expect(reset).toContain(`${id}-run`);
        expect(await statusOf(`${id}-run`)).toMatchObject({ status: "failed", error: "The workflow of the run never started." });
        expect((await statusOf(`${id}-run`)).completed_at).not.toBeNull();
    });

    it("leaves a run with a workflow row, of any status, to the workflow", async () => {
        const id = `backed-${rig.nextWorkflowId("")}`;
        await seedRun(id, `${id}-run`, OLD);
        await rig.pool.query({ text: `INSERT INTO dbos.workflow_status (workflow_uuid, status) VALUES ($1, 'SUCCESS')`, values: [`${id}-run`] });

        const reset = (await reconcileOrphanedRuns(rig.pool, { now: NOW }))._unsafeUnwrap();

        expect(reset).not.toContain(`${id}-run`);
        expect((await statusOf(`${id}-run`)).status).toBe("running");
    });

    it("leaves a run inside the grace, because its launch can still be between the reservation and the start", async () => {
        const id = `young-${rig.nextWorkflowId("")}`;
        await seedRun(id, `${id}-run`, YOUNG);

        const reset = (await reconcileOrphanedRuns(rig.pool, { now: NOW }))._unsafeUnwrap();

        expect(reset).not.toContain(`${id}-run`);
        expect((await statusOf(`${id}-run`)).status).toBe("running");
    });

    it("frees the active-plan slot, so the plan can start a new run", async () => {
        const id = `slot-${rig.nextWorkflowId("")}`;
        const planId = await seedRun(id, `${id}-run`, OLD);
        (await reconcileOrphanedRuns(rig.pool, { now: NOW }))._unsafeUnwrap();

        const relaunch = await insertRun(rig.pool, {
            runId: `${id}-run-2`,
            analysisId: id,
            threadId: null,
            workflowName: "executeAnalysis",
            planId,
        });

        expect(relaunch.isOk()).toBe(true);
    });
});
