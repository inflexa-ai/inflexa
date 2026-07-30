/**
 * The purger reaches the engine's real system tables, so it runs against the DBOS
 * rig — a plain Postgres schema has no `dbos` schema to reach. Those tables are
 * SHARED by every test in the process and are partitioned only by unique workflow
 * ids, so every row here is seeded under an id minted by `rig.nextWorkflowId` and
 * every delete is scoped to those ids.
 *
 * Rows a delete under test deliberately leaves standing would otherwise outlive
 * the process, since dropping the per-test schema takes nothing out of `dbos`. So
 * `afterAll` deletes exactly the rows this file wrote, scoped to the `executor_id`
 * literal it stamps on all of them and nothing else in the process writes. A
 * delete broader than that literal would destroy other tests' rows.
 *
 * Rows are seeded directly rather than by running workflows: the assertions are
 * about which rows a delete reaches (descendants, and the tables that cascade off
 * `workflow_status`), and a hand-built parent/child shape pins that without
 * depending on a live workflow's timing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { createDbosLedgerSeeder, type DbosLedgerSeeder } from "../__tests__/setup/dbos-ledger.js";
import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { createDbosWorkflowPurger } from "./dbos-workflow-purger.js";
import type { WorkflowPurger } from "./workflow-purger.js";

/**
 * Stamped on every `dbos.workflow_status` row this file writes, and read back by
 * `afterAll` to reclaim them. Deliberately not the rig's executor id, so the
 * launched engine's recovery pass never claims a seeded PENDING row.
 */
const SEEDED_EXECUTOR_ID = "purger-test";

/**
 * The cascading tables seeded beside each status row. A dependent row is here to
 * show a delete reaching past `workflow_status`, and these are the ones the
 * assertions below read back — seeding the tables nothing counts would only make
 * the fixture wider, not the claim stronger.
 */
const SEEDED_CASCADE_TABLES = ["operation_outputs", "streams"] as const;

describe("createDbosWorkflowPurger", () => {
    let rig: DbosTestRig;
    let purger: WorkflowPurger;
    let ledger: DbosLedgerSeeder;

    beforeAll(async () => {
        rig = await setupDbosForTests("dbos_workflow_purger");
        purger = createDbosWorkflowPurger({ pool: rig.pool });
        ledger = createDbosLedgerSeeder({ pool: rig.pool, executorId: SEEDED_EXECUTOR_ID, cascadeTables: SEEDED_CASCADE_TABLES });
    });

    afterAll(async () => {
        // Before the pool goes: every status row this file seeded, and — through the
        // same cascade the purger relies on — every dependent row seeded beside it.
        await rig.pool.query({
            text: `DELETE FROM dbos.workflow_status WHERE executor_id = $1`,
            values: [SEEDED_EXECUTOR_ID],
        });
        await rig.drop();
    });

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

        await ledger.seedWorkflow(parent);
        await ledger.seedWorkflow(childA, parent);
        await ledger.seedWorkflow(childB, parent);
        await ledger.seedWorkflow(grandchild, childA);
        await ledger.seedWorkflow(bystander);

        const family = [parent, childA, childB, grandchild];
        expect(await ledger.countRows("workflow_status", family)).toBe(4);
        expect(await ledger.countRows("operation_outputs", family)).toBe(4);
        expect(await ledger.countRows("streams", family)).toBe(4);

        const deleted = (await purger.deleteWorkflows([parent], true))._unsafeUnwrap();
        expect(deleted).toBe(4);

        expect(await ledger.countRows("workflow_status", family)).toBe(0);
        expect(await ledger.countRows("operation_outputs", family)).toBe(0);
        expect(await ledger.countRows("streams", family)).toBe(0);

        // An unrelated workflow with no ancestry in the deleted set keeps every row.
        expect(await ledger.countRows("workflow_status", [bystander])).toBe(1);
        expect(await ledger.countRows("operation_outputs", [bystander])).toBe(1);
        expect(await ledger.countRows("streams", [bystander])).toBe(1);
    });

    it("leaves descendants alone when descendants are not requested", async () => {
        const parent = rig.nextWorkflowId("shallow-parent-");
        const child = rig.nextWorkflowId("shallow-child-");
        await ledger.seedWorkflow(parent);
        await ledger.seedWorkflow(child, parent);

        const deleted = (await purger.deleteWorkflows([parent]))._unsafeUnwrap();
        expect(deleted).toBe(1);

        expect(await ledger.countRows("workflow_status", [parent])).toBe(0);
        expect(await ledger.countRows("workflow_status", [child])).toBe(1);
        expect(await ledger.countRows("operation_outputs", [child])).toBe(1);
        expect(await ledger.countRows("streams", [child])).toBe(1);
    });

    it("succeeds and reports nothing deleted for an unknown id", async () => {
        const absent = rig.nextWorkflowId("never-existed-");

        expect((await purger.deleteWorkflows([absent], true))._unsafeUnwrap()).toBe(0);
        expect((await purger.deleteWorkflows([absent]))._unsafeUnwrap()).toBe(0);
        expect((await purger.deleteWorkflows([]))._unsafeUnwrap()).toBe(0);
    });

    it("reports nothing deleted on a second delete of the same workflow", async () => {
        const workflowId = rig.nextWorkflowId("twice-");
        await ledger.seedWorkflow(workflowId);

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
            await ledger.seedWorkflow(id);
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
        await ledger.seedWorkflow(parent);
        await ledger.seedWorkflow(child, parent);
        await ledger.seedWorkflow(untouched);

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
 * A pool standing in for a database whose ledger queries all fail. The rig always
 * launches an engine, which creates the `dbos` schema and its tables, so neither
 * unreachable-ledger path is exercisable against it — and one of them is the path a
 * host purging from a process that never launched the runtime takes.
 *
 * Every query fails with `code`, except the purger's schema probe, which is
 * answered from `systemSchema`. Answering the two separately is what lets a test
 * pin which of them the purger keys its recovery on: the same SQLSTATE comes back
 * whether the schema was never created or its `workflow_status` table went missing
 * beneath it.
 *
 * @param code the SQLSTATE the pool's ledger queries fail with
 * @param systemSchema whether the probe finds the engine's schema
 */
function failingPool(code: string, systemSchema: "present" | "absent"): Pool {
    const failure = Object.assign(new Error(`relation "dbos.workflow_status" does not exist (${code})`), { code });
    const fake: Record<string, unknown> = {
        // Read once, for the pool size the engine client derives its polling limit from.
        options: {},
    };
    const textOf = (config: unknown): string => {
        if (typeof config === "string") return config;
        if (typeof config === "object" && config !== null && "text" in config) return String(config.text);
        return "";
    };
    fake.query = (config: unknown) =>
        textOf(config).includes("information_schema.schemata") ? Promise.resolve({ rows: [{ present: systemSchema === "present" }] }) : Promise.reject(failure);
    // `pg` returns the pool from `on`, which is where the engine client registers its
    // own `error` and `connect` handlers.
    fake.on = () => fake;
    // The purger reaches its ledger through `query` alone, and the engine client it
    // hands the same pool to touches only `options` and `on` before its own first
    // `query` — so this covers every part of `Pool` either one reaches.
    return fake as unknown as Pool;
}

describe("createDbosWorkflowPurger against an unreachable ledger", () => {
    // SQLSTATE `undefined_table` — Postgres's answer for a table that is not there,
    // whether because its schema was never created or because it alone is missing.
    const UNDEFINED_TABLE = "42P01";

    it("reads a missing dbos schema as nothing to purge", async () => {
        const purger = createDbosWorkflowPurger({ pool: failingPool(UNDEFINED_TABLE, "absent") });

        expect((await purger.findByIdPrefix("dataprofile:never-launched:"))._unsafeUnwrap()).toEqual([]);
        expect((await purger.cancel(["never-launched-workflow"]))._unsafeUnwrap()).toBeUndefined();
        expect((await purger.deleteWorkflows(["never-launched-workflow"], true))._unsafeUnwrap()).toBe(0);
        expect((await purger.deleteWorkflows(["never-launched-workflow"]))._unsafeUnwrap()).toBe(0);
    });

    it("keeps a missing ledger table under a schema that exists on the error channel", async () => {
        // An SDK rename, a manual drop, or a half-applied migration leaves the schema
        // standing with `workflow_status` gone, and answers the same SQLSTATE a runtime
        // that never launched does. Reading that as an empty ledger would report a
        // successful purge for an analysis whose rows were never reclaimed.
        const purger = createDbosWorkflowPurger({ pool: failingPool(UNDEFINED_TABLE, "present") });

        expect((await purger.findByIdPrefix("dataprofile:broken-ledger:"))._unsafeUnwrapErr().op).toBe("workflowPurger.findByIdPrefix");
        expect((await purger.cancel(["broken-ledger-workflow"]))._unsafeUnwrapErr().op).toBe("workflowPurger.cancel");
        expect((await purger.deleteWorkflows(["broken-ledger-workflow"], true))._unsafeUnwrapErr().op).toBe("workflowPurger.countDoomed");
        expect((await purger.deleteWorkflows(["broken-ledger-workflow"]))._unsafeUnwrapErr().op).toBe("workflowPurger.countDoomed");
    });

    it("keeps every other failure on the error channel", async () => {
        // SQLSTATE `insufficient_privilege`: a ledger that exists and cannot be read is
        // not an empty one, and reporting it as nothing to purge would claim a
        // reclamation that never happened. The probe answers that no schema exists, so
        // a recovery resting on the probe rather than on the SQLSTATE would swallow all
        // three of these.
        const purger = createDbosWorkflowPurger({ pool: failingPool("42501", "absent") });

        expect((await purger.findByIdPrefix("dataprofile:denied:"))._unsafeUnwrapErr().op).toBe("workflowPurger.findByIdPrefix");
        expect((await purger.cancel(["denied-workflow"]))._unsafeUnwrapErr().op).toBe("workflowPurger.cancel");
        expect((await purger.deleteWorkflows(["denied-workflow"], true))._unsafeUnwrapErr().op).toBe("workflowPurger.countDoomed");
    });
});
