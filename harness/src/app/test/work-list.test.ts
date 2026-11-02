/**
 * The list of the active work across analyses (work-pause spec), over workflows that wait in a pause.
 *
 * Each workflow here waits in the pause primitive with the waiter and the work that its test names. A resume through
 * the work surface ends the wait, and the tests read what `list` gives before and after.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { DBOS } from "@dbos-inc/dbos-sdk";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { PauseWaiter, WorkKind } from "../../contracts/chat-parts.js";
import { workPause } from "../../workflows/pause.js";
import { createWork, type Work } from "../work.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

type Waiting = {
    readonly workId: string;
    readonly workKind: WorkKind;
    readonly waiter: PauseWaiter;
    readonly analysisId: string;
    readonly threadId?: string;
};

const waiting = DBOS.registerWorkflow(
    async (spec: Waiting): Promise<string | undefined> => {
        const pause = workPause({ pool: rig.pool, ...spec, emit: () => Promise.resolve() });
        return await pause.forCause({ kind: "host", reason: "payment_required" }, 0);
    },
    { name: "work-list-waiting" },
);

let rig: DbosTestRig;

const work = createWork({
    get pool() {
        return rig.pool;
    },
    runAuthorizer: createLocalRunAuthorizer(),
    stopTurn: () => Promise.reject(new Error("no turn stops in this file")),
    runCanceler: { cancel: () => Promise.reject(new Error("no run stops in this file")) },
    stopProfile: () => Promise.reject(new Error("no profile stops in this file")),
});

beforeAll(async () => {
    rig = await setupDbosForTests("work_list");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

function sessionOf(analysisId: string): Parameters<typeof work.resume>[0] {
    return { identity: { user: "u-1" }, scope: { kind: "analysis", analysisId }, auth: makeLocalAuth() };
}

async function startWaiting(spec: Waiting): Promise<string> {
    const workflowId = rig.nextWorkflowId("work-list-");
    await DBOS.startWorkflow(waiting, { workflowID: workflowId })(spec);
    return workflowId;
}

async function waitForWaiting(expected: number): Promise<Work[]> {
    const deadline = Date.now() + 15_000;
    for (;;) {
        const listed = await work.list();
        if (listed.flatMap((item) => item.waiting).length >= expected) return listed;
        if (Date.now() > deadline) throw new Error(`the list did not show ${expected} waiting workflows`);
        await Bun.sleep(25);
    }
}

describe("the list of the active work", () => {
    it("gives an empty list when no work is active", async () => {
        expect(await work.list()).toEqual([]);
        expect(await work.list("a-none")).toEqual([]);
    });

    it("gives the waiting turn of one analysis and the waiting run of another, each with its analysis id and its waiters", async () => {
        const turnId = rig.nextWorkflowId("turn-");
        const runId = rig.nextWorkflowId("run-");
        const turnWorkflow = await startWaiting({ workId: turnId, workKind: "turn", waiter: { kind: "turn" }, analysisId: "a-list-1", threadId: "thread-1" });
        const stepOne = await startWaiting({ workId: runId, workKind: "run", waiter: { kind: "step", stepId: "s1" }, analysisId: "a-list-2" });
        const stepTwo = await startWaiting({ workId: runId, workKind: "run", waiter: { kind: "step", stepId: "s2" }, analysisId: "a-list-2" });

        const all = await waitForWaiting(3);

        const turn = all.find((item) => item.workId === turnId);
        const run = all.find((item) => item.workId === runId);
        expect(all).toHaveLength(2);
        expect(turn).toMatchObject({ kind: "turn", analysisId: "a-list-1", threadId: "thread-1" });
        expect(turn?.waiting).toMatchObject([{ workflowId: turnWorkflow, waiter: { kind: "turn" }, state: "paused" }]);
        expect(run).toMatchObject({ kind: "run", analysisId: "a-list-2" });
        expect(Object.fromEntries(run?.waiting.map((workflow) => [workflow.workflowId, workflow.waiter]) ?? [])).toEqual({
            [stepOne]: { kind: "step", stepId: "s1" },
            [stepTwo]: { kind: "step", stepId: "s2" },
        });

        expect((await work.list("a-list-1")).map((item) => item.workId)).toEqual([turnId]);
        expect((await work.list("a-list-2")).map((item) => item.workId)).toEqual([runId]);
        expect(await work.list("a-list-3")).toEqual([]);

        expect(await work.resume(sessionOf("a-list-1"), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        expect(await work.resume(sessionOf("a-list-2"), runId)).toEqual({ kind: "resumed", workflows: 2 });
        await Promise.all([turnWorkflow, stepOne, stepTwo].map((id) => DBOS.retrieveWorkflow(id).getResult()));
        expect(await work.list()).toEqual([]);
    }, 30_000);

    it("omits the waiter of a wait whose row has none", async () => {
        const runId = rig.nextWorkflowId("run-old-");
        const workflowId = await startWaiting({ workId: runId, workKind: "run", waiter: { kind: "run" }, analysisId: "a-list-old" });
        await waitForWaiting(1);
        await rig.pool.query("UPDATE cortex_paused_work SET waiter = NULL WHERE workflow_id = $1", [workflowId]);

        const [item] = await work.list("a-list-old");

        expect(item?.waiting).toHaveLength(1);
        expect(item?.waiting[0]?.waiter).toBeUndefined();
        expect(await work.resume(sessionOf("a-list-old"), runId)).toEqual({ kind: "resumed", workflows: 1 });
        await DBOS.retrieveWorkflow(workflowId).getResult();
    }, 30_000);
});
