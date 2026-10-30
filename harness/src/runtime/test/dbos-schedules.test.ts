import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";

import { noopTestWorkflow, setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { applyWorkflowSchedules, scheduleWorkflow } from "../dbos.js";

// Once a year, thus no schedule of this file fires during the run.
const YEARLY = "0 0 1 1 *";

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("dbos_schedules");
});

afterAll(async () => {
    await rig.drop();
});

describe("applyWorkflowSchedules", () => {
    it("deletes a stored schedule that no code registers, and keeps each registered one", async () => {
        const removed = `removed-${randomUUID()}`;
        const kept = `kept-${randomUUID()}`;
        await DBOS.createSchedule({ scheduleName: removed, workflowFn: noopTestWorkflow, schedule: YEARLY });
        scheduleWorkflow({ scheduleName: kept, workflowFn: noopTestWorkflow, schedule: YEARLY });

        await applyWorkflowSchedules();

        const names = (await DBOS.listSchedules()).map((schedule) => schedule.scheduleName);
        expect(names).toContain(kept);
        expect(names).not.toContain(removed);
        await DBOS.deleteSchedule(kept);
    });
});
