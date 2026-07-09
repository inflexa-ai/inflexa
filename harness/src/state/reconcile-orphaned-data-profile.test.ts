import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { upsertAnalysis } from "./analyses.js";
import { loadDataProfileStatus, reconcileOrphanedDataProfile, tryStartDataProfile } from "./data-profile.js";

// reconcileOrphanedDataProfile joins the real `dbos.workflow_status` (the DBOS
// system table), so it is exercised against a launched engine — a plain
// pure-Postgres schema has no such table. The DBOS rig owns that schema; we only
// add rows scoped to unique analysis ids, so nothing here perturbs other tests.
describe("reconcileOrphanedDataProfile", () => {
    let rig: DbosTestRig;

    beforeAll(async () => {
        rig = await setupDbosForTests("reconcile_orphaned_dp");
    });

    afterAll(async () => {
        await rig.drop();
    });

    async function seedRunning(analysisId: string): Promise<void> {
        // The seed set is what makes the row claimable: every claim into `running` requires
        // a non-empty `seed_input_file_ids`, so an analysis upserted with no inputs stays
        // at `pending` and there is no orphaned `running` row to reconcile.
        (await upsertAnalysis(rig.pool, analysisId, null, null, ["file-aaa"]))._unsafeUnwrap();
        const claimed = (await tryStartDataProfile(rig.pool, analysisId))._unsafeUnwrap();
        expect(claimed).toBe(true);
    }

    it("resets a running ledger with no active workflow to failed", async () => {
        const id = `dp-orphan-${rig.nextWorkflowId("")}`;
        await seedRunning(id);

        const reset = (await reconcileOrphanedDataProfile(rig.pool, id))._unsafeUnwrap();
        expect(reset).toBe(true);
        expect((await loadDataProfileStatus(rig.pool, id))._unsafeUnwrap()?.status).toBe("failed");
    });

    it("leaves the ledger running while an active (PENDING) workflow backs it", async () => {
        const id = `dp-live-${rig.nextWorkflowId("")}`;
        await seedRunning(id);
        await rig.pool.query({
            text: `INSERT INTO dbos.workflow_status (workflow_uuid, status) VALUES ($1, 'PENDING')`,
            values: [`dataprofile:${id}:n1`],
        });

        const reset = (await reconcileOrphanedDataProfile(rig.pool, id))._unsafeUnwrap();
        expect(reset).toBe(false);
        expect((await loadDataProfileStatus(rig.pool, id))._unsafeUnwrap()?.status).toBe("running");
    });

    it("treats a terminal (SUCCESS) workflow as no longer active and resets", async () => {
        const id = `dp-terminal-${rig.nextWorkflowId("")}`;
        await seedRunning(id);
        await rig.pool.query({
            text: `INSERT INTO dbos.workflow_status (workflow_uuid, status) VALUES ($1, 'SUCCESS')`,
            values: [`dataprofile:${id}:n1`],
        });

        const reset = (await reconcileOrphanedDataProfile(rig.pool, id))._unsafeUnwrap();
        expect(reset).toBe(true);
        expect((await loadDataProfileStatus(rig.pool, id))._unsafeUnwrap()?.status).toBe("failed");
    });
});
