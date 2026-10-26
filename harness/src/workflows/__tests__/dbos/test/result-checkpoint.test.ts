/**
 * A neverthrow `Result` survives a DBOS checkpoint.
 *
 * `launchDbos` registers the recipes of `Ok` and `Err`
 * (`runtime/result-serialization.ts`). A step or a workflow can then return a
 * `Result` as a value: an `err` from a step is a success of the step, and a
 * replay gives the same `Err`, with the methods of a `Result`.
 *
 * The replay uses the pattern of `workflow-replay.test.ts`: an unconditional
 * self-cancel after the step under test, then `resumeWorkflow`. The cached
 * step returns its checkpoint without a new call of its closure.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { err, type Result } from "neverthrow";

import { setupDbosForTests, waitForStopped, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

type Refusal = {
    readonly reason: string;
    readonly suspend: boolean;
};

let stepCalls = 0;

const errStepMirror = DBOS.registerWorkflow(
    async (): Promise<{ isErr: boolean; hasMatch: boolean; error: Refusal | null }> => {
        const result = await DBOS.runStep(
            (): Promise<Result<string, Refusal>> => {
                stepCalls += 1;
                return Promise.resolve(err({ reason: "refused", suspend: true }));
            },
            { name: "result-checkpoint.step" },
        );
        const workflowId = DBOS.workflowID;
        if (workflowId === undefined) throw new Error("the workflow id is absent outside a DBOS execution");
        await DBOS.cancelWorkflow(workflowId);
        await DBOS.runStep(() => Promise.resolve(undefined), { name: "result-checkpoint.tail" });
        return {
            isErr: result.isErr(),
            hasMatch: typeof result.match === "function",
            error: result.isErr() ? result.error : null,
        };
    },
    { name: "result-checkpoint-step-mirror" },
);

const errWorkflow = DBOS.registerWorkflow(
    (): Promise<Result<string, { kind: "suspended"; reason: string }>> => Promise.resolve(err({ kind: "suspended", reason: "payment_required" })),
    { name: "result-checkpoint-workflow" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("result_checkpoint");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

describe("a Result across a DBOS checkpoint", () => {
    it("a step that returns err gives the same Err on replay, and the step does not run again", async () => {
        stepCalls = 0;
        const wfId = rig.nextWorkflowId("result-step-");

        const first = await DBOS.startWorkflow(errStepMirror, { workflowID: wfId })();
        expect((await waitForStopped(first, wfId))?.status).toBe("CANCELLED");
        expect(stepCalls).toBe(1);

        const resumed = await DBOS.resumeWorkflow<{ isErr: boolean; hasMatch: boolean; error: Refusal | null }>(wfId);
        const out = await resumed.getResult();

        expect(stepCalls).toBe(1);
        expect(out).toEqual({ isErr: true, hasMatch: true, error: { reason: "refused", suspend: true } });
    });

    it("a workflow that returns err gives an Err to the caller of getResult", async () => {
        const wfId = rig.nextWorkflowId("result-wf-");

        const handle = await DBOS.startWorkflow(errWorkflow, { workflowID: wfId })();
        const live = await handle.getResult();
        expect(live.isErr()).toBe(true);

        // A retrieved handle reads the output back from the system database.
        const stored = await DBOS.retrieveWorkflow<Result<string, { kind: "suspended"; reason: string }>>(wfId).getResult();
        expect(stored.isErr()).toBe(true);
        expect(stored.isErr() ? stored.error : null).toEqual({ kind: "suspended", reason: "payment_required" });
    });
});
