/**
 * The run end that the body records, against the real engine.
 *
 * The body records its run end with `DBOS.setEvent` after a failed status write,
 * and the run canceler reads it with a `DBOSClient` that has a zero timeout.
 * These tests drive that pair through the engine: the canceler here is built
 * with its production read. The last case pins the fact that the status write of
 * `collectAndComplete` relies on: the last attempt of a retried step sees its
 * current attempt equal to its maximum.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { okAsync } from "neverthrow";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { silentLogger } from "../../../../__tests__/setup/logger.js";
import type { AgentSession } from "../../../../auth/types.js";
import type { RunCharge } from "../../../../billing/run-charge.js";
import { dbosClientFor } from "../../../../execution/dbos-workflow-purger.js";
import type { RunAuthorizer } from "../../../../execution/run-authorizer.js";
import { createRunCanceler } from "../../../../execution/run-canceler.js";
import { RUN_END_EVENT_KEY, type RecordedRunEnd } from "../../../../execution/run-end-record.js";
import { insertRun, queryRun } from "../../../../state/runs.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const session: AgentSession = {
    identity: { user: "tester" },
    scope: { kind: "analysis", analysisId: "analysis-1" },
    provenance: { agentId: "cancel-route", callPath: ["cancel-route"] },
    auth: {},
};

const RECORDED: RecordedRunEnd = { status: "failed", error: "synthesis failed", closed: true, revoked: false };

const recordsRunEnd = DBOS.registerWorkflow(
    async (): Promise<void> => {
        await DBOS.runStep(() => Promise.resolve(undefined), { name: "run-end-record.work" });
        await DBOS.setEvent(RUN_END_EVENT_KEY, RECORDED);
    },
    { name: "run-end-record-sets-event" },
);

const recordsNothing = DBOS.registerWorkflow(
    async (): Promise<void> => {
        await DBOS.runStep(() => Promise.resolve(undefined), { name: "run-end-record.work" });
    },
    { name: "run-end-record-sets-nothing" },
);

type ObservedAttempt = {
    readonly currentAttempt: number | undefined;
    readonly maxAttempts: number | undefined;
};
const observedAttempts: ObservedAttempt[] = [];

const retriesAStep = DBOS.registerWorkflow(
    async (): Promise<void> => {
        await DBOS.runStep(
            () => {
                observedAttempts.push({ currentAttempt: DBOS.stepStatus?.currentAttempt, maxAttempts: DBOS.stepStatus?.maxAttempts });
                if (observedAttempts.length < 2) return Promise.reject(new Error("attempt failed"));
                return Promise.resolve();
            },
            { name: "run-end-record.retried", retriesAllowed: true, maxAttempts: 2, intervalSeconds: 0.05, backoffRate: 1 },
        );
    },
    { name: "run-end-record-retries-a-step" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("run_end_record");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

function productionCanceler(closes: string[], revokes: string[]) {
    const runCharge: RunCharge = {
        open: () => {
            throw new Error("open is not reached by the canceler");
        },
        close: ({ runId }) => {
            closes.push(runId);
            return okAsync(undefined);
        },
    };
    const runAuthorizer: RunAuthorizer = {
        authorize: () => {
            throw new Error("authorize is not reached by the canceler");
        },
        revoke: () => {
            throw new Error("revoke is not reached by the canceler");
        },
        revokeByMandateId: ({ mandateId }) => {
            revokes.push(mandateId);
            return okAsync(undefined);
        },
        suspend: () => okAsync(undefined),
        renew: () => okAsync(undefined),
    };
    return createRunCanceler({ pool: rig.pool, runCharge, runAuthorizer, logger: silentLogger });
}

describe("the recorded run end across the engine", () => {
    it("a canceler with the production read repairs the row from the event of a workflow", async () => {
        const runId = rig.nextWorkflowId("run-end-");
        (await insertRun(rig.pool, { runId, analysisId: "analysis-1", workflowName: "executeAnalysis", mandateId: "jti-1" }))._unsafeUnwrap();
        const handle = await DBOS.startWorkflow(recordsRunEnd, { workflowID: runId })();
        await handle.getResult();
        const closes: string[] = [];
        const revokes: string[] = [];

        const result = await productionCanceler(closes, revokes).cancel(runId, session);

        const row = (await queryRun(rig.pool, runId))._unsafeUnwrap();
        expect(row?.status).toBe("failed");
        expect(row?.error).toBe("synthesis failed");
        expect(result.finalStatus).toBe("failed");
        expect(result.converged).toEqual({ steps: true, charge: true, mandate: false });
        expect(closes).toEqual([]);
        expect(revokes).toEqual([]);
    });

    it("the read for a workflow with no such event gives null at once, and the canceler then owns the run end", async () => {
        const runId = rig.nextWorkflowId("run-no-event-");
        (await insertRun(rig.pool, { runId, analysisId: "analysis-1", workflowName: "executeAnalysis", mandateId: "jti-2" }))._unsafeUnwrap();
        const handle = await DBOS.startWorkflow(recordsNothing, { workflowID: runId })();
        await handle.getResult();

        const startedAt = Date.now();
        const event = await (await dbosClientFor(rig.pool, silentLogger)).getEvent<unknown>(runId, RUN_END_EVENT_KEY, 0);
        expect(event).toBeNull();
        expect(Date.now() - startedAt).toBeLessThan(1000);

        const closes: string[] = [];
        const revokes: string[] = [];
        const result = await productionCanceler(closes, revokes).cancel(runId, session);

        const row = (await queryRun(rig.pool, runId))._unsafeUnwrap();
        expect(row?.status).toBe("canceled");
        expect(row?.error).toBe("external_cancel");
        expect(result.converged).toEqual({ steps: true, charge: true, mandate: true });
        expect(closes).toEqual([runId]);
        expect(revokes).toEqual(["jti-2"]);
    });

    it("the read for an id with no workflow row gives null", async () => {
        const event = await (await dbosClientFor(rig.pool, silentLogger)).getEvent<unknown>(rig.nextWorkflowId("run-orphan-"), RUN_END_EVENT_KEY, 0);

        expect(event).toBeNull();
    });
});

describe("the attempt of a retried step", () => {
    it("equals the maximum on the last attempt", async () => {
        observedAttempts.length = 0;
        const handle = await DBOS.startWorkflow(retriesAStep, { workflowID: rig.nextWorkflowId("run-end-retry-") })();
        await handle.getResult();

        expect(observedAttempts).toEqual([
            { currentAttempt: 1, maxAttempts: 2 },
            { currentAttempt: 2, maxAttempts: 2 },
        ]);
    });
});
