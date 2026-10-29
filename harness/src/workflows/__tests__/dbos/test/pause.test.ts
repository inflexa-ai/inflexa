/**
 * The pause of durable work (work-pause spec), with the loop inside a DBOS workflow.
 *
 * The workflow runs the loop over a scripted model, with the pause of a run. A failed request with a cause of a
 * pause writes the row and the part of the pause, and the workflow waits in its body. A resume through the host
 * surface ends the wait, and the loop sends the request again. The tests read the row, the parts, and the requests
 * that the model got.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { errAsync, ok, okAsync } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { captureMetrics } from "../../../../__tests__/setup/metrics.js";
import { createLocalRunAuthorizer } from "../../../../auth/local-run-authorizer.js";
import { createWork } from "../../../../app/work.js";
import { makeLocalAuth } from "../../../../auth/local-auth-context.js";
import type { RunSession } from "../../../../auth/types.js";
import type { PausePart } from "../../../../contracts/chat-parts.js";
import type { RunAuthorizer } from "../../../../execution/run-authorizer.js";
import { CONTINUE_REQUEST, runLoop } from "../../../../loop/run-loop.js";
import { makeSession } from "../../../../providers/__fixtures__/session.js";
import { queryPausesOfWork, type PauseRecord } from "../../../../state/paused-work.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../../../testing.js";
import { defineTool } from "../../../../tools/define-tool.js";
import { workPause } from "../../../pause.js";

/** The deps of a work surface in this file: a local run authorizer, and the stops that a test does not reach. */
const WORK_DEPS = {
    runAuthorizer: createLocalRunAuthorizer(),
    stopTurn: () => Promise.reject(new Error("no turn stops in this file")),
    runCanceler: { cancel: () => Promise.reject(new Error("no run stops in this file")) },
    stopProfile: () => Promise.reject(new Error("no profile stops in this file")),
};

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS_ID = "a-pause";

const failure = (statusCode: number): { readonly fail: Error } => ({ fail: Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }) });

let toolRuns = 0;
const echo = defineTool({
    id: "echo",
    description: "Echo the text.",
    inputSchema: z.object({ text: z.string() }),
    describeCall: "none",
    execute: (input) => {
        toolRuns += 1;
        return Promise.resolve(ok({ echoed: input.text }));
    },
});

/** The values of one test: the script, the parts of the pause, and the timer. */
type Case = {
    readonly script: ReturnType<typeof scriptedModel>;
    readonly parts: PausePart[];
    readonly retryDelaysMs: readonly number[];
    readonly live: boolean;
    /** The run credential of the work, when the case pauses a run with one. */
    readonly run?: { readonly session: RunSession; readonly authorizer: RunAuthorizer };
};

const cases = new Map<string, Case>();
let pool: Pool;

const pausingLoop = DBOS.registerWorkflow(
    async (workId: string): Promise<{ reason: string; text: string }> => {
        const current = cases.get(workId);
        if (current === undefined) throw new Error(`no case for ${workId}`);
        const pause = workPause({
            pool,
            workId,
            workKind: "run",
            analysisId: ANALYSIS_ID,
            emit: (part) => {
                current.parts.push(part);
                return Promise.resolve();
            },
            retryDelaysMs: current.retryDelaysMs,
            run: current.run,
        });
        const result = await runLoop(
            { id: "pause-agent", systemPrompt: "Test.", model: "scripted-model", tools: [echo], maxIterations: 5 },
            [{ role: "user", content: "go" }],
            makeSession({ agentId: "pause-agent", callPath: ["pause-agent"] }),
            {
                provider: current.script.provider,
                emit: () => undefined,
                signal: new AbortController().signal,
                pause: pause.afterFailure,
                onText: current.live ? () => undefined : undefined,
            },
        );
        const last = result.messages.at(-1);
        return {
            reason: result.finish.reason,
            text: last?.role === "assistant" && typeof last.content !== "string" ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "",
        };
    },
    { name: "pause-loop" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("work_pause");
    pool = rig.pool;
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

const session = { identity: { user: "u-1" }, scope: { kind: "analysis" as const, analysisId: ANALYSIS_ID }, auth: makeLocalAuth() };

function start(
    script: readonly ScriptStep[],
    options: { readonly retryDelaysMs?: readonly number[]; readonly live?: boolean; readonly authorizer?: RunAuthorizer } = {},
): { workId: string; current: Case } {
    const workId = rig.nextWorkflowId("pause-");
    const run = options.authorizer === undefined ? undefined : { session: runSessionOf(workId), authorizer: options.authorizer };
    const current: Case = { script: scriptedModel(script), parts: [], retryDelaysMs: options.retryDelaysMs ?? [], live: options.live === true, run };
    cases.set(workId, current);
    return { workId, current };
}

async function waitForPause(workId: string, state: "retrying" | "paused", timeoutMs = 15_000): Promise<PauseRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const rows = (await queryPausesOfWork(pool, ANALYSIS_ID, workId))._unsafeUnwrap();
        const row = rows.find((candidate) => candidate.state === state);
        if (row !== undefined) return row;
        if (Date.now() > deadline) throw new Error(`timed out: the ${state} pause of ${workId}`);
        await sleep(25);
    }
}

describe("the pause of a loop inside a workflow", () => {
    it("waits on a suspend error, and a resume sends the same request again", async () => {
        toolRuns = 0;
        const { workId, current } = start([callTools(toolCall("c1", "echo", { text: "hi" })), failure(402), reply([text("done")])]);
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);

        const row = await waitForPause(workId, "paused");
        expect(row).toMatchObject({ workflowId: workId, workKind: "run", state: "paused", cause: { kind: "host", reason: "payment_required" }, attempt: 0 });
        expect(current.parts.at(-1)).toMatchObject({
            type: "data-pause",
            id: workId,
            workId,
            state: "paused",
            cause: { kind: "host", reason: "payment_required" },
        });

        const resumed = await createWork({ pool, ...WORK_DEPS }).resume(session, workId);
        expect(resumed).toEqual({ kind: "resumed", workflows: 1 });

        expect(await handle.getResult()).toEqual({ reason: "stop", text: "done" });
        expect(toolRuns).toBe(1);
        const calls = current.script.calls;
        expect(calls).toHaveLength(3);
        expect(calls[2]?.prompt).toEqual(calls[1]?.prompt);
        expect((await queryPausesOfWork(pool, ANALYSIS_ID, workId))._unsafeUnwrap()).toEqual([]);
        expect(current.parts.at(-1)).toEqual({ type: "data-pause", id: workId, workId, workKind: "run", state: "running" });
    });

    it("counts the body as paused in this process while it waits, and not after the resume", async () => {
        const capture = captureMetrics();
        const pausedRuns = async (): Promise<number> =>
            (await capture.sums("cortex.work.paused")).find(([attributes]) => attributes.work_kind === "run")?.[1] ?? 0;
        try {
            const before = await pausedRuns();
            const { workId } = start([failure(402), reply([text("done")])]);
            const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
            await waitForPause(workId, "paused");
            const during = await pausedRuns();

            await createWork({ pool, ...WORK_DEPS }).resume(session, workId);
            await handle.getResult();
            const after = await pausedRuns();

            expect({ during: during - before, after: after - before }).toEqual({ during: 1, after: 0 });
        } finally {
            await capture.dispose();
        }
    });

    it("retries an outage on its timer, and waits in paused after the last delay", async () => {
        const { workId, current } = start([failure(503), failure(503), reply([text("back")])], { retryDelaysMs: [1_000] });
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);

        const row = await waitForPause(workId, "paused");
        expect(row).toMatchObject({ state: "paused", cause: { kind: "outage" }, attempt: 1 });
        const retrying = current.parts.find((part) => part.state === "retrying");
        expect(retrying).toMatchObject({ cause: { kind: "outage" }, attempt: 0 });
        expect(typeof retrying?.retryAt).toBe("string");
        expect(current.script.calls).toHaveLength(2);

        await createWork({ pool, ...WORK_DEPS }).resume(session, workId);
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "back" });
        expect(current.script.calls).toHaveLength(3);
    });

    it("moves a wait in retrying to paused on a hold, and the timer no longer retries", async () => {
        const { workId, current } = start([failure(503), reply([text("held, then resumed")])], { retryDelaysMs: [60_000] });
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        await waitForPause(workId, "retrying");

        expect(await createWork({ pool, ...WORK_DEPS }).hold(session, workId)).toEqual({ kind: "held", workflows: 1 });

        const row = await waitForPause(workId, "paused");
        expect(row).toMatchObject({ state: "paused", cause: { kind: "outage" }, attempt: 0 });
        expect(row.retryAt).toBeUndefined();
        expect(current.parts.map((part) => part.state)).toEqual(["retrying", "paused"]);
        expect(current.script.calls).toHaveLength(1);
        expect(await createWork({ pool, ...WORK_DEPS }).hold(session, workId)).toEqual({ kind: "held", workflows: 0 });

        await createWork({ pool, ...WORK_DEPS }).resume(session, workId);
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "held, then resumed" });
        expect(current.script.calls).toHaveLength(2);
    });

    it("keeps the deadline of a retry across a crash", async () => {
        const { workId } = start([failure(503), reply([text("on time")])], { retryDelaysMs: [4_000] });
        const first = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        const ended = first.getResult().catch(() => undefined);
        const row = await waitForPause(workId, "retrying");
        const retryAt = Date.parse(row.retryAt ?? "");

        await DBOS.cancelWorkflow(workId);
        await ended;
        const handle = await DBOS.resumeWorkflow<{ reason: string; text: string }>(workId);

        expect(await handle.getResult()).toEqual({ reason: "stop", text: "on time" });
        // A deadline that the recovery made again would put the retry one whole delay after the resume.
        expect(Date.now()).toBeLessThan(retryAt + 2_500);
    }, 30_000);

    it("keeps a partial reply as an interrupted reply, and asks the model to continue it", async () => {
        const { workId, current } = start(
            [{ breakAfter: [text("Half of the ")], error: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }, reply([text("answer.")])],
            {
                live: true,
            },
        );
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);

        await waitForPause(workId, "paused");
        await createWork({ pool, ...WORK_DEPS }).resume(session, workId);

        expect(await handle.getResult()).toEqual({ reason: "stop", text: "answer." });
        const prompt = JSON.stringify(current.script.calls[1]?.prompt);
        expect(prompt).toContain("Half of the ");
        expect(prompt).toContain(CONTINUE_REQUEST.slice(1, 40));
    });

    it("returns to the same wait after a crash, and sends no request again", async () => {
        const { workId, current } = start([failure(402), reply([text("after the crash")])]);
        const first = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        const ended = first.getResult().catch(() => undefined);
        await waitForPause(workId, "paused");

        await DBOS.cancelWorkflow(workId);
        // The cancelled execution leaves its wait at the next cancel check of its `recv`.
        await ended;
        const handle = await DBOS.resumeWorkflow<{ reason: string; text: string }>(workId);
        const row = await waitForPause(workId, "paused");
        expect(row.cause).toEqual({ kind: "host", reason: "payment_required" });
        expect(current.script.calls).toHaveLength(1);

        await createWork({ pool, ...WORK_DEPS }).resume(session, workId);
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "after the crash" });
        expect(current.script.calls).toHaveLength(2);
    }, 30_000);
});

describe("the paused work of an analysis", () => {
    it("lists a waiting workflow, skips a row of an ended one, and refuses a different analysis", async () => {
        const { workId } = start([failure(402), reply([text("ok")])]);
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        await waitForPause(workId, "paused");
        await pool.query(
            `INSERT INTO cortex_paused_work (workflow_id, work_id, work_kind, analysis_id, state, cause, attempt, topic, paused_at)
             VALUES ('wf-ended', 'work-ended', 'run', $1, 'paused', '{"kind":"outage"}', 0, 'pause:x', NOW())`,
            [ANALYSIS_ID],
        );

        const surface = createWork({ pool, ...WORK_DEPS });
        const listed = await surface.list(ANALYSIS_ID);
        expect(listed.map((work) => work.workId)).toContain(workId);
        expect(listed.map((work) => work.workId)).not.toContain("work-ended");
        const { rows } = await pool.query("SELECT 1 FROM cortex_paused_work WHERE workflow_id = 'wf-ended'");
        expect(rows).toHaveLength(0);

        const elsewhere = { ...session, scope: { kind: "analysis" as const, analysisId: "a-other" } };
        expect(await surface.resume(elsewhere, workId)).toEqual({ kind: "not_found" });
        expect(await surface.resume(session, workId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();
    });

    it("sends one message for two resumes of one pause, and the message does not end a later pause", async () => {
        const { workId, current } = start([failure(402), failure(402), reply([text("third time")])]);
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        const first = await waitForPause(workId, "paused");

        const surface = createWork({ pool, ...WORK_DEPS });
        await Promise.all([surface.resume(session, workId), surface.resume(session, workId)]);
        await waitFor(() => current.script.calls.length === 2);
        const second = await waitForPause(workId, "paused");
        expect(second.topic).not.toBe(first.topic);
        // A second message of the first resume would end the second pause within a poll of its `recv`.
        await sleep(500);
        expect((await queryPausesOfWork(pool, ANALYSIS_ID, workId))._unsafeUnwrap()).toMatchObject([{ topic: second.topic }]);
        expect(current.script.calls).toHaveLength(2);

        await surface.resume(session, workId);
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "third time" });
    });
});

function runSessionOf(runId: string): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId: ANALYSIS_ID },
        provenance: { agentId: "pause-agent", callPath: ["pause-agent"] },
        runFrame: { runId },
        auth: makeLocalAuth(),
    };
}

/** A run authorizer that records each suspend and renew, and refuses a renewal while `refusal` is set. */
function recordingAuthorizer(): RunAuthorizer & { suspended: string[]; renewed: string[]; refusal?: string } {
    const recording: RunAuthorizer & { suspended: string[]; renewed: string[]; refusal?: string } = {
        ...createLocalRunAuthorizer(),
        suspended: [],
        renewed: [],
        suspend: (runSession, reason) => {
            recording.suspended.push(`${runSession.runFrame.runId}:${reason}`);
            return okAsync(undefined);
        },
        renew: (runSession) => {
            if (recording.refusal !== undefined) return errAsync({ reason: recording.refusal, suspend: false });
            recording.renewed.push(runSession.runFrame.runId);
            return okAsync(undefined);
        },
    };
    return recording;
}

describe("the run credential of paused work", () => {
    it("suspends the credential at a pause for a person, keeps the run session on the row, and renews it at the resume", async () => {
        const authorizer = recordingAuthorizer();
        const { workId } = start([failure(402), reply([text("renewed")])], { authorizer });
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);

        const row = await waitForPause(workId, "paused");
        expect(row.runSession).toEqual(runSessionOf(workId));
        await waitFor(() => authorizer.suspended.length === 1);
        expect(authorizer.suspended).toEqual([`${workId}:paused:host`]);

        expect(await createWork({ pool, ...WORK_DEPS, runAuthorizer: authorizer }).resume(session, workId)).toEqual({ kind: "resumed", workflows: 1 });
        expect(authorizer.renewed).toEqual([workId]);
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "renewed" });
    });

    it("suspends a wait that a person holds, and renews it at the resume", async () => {
        const authorizer = recordingAuthorizer();
        const { workId } = start([failure(503), reply([text("held and renewed")])], { retryDelaysMs: [60_000], authorizer });
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        await waitForPause(workId, "retrying");
        expect(authorizer.suspended).toEqual([]);

        const surface = createWork({ pool, ...WORK_DEPS, runAuthorizer: authorizer });
        expect(await surface.hold(session, workId)).toEqual({ kind: "held", workflows: 1 });
        const row = await waitForPause(workId, "paused");
        expect(row.runSession).toEqual(runSessionOf(workId));
        await waitFor(() => authorizer.suspended.length === 1);
        expect(authorizer.suspended).toEqual([`${workId}:paused:outage`]);

        expect(await surface.resume(session, workId)).toEqual({ kind: "resumed", workflows: 1 });
        expect(authorizer.renewed).toEqual([workId]);
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "held and renewed" });
    });

    it("does not suspend a wait that the timer ends", async () => {
        const authorizer = recordingAuthorizer();
        const { workId } = start([failure(503), reply([text("on the timer")])], { retryDelaysMs: [500], authorizer });
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);

        expect(await handle.getResult()).toEqual({ reason: "stop", text: "on the timer" });
        expect(authorizer.suspended).toEqual([]);
    });

    it("keeps the work paused when the host refuses the renewal, and sends no resume", async () => {
        const authorizer = recordingAuthorizer();
        authorizer.refusal = "only the subject can renew";
        const { workId, current } = start([failure(402), reply([text("after the refusal")])], { authorizer });
        const handle = await DBOS.startWorkflow(pausingLoop, { workflowID: workId })(workId);
        await waitForPause(workId, "paused");

        const surface = createWork({ pool, ...WORK_DEPS, runAuthorizer: authorizer });
        expect(await surface.resume(session, workId)).toEqual({ kind: "refused", reason: "only the subject can renew" });
        // A sent resume would end the wait within a poll of its `recv`.
        await sleep(500);
        expect((await queryPausesOfWork(pool, ANALYSIS_ID, workId))._unsafeUnwrap()).toHaveLength(1);
        expect(current.script.calls).toHaveLength(1);

        authorizer.refusal = undefined;
        expect(await surface.resume(session, workId)).toEqual({ kind: "resumed", workflows: 1 });
        expect(await handle.getResult()).toEqual({ reason: "stop", text: "after the refusal" });
    });
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("the condition did not hold in time");
        await sleep(25);
    }
}
