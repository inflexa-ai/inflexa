/**
 * The list of the active work across analyses (work-pause spec), over workflows that wait in a pause.
 *
 * Each workflow here waits in the pause primitive with the waiter and the work that its test names. A resume through
 * the work surface ends the wait, and the tests read what `list` gives before and after.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";

import { DBOS } from "@dbos-inc/dbos-sdk";

import { countingQuerier } from "../../__tests__/setup/counting-querier.js";
import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import type { PauseWaiter, WorkKind } from "../../contracts/chat-parts.js";
import { createThreadStore } from "../../memory/thread-store.js";
import { claimThreadForTurn } from "../../state/active-turns.js";
import { insertRun } from "../../state/runs.js";
import { upsertAnalysis } from "../../state/analyses.js";
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
    readonly userId?: string;
};

const waiting = DBOS.registerWorkflow(
    async (spec: Waiting): Promise<string | undefined> => {
        const pause = workPause({ pool: rig.pool, ...spec, userId: spec.userId ?? null, emit: () => Promise.resolve() });
        return await pause.forCause({ kind: "host", reason: "payment_required" }, 0);
    },
    { name: "work-list-waiting" },
);

/** A workflow that runs until a message releases it: an active turn or an active profile for a test. */
const parked = DBOS.registerWorkflow(
    async (): Promise<void> => {
        await DBOS.recv("release", 60);
    },
    { name: "work-list-parked" },
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

describe("the person of each work, and the active work of a list of analyses", () => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function park(workflowId: string): Promise<void> {
        const handle = await DBOS.startWorkflow(parked, { workflowID: workflowId })();
        cleanups.push(async () => {
            await DBOS.send(workflowId, "go", "release");
            await handle.getResult();
        });
    }

    /** A turn that holds the claim of a new thread, with an active workflow. */
    async function runningTurn(analysisId: string, userId: string | null): Promise<{ turnId: string; threadId: string }> {
        const turnId = rig.nextWorkflowId("turn-");
        const threadId = `thread-${turnId}`;
        (await createThreadStore(rig.pool).createThread({ threadId, analysisId }))._unsafeUnwrap();
        expect((await claimThreadForTurn(rig.pool, threadId, turnId, userId, () => Promise.resolve(false)))._unsafeUnwrap()).toEqual({ kind: "claimed" });
        await park(turnId);
        return { turnId, threadId };
    }

    async function runningRun(analysisId: string, userId: string | null, startedAt?: string): Promise<string> {
        const runId = rig.nextWorkflowId("run-");
        (await insertRun(rig.pool, { runId, analysisId, workflowName: "executeAnalysis", userId, startedAt }))._unsafeUnwrap();
        return runId;
    }

    /** A profile that runs with an active workflow. */
    async function runningProfile(analysisId: string, userId: string | null): Promise<string> {
        const workflowId = rig.nextWorkflowId("profile-");
        (await upsertAnalysis(rig.pool, analysisId, null))._unsafeUnwrap();
        await rig.pool.query(
            "UPDATE cortex_analysis_state SET data_profile_status = 'running', data_profile_workflow_id = $2, data_profile_user_id = $3 WHERE analysis_id = $1",
            [analysisId, workflowId, userId],
        );
        await park(workflowId);
        return workflowId;
    }

    /** Start a waiting workflow of a work. A resume of the work at the end of the test ends the wait. */
    async function startPause(spec: Waiting): Promise<string> {
        const workflowId = await startWaiting(spec);
        cleanups.push(async () => {
            await work.resume(sessionOf(spec.analysisId), spec.workId);
            await DBOS.retrieveWorkflow(workflowId).getResult();
        });
        await waitForPauseRow(workflowId);
        return workflowId;
    }

    async function waitForPauseRow(workflowId: string): Promise<void> {
        const deadline = Date.now() + 15_000;
        for (;;) {
            const { rows } = await rig.pool.query("SELECT 1 FROM cortex_paused_work WHERE workflow_id = $1", [workflowId]);
            if (rows.length > 0) return;
            if (Date.now() > deadline) throw new Error(`the pause row of ${workflowId} did not appear`);
            await Bun.sleep(25);
        }
    }

    describe("Work.userId", () => {
        it("names the person of a running turn from its claim", async () => {
            const { turnId, threadId } = await runningTurn("a-user-turn", "u1");

            expect(await work.list("a-user-turn")).toEqual([{ workId: turnId, kind: "turn", analysisId: "a-user-turn", threadId, userId: "u1", waiting: [] }]);
        });

        it("names the person of a running profile from its row", async () => {
            const workflowId = await runningProfile("a-user-profile", "u1");

            expect(await work.list("a-user-profile")).toEqual([
                { workId: workflowId, kind: "profile", analysisId: "a-user-profile", threadId: undefined, userId: "u1", waiting: [] },
            ]);
        });

        it("names the person of a running run from its row, and gives null for a row with no person", async () => {
            (await upsertAnalysis(rig.pool, "a-user-run", null))._unsafeUnwrap();
            const named = await runningRun("a-user-run", "u1", "2026-10-02T10:00:00.000Z");
            const old = await runningRun("a-user-run", null, "2026-10-01T10:00:00.000Z");

            const listed = await work.list("a-user-run");

            expect(Object.fromEntries(listed.map((item) => [item.workId, item.userId]))).toEqual({ [named]: "u1", [old]: null });
        });

        it("gives null for a turn whose claim has no person", async () => {
            const { turnId } = await runningTurn("a-user-null-turn", null);

            expect((await work.list("a-user-null-turn")).map((item) => [item.workId, item.userId])).toEqual([[turnId, null]]);
        });

        it("takes the person of its pause rows for a work that only they name", async () => {
            const workId = rig.nextWorkflowId("run-rows-");
            await startPause({ workId, workKind: "run", waiter: { kind: "step", stepId: "s1" }, analysisId: "a-user-rows", userId: "u1" });

            expect((await work.list("a-user-rows")).map((item) => [item.workId, item.userId])).toEqual([[workId, "u1"]]);
        });
    });

    describe("listByAnalyses", () => {
        it("gives the paused work of one person across analyses, each with its waiting workflow, and not the run of another person", async () => {
            const { turnId, threadId } = await runningTurn("a-by-1", "u1");
            const turnWait = await startPause({ workId: turnId, workKind: "turn", waiter: { kind: "turn" }, analysisId: "a-by-1", threadId, userId: "u1" });
            const otherRun = await runningRun("a-by-1", "u2");
            const profileId = await runningProfile("a-by-2", "u1");
            const profileWait = await startPause({ workId: profileId, workKind: "profile", waiter: { kind: "run" }, analysisId: "a-by-2", userId: "u1" });

            const items = await work.listByAnalyses({ analysisIds: ["a-by-1", "a-by-2"], userId: "u1", limit: 10 });

            expect(items.map((item) => item.workId)).toEqual([turnId, profileId]);
            expect(items.map((item) => item.waiting.map((workflow) => workflow.workflowId))).toEqual([[turnWait], [profileWait]]);
            expect(items[0]).toMatchObject({ kind: "turn", analysisId: "a-by-1", threadId, userId: "u1" });
            expect(items[1]).toMatchObject({ kind: "profile", analysisId: "a-by-2", userId: "u1" });
            expect(items.map((item) => item.workId)).not.toContain(otherRun);
        });

        it("gives no work of an analysis outside the list", async () => {
            (await upsertAnalysis(rig.pool, "a-out-3", null))._unsafeUnwrap();
            await runningRun("a-out-3", "u1");

            expect(await work.listByAnalyses({ analysisIds: ["a-out-1"], userId: "u1", limit: 10 })).toEqual([]);
        });

        it("bounds the result with the limit and gives the runs with the newest start, and clamps the limit to 1 to 200", async () => {
            const oldest = await runningRun("a-limit", "u1", "2026-10-01T10:00:00.000Z");
            const middle = await runningRun("a-limit", "u1", "2026-10-02T10:00:00.000Z");
            const newest = await runningRun("a-limit", "u1", "2026-10-03T10:00:00.000Z");

            const limited = await work.listByAnalyses({ analysisIds: ["a-limit"], userId: "u1", limit: 2 });

            expect(limited.map((item) => item.workId)).toEqual([newest, middle]);
            expect(await work.listByAnalyses({ analysisIds: ["a-limit"], limit: 0 })).toHaveLength(1);
            expect(await work.listByAnalyses({ analysisIds: ["a-limit"], limit: -3 })).toHaveLength(1);
            expect((await work.listByAnalyses({ analysisIds: ["a-limit"], limit: 1000 })).map((item) => item.workId)).toEqual([newest, middle, oldest]);
        });

        it("never matches a work with no person to a user id, and narrows nothing without one", async () => {
            const named = await runningRun("a-nobody", "u1");
            const nobody = await runningRun("a-nobody", null);

            expect((await work.listByAnalyses({ analysisIds: ["a-nobody"], userId: "u1", limit: 10 })).map((item) => item.workId)).toEqual([named]);
            expect((await work.listByAnalyses({ analysisIds: ["a-nobody"], limit: 10 })).map((item) => item.workId).sort()).toEqual([named, nobody].sort());
        });

        it("orders the waiting work first with the oldest pause first, then the runs newest first, then the turns and profiles by work id", async () => {
            const waitingNew = rig.nextWorkflowId("run-wait-new-");
            const waitingOld = rig.nextWorkflowId("run-wait-old-");
            await startPause({ workId: waitingOld, workKind: "run", waiter: { kind: "run" }, analysisId: "a-order", userId: "u1" });
            await Bun.sleep(20);
            await startPause({ workId: waitingNew, workKind: "run", waiter: { kind: "run" }, analysisId: "a-order", userId: "u1" });
            const olderRun = await runningRun("a-order", "u1", "2026-10-01T10:00:00.000Z");
            const newerRun = await runningRun("a-order", "u1", "2026-10-02T10:00:00.000Z");
            const turnA = (await runningTurn("a-order", "u1")).turnId;
            const profile = await runningProfile("a-order", "u1");

            const items = await work.listByAnalyses({ analysisIds: ["a-order"], limit: 20 });

            const quiet = [turnA, profile].sort();
            expect(items.map((item) => item.workId)).toEqual([waitingOld, waitingNew, newerRun, olderRun, ...quiet]);
        });

        it("leaves out a turn whose workflow ended and deletes the row of its ended pause", async () => {
            const turnId = rig.nextWorkflowId("turn-ended-");
            const threadId = `thread-${turnId}`;
            (await createThreadStore(rig.pool).createThread({ threadId, analysisId: "a-ended" }))._unsafeUnwrap();
            expect((await claimThreadForTurn(rig.pool, threadId, turnId, "u1", () => Promise.resolve(false)))._unsafeUnwrap()).toEqual({ kind: "claimed" });
            const workflowId = rig.nextWorkflowId("turn-wait-ended-");
            await DBOS.startWorkflow(waiting, { workflowID: workflowId })({
                workId: turnId,
                workKind: "turn",
                waiter: { kind: "turn" },
                analysisId: "a-ended",
                threadId,
                userId: "u1",
            });
            await waitForPauseRow(workflowId);
            await DBOS.cancelWorkflow(workflowId);

            const items = await work.listByAnalyses({ analysisIds: ["a-ended"], limit: 10 });

            expect(items).toEqual([]);
            const { rows } = await rig.pool.query("SELECT 1 FROM cortex_paused_work WHERE workflow_id = $1", [workflowId]);
            expect(rows).toHaveLength(0);
        });

        it("does not move a run up with the row of an ended pause", async () => {
            const older = await runningRun("a-stale", "u1", "2026-10-01T10:00:00.000Z");
            const newer = await runningRun("a-stale", "u1", "2026-10-02T10:00:00.000Z");
            const workflowId = rig.nextWorkflowId("run-wait-ended-");
            await DBOS.startWorkflow(waiting, { workflowID: workflowId })({
                workId: older,
                workKind: "run",
                waiter: { kind: "run" },
                analysisId: "a-stale",
                userId: "u1",
            });
            await waitForPauseRow(workflowId);
            await DBOS.cancelWorkflow(workflowId);

            const items = await work.listByAnalyses({ analysisIds: ["a-stale"], limit: 2 });

            expect(items.map((item) => ({ workId: item.workId, waiting: item.waiting }))).toEqual([
                { workId: newer, waiting: [] },
                { workId: older, waiting: [] },
            ]);
            const { rows } = await rig.pool.query("SELECT 1 FROM cortex_paused_work WHERE workflow_id = $1", [workflowId]);
            expect(rows).toHaveLength(0);
        });

        it("sends one app query and one DBOS status read for a list of 20 analyses, and none for an empty list", async () => {
            const ids = Array.from({ length: 20 }, (_, index) => `a-many-${index}`);
            const runIds: string[] = [];
            for (const id of ids) {
                (await upsertAnalysis(rig.pool, id, null))._unsafeUnwrap();
                runIds.push(await runningRun(id, "u1"));
                const threadId = `thread-${id}`;
                (await createThreadStore(rig.pool).createThread({ threadId, analysisId: id }))._unsafeUnwrap();
                (await claimThreadForTurn(rig.pool, threadId, `turn-claim-${id}`, "u1", () => Promise.resolve(false)))._unsafeUnwrap();
            }
            const counted = countingQuerier(rig.pool);
            const surface = createWork({
                pool: counted.querier,
                runAuthorizer: createLocalRunAuthorizer(),
                stopTurn: () => Promise.reject(new Error("no turn stops in this file")),
                runCanceler: { cancel: () => Promise.reject(new Error("no run stops in this file")) },
                stopProfile: () => Promise.reject(new Error("no profile stops in this file")),
            });
            const statusRead = spyOn(DBOS, "listWorkflows");
            try {
                const items = await surface.listByAnalyses({ analysisIds: ids, userId: "u1", limit: 50 });

                expect(items.map((item) => item.workId).sort()).toEqual([...runIds].sort());
                expect(counted.calls()).toBe(1);
                expect(statusRead).toHaveBeenCalledTimes(1);

                expect(await surface.listByAnalyses({ analysisIds: [], limit: 50 })).toEqual([]);
                expect(counted.calls()).toBe(1);
                expect(statusRead).toHaveBeenCalledTimes(1);
            } finally {
                statusRead.mockRestore();
            }
        });

        it("keeps the behavior of list for the same analysis", async () => {
            const { turnId } = await runningTurn("a-same", "u1");
            const runId = await runningRun("a-same", "u1");

            const listed = await work.list("a-same");
            const byAnalyses = await work.listByAnalyses({ analysisIds: ["a-same"], limit: 10 });

            expect(byAnalyses.map((item) => item.workId).sort()).toEqual([turnId, runId].sort());
            expect([...byAnalyses].sort((a, b) => a.workId.localeCompare(b.workId))).toEqual([...listed].sort((a, b) => a.workId.localeCompare(b.workId)));
        });
    });
});
