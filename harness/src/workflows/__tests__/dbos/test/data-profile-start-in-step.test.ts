/**
 * The start of a data profile from a step of a workflow, against the real engine.
 *
 * A chat turn is a workflow, and a tool call of the turn runs in a step. A tool that adds the inputs of an
 * analysis claims the profile and starts its workflow from that step. DBOS refuses a workflow start inside a
 * step, thus the start goes through the run launcher.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { setTimeout as sleep } from "node:timers/promises";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { createLocalRunAuthorizer } from "../../../../auth/local-run-authorizer.js";
import { makeLocalAuth } from "../../../../auth/local-auth-context.js";
import { createDbosRunLauncher } from "../../../../execution/dbos-run-launcher.js";
import { tryRetryDataProfile } from "../../../../state/index.js";
import { runDataProfile, type DataProfileTriggerDeps, type DataProfileWorkflowInput } from "../../../../tasks/data-profile.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS_ID = "analysis-profile-in-step";

/** The profile workflow. It records each analysis that it profiles. */
const profiled: string[] = [];
const profileWorkflow = DBOS.registerWorkflow(
    async (input: DataProfileWorkflowInput): Promise<void> => {
        profiled.push(input.analysisId);
        return Promise.resolve();
    },
    { name: "data-profile-start-in-step-profile" },
);

let deps: DataProfileTriggerDeps | undefined;

/** The turn: one step that starts the profile, the way a tool call of a turn does. */
const turn = DBOS.registerWorkflow(
    async (): Promise<string> =>
        DBOS.runStep(
            async () => {
                if (deps === undefined) throw new Error("the deps are built before the turn starts");
                const started = await runDataProfile(deps, {
                    auth: makeLocalAuth(),
                    analysisId: ANALYSIS_ID,
                    stagedInputs: [
                        {
                            fileId: "file-a",
                            mountName: "file-a",
                            key: "file-a.csv",
                            fileName: "file-a.csv",
                            hash: "hash-a",
                            size: 1024,
                            mtimeMs: 1_780_000_000_000,
                            relativePath: "inputs/file-a/file-a.csv",
                        },
                    ],
                });
                return started.match(
                    () => "started",
                    (failure) => failure.type,
                );
            },
            { name: "manage_inputs.call-1" },
        ),
    { name: "data-profile-start-in-step-turn" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("data_profile_start_in_step");
    if (!DBOS.isInitialized()) await DBOS.launch();
    const now = new Date().toISOString();
    await rig.pool.query({
        text: `INSERT INTO cortex_analysis_state (analysis_id, status, context, data_profile_status, seed_input_file_ids, created_at, updated_at)
               VALUES ($1, 'active', NULL, 'failed', '["file-a"]'::jsonb, $2, $2)`,
        values: [ANALYSIS_ID, now],
    });
    expect((await tryRetryDataProfile(rig.pool, ANALYSIS_ID))._unsafeUnwrap()).toBe(true);
    deps = { pool: rig.pool, runAuthorizer: createLocalRunAuthorizer(), runLauncher: createDbosRunLauncher({ pool: rig.pool }), workflow: profileWorkflow };
});

afterAll(async () => {
    await rig.drop();
});

describe("the start of a data profile from a step", () => {
    it("starts the profile workflow, and the profile row stays running", async () => {
        const handle = await DBOS.startWorkflow(turn, { workflowID: rig.nextWorkflowId("data-profile-start-in-step-") })();

        expect(await handle.getResult()).toBe("started");
        for (let waited = 0; profiled.length === 0 && waited < 5_000; waited += 25) await sleep(25);
        expect(profiled).toEqual([ANALYSIS_ID]);
        const { rows } = await rig.pool.query<{ data_profile_status: string }>({
            text: "SELECT data_profile_status FROM cortex_analysis_state WHERE analysis_id = $1",
            values: [ANALYSIS_ID],
        });
        expect(rows[0]?.data_profile_status).toBe("running");
    }, 20_000);
});
