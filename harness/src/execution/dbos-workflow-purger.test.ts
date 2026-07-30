/**
 * The purger reaches the engine's real system tables, so it runs against the DBOS
 * rig — a plain Postgres schema has no `dbos` schema to reach. Those tables are
 * SHARED by every test in the process and are partitioned only by unique workflow
 * ids, so every row here is seeded under an id minted by `rig.nextWorkflowId` and
 * every delete is scoped to those ids. A broad delete would destroy other tests'
 * rows.
 *
 * Rows are seeded directly rather than by running workflows: the assertions are
 * about which rows a delete reaches (descendants, and the tables that cascade off
 * `workflow_status`), and a hand-built parent/child shape pins that without
 * depending on a live workflow's timing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { createDbosWorkflowPurger } from "./dbos-workflow-purger.js";
import type { WorkflowPurger } from "./workflow-purger.js";

describe("createDbosWorkflowPurger", () => {
    let rig: DbosTestRig;
    let purger: WorkflowPurger;

    beforeAll(async () => {
        rig = await setupDbosForTests("dbos_workflow_purger");
        purger = createDbosWorkflowPurger({ pool: rig.pool });
    });

    afterAll(async () => {
        await rig.drop();
    });

    /**
     * One workflow plus a row in each table that cascades off it. `executor_id` is
     * deliberately not the rig's executor id, so the launched engine's recovery pass
     * never claims a seeded PENDING row.
     */
    async function seedWorkflow(workflowId: string, parentId?: string): Promise<void> {
        await rig.pool.query({
            text: `INSERT INTO dbos.workflow_status (workflow_uuid, status, name, executor_id, parent_workflow_id)
                   VALUES ($1, 'PENDING', 'purger-test-workflow', 'purger-test', $2)`,
            values: [workflowId, parentId ?? null],
        });
        await rig.pool.query({
            text: `INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output)
                   VALUES ($1, 0, 'purger-test-step', '"done"')`,
            values: [workflowId],
        });
        await rig.pool.query({
            text: `INSERT INTO dbos.streams (workflow_uuid, key, value, "offset")
                   VALUES ($1, 'events', '"event"', 0)`,
            values: [workflowId],
        });
    }

    async function countIn(table: "workflow_status" | "operation_outputs" | "streams", workflowIds: readonly string[]): Promise<number> {
        const { rows } = await rig.pool.query<{ n: number }>({
            text: `SELECT COUNT(*)::int AS n FROM dbos.${table} WHERE workflow_uuid = ANY($1)`,
            values: [[...workflowIds]],
        });
        return rows[0]?.n ?? 0;
    }

    async function statusOf(workflowId: string): Promise<string | null> {
        const { rows } = await rig.pool.query<{ status: string | null }>({
            text: `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
            values: [workflowId],
        });
        return rows[0]?.status ?? null;
    }

    it("deletes a parent with its descendants and the rows that cascade off them", async () => {
        const parent = rig.nextWorkflowId("purge-parent-");
        const childA = rig.nextWorkflowId("purge-child-a-");
        const childB = rig.nextWorkflowId("purge-child-b-");
        const grandchild = rig.nextWorkflowId("purge-grandchild-");
        const bystander = rig.nextWorkflowId("purge-bystander-");

        await seedWorkflow(parent);
        await seedWorkflow(childA, parent);
        await seedWorkflow(childB, parent);
        await seedWorkflow(grandchild, childA);
        await seedWorkflow(bystander);

        const family = [parent, childA, childB, grandchild];
        expect(await countIn("workflow_status", family)).toBe(4);
        expect(await countIn("operation_outputs", family)).toBe(4);
        expect(await countIn("streams", family)).toBe(4);

        const deleted = (await purger.deleteWorkflows([parent], true))._unsafeUnwrap();
        expect(deleted).toBe(4);

        expect(await countIn("workflow_status", family)).toBe(0);
        expect(await countIn("operation_outputs", family)).toBe(0);
        expect(await countIn("streams", family)).toBe(0);

        // An unrelated workflow with no ancestry in the deleted set keeps every row.
        expect(await countIn("workflow_status", [bystander])).toBe(1);
        expect(await countIn("operation_outputs", [bystander])).toBe(1);
        expect(await countIn("streams", [bystander])).toBe(1);
    });

    it("leaves descendants alone when descendants are not requested", async () => {
        const parent = rig.nextWorkflowId("shallow-parent-");
        const child = rig.nextWorkflowId("shallow-child-");
        await seedWorkflow(parent);
        await seedWorkflow(child, parent);

        const deleted = (await purger.deleteWorkflows([parent]))._unsafeUnwrap();
        expect(deleted).toBe(1);

        expect(await countIn("workflow_status", [parent])).toBe(0);
        expect(await countIn("workflow_status", [child])).toBe(1);
        expect(await countIn("operation_outputs", [child])).toBe(1);
        expect(await countIn("streams", [child])).toBe(1);
    });

    it("succeeds and reports nothing deleted for an unknown id", async () => {
        const absent = rig.nextWorkflowId("never-existed-");

        expect((await purger.deleteWorkflows([absent], true))._unsafeUnwrap()).toBe(0);
        expect((await purger.deleteWorkflows([absent]))._unsafeUnwrap()).toBe(0);
        expect((await purger.deleteWorkflows([]))._unsafeUnwrap()).toBe(0);
    });

    it("reports nothing deleted on a second delete of the same workflow", async () => {
        const workflowId = rig.nextWorkflowId("twice-");
        await seedWorkflow(workflowId);

        expect((await purger.deleteWorkflows([workflowId], true))._unsafeUnwrap()).toBe(1);
        expect((await purger.deleteWorkflows([workflowId], true))._unsafeUnwrap()).toBe(0);
    });

    it("returns only the ids inside the requested namespace", async () => {
        // The two namespaces differ by one character at the position where the first
        // holds an underscore, so a namespace fed to a LIKE pattern would match both.
        const nonce = rig.nextWorkflowId("");
        const namespace = `dataprofile:a_${nonce}:`;
        const wildcardTwinNamespace = `dataprofile:aX${nonce}:`;

        const inNamespace = [`${namespace}attempt-1`, `${namespace}attempt-2`];
        const twin = `${wildcardTwinNamespace}attempt-1`;
        const unrelated = rig.nextWorkflowId("unrelated-");

        for (const id of [...inNamespace, twin, unrelated]) {
            await seedWorkflow(id);
        }

        const found = (await purger.findByIdPrefix(namespace))._unsafeUnwrap();
        expect([...found].sort()).toEqual([...inNamespace].sort());
    });

    it("returns no ids for a namespace nothing was recorded under", async () => {
        const found = (await purger.findByIdPrefix(`dataprofile:${rig.nextWorkflowId("")}:`))._unsafeUnwrap();
        expect(found).toEqual([]);
    });

    it("cancels a workflow and its descendants, and ignores unknown ids", async () => {
        const parent = rig.nextWorkflowId("cancel-parent-");
        const child = rig.nextWorkflowId("cancel-child-");
        const untouched = rig.nextWorkflowId("cancel-untouched-");
        await seedWorkflow(parent);
        await seedWorkflow(child, parent);
        await seedWorkflow(untouched);

        (await purger.cancel([parent]))._unsafeUnwrap();

        expect(await statusOf(parent)).toBe("CANCELLED");
        expect(await statusOf(child)).toBe("CANCELLED");
        expect(await statusOf(untouched)).toBe("PENDING");

        // An id with no ledger row is a no-op, not a failure — which is what lets a
        // re-run of an already-reclaimed purge cancel before deleting.
        (await purger.cancel([rig.nextWorkflowId("cancel-absent-")]))._unsafeUnwrap();
        (await purger.cancel([]))._unsafeUnwrap();
    });
});

/**
 * A pool standing in for a database whose `dbos` schema does not exist. The rig
 * always launches an engine, which creates that schema, so the absent-ledger path
 * is unreachable against it — and it is the path a host purging from a process that
 * never launched the runtime takes.
 *
 * @param code the SQLSTATE the pool's queries fail with
 */
function failingPool(code: string): Pool {
    const failure = Object.assign(new Error(`relation "dbos.workflow_status" does not exist (${code})`), { code });
    const fake: Record<string, unknown> = {
        // Read once, for the pool size the engine client derives its polling limit from.
        options: {},
    };
    fake.query = () => Promise.reject(failure);
    // `pg` returns the pool from `on`, which is where the engine client registers its
    // own `error` and `connect` handlers.
    fake.on = () => fake;
    // The purger reaches its ledger through `query` alone, and the engine client it
    // hands the same pool to touches only `options` and `on` before its own first
    // `query` — so this covers every part of `Pool` either one reaches.
    return fake as unknown as Pool;
}

describe("createDbosWorkflowPurger against an absent ledger", () => {
    // SQLSTATE `undefined_table` — what Postgres answers when the schema was never created.
    const UNDEFINED_TABLE = "42P01";

    it("reads a missing dbos schema as nothing to purge", async () => {
        const purger = createDbosWorkflowPurger({ pool: failingPool(UNDEFINED_TABLE) });

        expect((await purger.findByIdPrefix("dataprofile:never-launched:"))._unsafeUnwrap()).toEqual([]);
        expect((await purger.cancel(["never-launched-workflow"]))._unsafeUnwrap()).toBeUndefined();
        expect((await purger.deleteWorkflows(["never-launched-workflow"], true))._unsafeUnwrap()).toBe(0);
        expect((await purger.deleteWorkflows(["never-launched-workflow"]))._unsafeUnwrap()).toBe(0);
    });

    it("keeps every other failure on the error channel", async () => {
        // SQLSTATE `insufficient_privilege`: a ledger that exists and cannot be read is
        // not an empty one, and reporting it as nothing to purge would claim a
        // reclamation that never happened.
        const purger = createDbosWorkflowPurger({ pool: failingPool("42501") });

        expect((await purger.findByIdPrefix("dataprofile:denied:"))._unsafeUnwrapErr().op).toBe("workflowPurger.findByIdPrefix");
        expect((await purger.cancel(["denied-workflow"]))._unsafeUnwrapErr().op).toBe("workflowPurger.cancel");
        expect((await purger.deleteWorkflows(["denied-workflow"], true))._unsafeUnwrapErr().op).toBe("workflowPurger.countDoomed");
    });
});
