/**
 * The chat turn as a DBOS workflow: the open, the stream, the recovery from the checkpoints, a recovery with no
 * credential, the claim of a thread, the stop, the approval, and the sub-agents as child workflows.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { recoverAtCrashPoint } from "../../__tests__/setup/dbos-crash.js";
import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { forSubAgent, type AuthContext } from "../../auth/types.js";
import { createNoopUsageRecorder } from "../../billing/noop-usage-recorder.js";
import type { ChatFrame } from "../../contracts/chat-events.js";
import type { Connectable } from "../../lib/db-result.js";
import { finalText, runLoop } from "../../loop/run-loop.js";
import { registerSubAgent } from "../../loop/sub-agent.js";
import { turnCredentials } from "../../loop/turn-credentials.js";
import type { Querier } from "../../state/db.js";
import { createThreadHistory } from "../../memory/thread-history.js";
import { storedMessagesToChat } from "../../memory/conversation-display-replay.js";
import type { ChatProvider } from "../../providers/types.js";
import type { ThreadAgentResolver } from "../../runtime/assemble.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptEntry, type ScriptStep } from "../../testing.js";
import { createAskGateway } from "../../tools/approval/gateway.js";
import { defineTool } from "../../tools/define-tool.js";
import { workPause } from "../../workflows/pause.js";
import { registerChatTurns } from "../chat-turn-workflow.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import { createPausedWork, type PausedWork } from "../paused-work.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS = "analysis-wf";
const SECRET = "pass-secret-123";

let rig: DbosTestRig;
let provider: ChatProvider = scriptedModel([]).provider;
let toolRuns = 0;
let parkNextWrite = false;
let parkedWrite = false;
let credentialAfterRestart: AuthContext | undefined = makeLocalAuth();
let askWaitSeconds = 60;
let guardedRuns = 0;
let childProvider: ChatProvider = scriptedModel([]).provider;
let parkChildTool = false;
let childParked = false;
let childToolRuns = 0;
let researchCallsSettled = 0;

const echo = defineTool({
    id: "echo",
    description: "Echo the text.",
    inputSchema: z.object({ text: z.string() }),
    describeCall: (input) => `echo ${input.text}`,
    execute: (input) => {
        toolRuns += 1;
        return Promise.resolve(ok({ echoed: input.text }));
    },
});

/** A tool that asks the next write of the turn to park, thus the host stops after the tool step and before the round write. */
const crashAfter = defineTool({
    id: "crash_after",
    description: "Runs, then the host stops.",
    inputSchema: z.object({}),
    describeCall: "none",
    execute: () => {
        toolRuns += 1;
        parkNextWrite = true;
        return Promise.resolve(ok({ ran: true }));
    },
});

/** A tool that runs only after the user approves it. */
const guarded = defineTool({
    id: "guarded",
    description: "Runs after an approval.",
    inputSchema: z.object({}),
    describeCall: "none",
    approval: () => ({ title: "Run the script", command: "Rscript go.R" }),
    execute: () => {
        guardedRuns += 1;
        return Promise.resolve(ok({ ran: true }));
    },
});

/** A tool of the sub-agent. When the test asks, it hangs until the cancel of its step, as a crash cuts it. */
const childPark = defineTool({
    id: "child_park",
    description: "Runs in the sub-agent.",
    inputSchema: z.object({}),
    describeCall: "none",
    execute: async () => {
        childToolRuns += 1;
        if (parkChildTool) {
            parkChildTool = false;
            childParked = true;
            const cancel = DBOS.stepStatus?.cancelSignal;
            await new Promise<void>((resolve) => cancel?.addEventListener("abort", () => resolve(), { once: true }));
            throw new Error("the step was cut by the crash");
        }
        return ok({ ran: true });
    },
});

const RESEARCHER = "test-researcher";
const researcherAgent = { id: RESEARCHER, systemPrompt: "Research.", model: "scripted-model", tools: [childPark], maxIterations: 4 };

const researcher = registerSubAgent<{ readonly brief: string }, string>(RESEARCHER, async ({ payload, ctx, loop }) => {
    const { messages } = await runLoop(researcherAgent, [{ role: "user", content: payload.brief }], forSubAgent(ctx.session, RESEARCHER), {
        ...loop,
        provider: childProvider,
    });
    return finalText(messages);
});

const research = defineTool({
    id: "research",
    description: "Research a brief in a sub-agent.",
    inputSchema: z.object({ brief: z.string() }),
    describeCall: "none",
    startsWorkflow: true,
    execute: async (input, ctx) => {
        try {
            return ok({ report: await researcher(input, ctx) });
        } finally {
            researchCallsSettled += 1;
        }
    },
});

const PAUSING_RESEARCHER = "test-pausing-researcher";

/** A sub-agent that pauses with the work of its turn, as the assembly registers each sub-agent. */
const pausingResearcher = registerSubAgent<{ readonly brief: string }, string>(
    PAUSING_RESEARCHER,
    async ({ payload, ctx, loop }) => {
        const { messages } = await runLoop(
            { ...researcherAgent, id: PAUSING_RESEARCHER },
            [{ role: "user", content: payload.brief }],
            forSubAgent(ctx.session, PAUSING_RESEARCHER),
            { ...loop, provider: childProvider },
        );
        return finalText(messages);
    },
    (work, emit) => workPause({ pool: rig.pool, ...work, emit }).afterFailure,
);

const pausingResearch = defineTool({
    id: "pausing_research",
    description: "Research a brief in a sub-agent that can pause.",
    inputSchema: z.object({ brief: z.string() }),
    describeCall: "none",
    startsWorkflow: true,
    execute: async (input, ctx) => ok({ report: await pausingResearcher(input, ctx) }),
});

const agent = {
    id: "conversation-agent",
    systemPrompt: "Test.",
    model: "scripted-model",
    tools: [echo, crashAfter, guarded, research, pausingResearch],
    maxIterations: 6,
};

/**
 * The pool of the turn. A parked write waits for the cancel of its step, thus the cancel of the test cuts the step
 * before its checkpoint, as a crash does.
 */
function turnPool(): Querier & Connectable {
    return {
        query: (text, values) => rig.pool.query(text, values),
        async connect() {
            if (parkNextWrite) {
                parkNextWrite = false;
                parkedWrite = true;
                const cancel = DBOS.stepStatus?.cancelSignal;
                await new Promise<void>((resolve) => cancel?.addEventListener("abort", () => resolve(), { once: true }));
                throw new Error("the write was cut by the crash");
            }
            return rig.pool.connect();
        },
    };
}

const agents: ThreadAgentResolver = {
    forThread: (threadType) => (threadType === "conversation" ? ok(agent) : err({ type: "unregistered_thread_type", threadType })),
};

const turns = registerChatTurns({
    get pool() {
        return turnPool();
    },
    agents,
    get provider() {
        return provider;
    },
    usageRecorder: createNoopUsageRecorder(),
    credentialFor: () => credentialAfterRestart,
    get askGateway() {
        return createAskGateway({ pool: rig.pool });
    },
    get askWaitSeconds() {
        return askWaitSeconds;
    },
});

async function askOf(threadId: string): Promise<{ id: string; status: string } | undefined> {
    const { rows } = await rig.pool.query<{ id: string; status: string }>("SELECT id, status FROM cortex_asks WHERE thread_id = $1", [threadId]);
    return rows[0];
}

/** A session whose credential holds a secret, thus a test can look for it in the stored input. */
function sessionWithSecret() {
    return {
        identity: { user: "user-1" },
        scope: { kind: "analysis" as const, analysisId: ANALYSIS },
        auth: Object.assign(makeLocalAuth(), { token: SECRET }),
    };
}

async function readAll(turnId: string): Promise<ChatFrame[]> {
    const frames: ChatFrame[] = [];
    for await (const frame of turns.read(turnId)) frames.push(frame);
    return frames;
}

const textOf = (frames: readonly ChatFrame[]): string => frames.map((frame) => (frame.type === "text-delta" ? frame.text : "")).join("");

async function startTurn(threadId: string, userInput = "hello"): Promise<string> {
    const started = await turns.open(sessionWithSecret(), { analysisId: ANALYSIS, threadId, userInput });
    if (started.kind !== "started") throw new Error(`the turn did not start: ${started.kind}`);
    return started.turnId;
}

async function turnRecords(threadId: string): Promise<{ status: string; reason: string | null }[]> {
    const { rows } = await rig.pool.query<{ status: string; reason: string | null }>(
        "SELECT status, reason FROM cortex_thread_turns WHERE thread_id = $1 ORDER BY start_seq",
        [threadId],
    );
    return rows;
}

async function roles(threadId: string): Promise<string[]> {
    return (await createThreadHistory(rig.pool).loadRecent(threadId))._unsafeUnwrap().map((message) => message.role);
}

/** A model request that hangs until the cancel or the stop of its turn. */
function hanging(onHang: () => void): ScriptStep {
    return (call) => {
        onHang();
        return new Promise<ScriptEntry>((resolve) => {
            call.abortSignal?.addEventListener("abort", () => resolve({ fail: call.abortSignal?.reason }), { once: true });
        });
    };
}

beforeAll(async () => {
    rig = await setupDbosForTests("chat_turn_workflow");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

describe("a chat turn as a workflow", () => {
    it("streams the turn, stores it, and keeps the credential out of the stored input", async () => {
        provider = scriptedModel([callTools(toolCall("c1", "echo", { text: "a" })), reply([text("Hi there.")])]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const frames = await readAll(turnId);

        expect(textOf(frames)).toBe("Hi there.");
        expect(frames.filter((frame) => frame.type === "tool-finished")).toMatchObject([{ outcome: "ok", detail: "echo a" }]);
        expect(frames.at(-1)?.type).toBe("finish");
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        expect(await turns.outcome(turnId)).toMatchObject({ status: "done", opened: true, finishReason: "stop", fallbackText: "Hi there." });
        expect((await roles(threadId)).filter((role) => role !== "user")).toEqual(["assistant", "tool", "assistant"]);
        const status = await DBOS.getWorkflowStatus(turnId);
        expect(JSON.stringify(status?.input)).not.toContain(SECRET);
    });

    it("continues a crash after a tool step from the checkpoints, and the display of the round keeps the tool part", async () => {
        toolRuns = 0;
        parkedWrite = false;
        credentialAfterRestart = makeLocalAuth();
        const scripted = scriptedModel([callTools(toolCall("c1", "crash_after", {})), reply([text("Done after the crash.")])]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const ended = DBOS.retrieveWorkflow(turnId)
            .getResult()
            .catch(() => undefined);
        const handle = await recoverAtCrashPoint(turnId, () => parkedWrite, { ended });
        await handle.getResult();

        expect(toolRuns).toBe(1);
        expect(scripted.calls).toHaveLength(2);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        const stored = (await createThreadHistory(rig.pool).loadAll(threadId))._unsafeUnwrap();
        expect(JSON.stringify(stored)).toContain('"toolName":"crash_after"');
        expect(textOf(await readAll(turnId))).toBe("Done after the crash.");
    });

    it("pauses a recovered turn with no credential, and a resume with a credential continues it", async () => {
        toolRuns = 0;
        parkedWrite = false;
        credentialAfterRestart = undefined;
        const scripted = scriptedModel([callTools(toolCall("c1", "crash_after", {})), reply([text("after the resume")])]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        // The cancelled execution drops the live credential when it leaves, thus the resume finds none.
        const ended = Promise.all([
            DBOS.retrieveWorkflow(turnId)
                .getResult()
                .catch(() => undefined),
            waitUntil(() => turnCredentials.of(turnId) === undefined),
        ]);
        const handle = await recoverAtCrashPoint(turnId, () => parkedWrite, { ended });

        const paused = await pausedWorkOf(turnId);
        expect(paused).toMatchObject({ kind: "turn", threadId, waiting: [{ workflowId: turnId, state: "paused", cause: { kind: "credential" } }] });
        expect(scripted.calls).toHaveLength(1);
        expect((await turnRecords(threadId)).map((record) => record.status)).toEqual(["open"]);

        expect(await pausedWork.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(scripted.calls).toHaveLength(2);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        expect(await turns.outcome(turnId)).toMatchObject({ status: "done" });
        const frames = await readAll(turnId);
        expect(textOf(frames)).toContain("after the resume");
        expect(frames.filter((frame) => frame.type === "data-pause").map((frame) => ("data" in frame ? frame.data : frame))).toEqual([
            expect.objectContaining({ state: "paused", cause: { kind: "credential" } }),
            expect.objectContaining({ state: "running" }),
        ]);
        expect(await pausedWork.list(ANALYSIS)).toEqual([]);
        credentialAfterRestart = makeLocalAuth();
    }, 30_000);

    it("closes a paused turn as aborted on a stop, and frees its thread", async () => {
        const scripted = scriptedModel([{ fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        expect(await pausedWorkOf(turnId)).toMatchObject({ waiting: [{ cause: { kind: "host", reason: "payment_required" } }] });
        await turns.stop(turnId);
        await DBOS.retrieveWorkflow(turnId).getResult();

        expect(await turnRecords(threadId)).toEqual([{ status: "aborted", reason: null }]);
        expect(await pausedWork.list(ANALYSIS)).toEqual([]);
        const next = await turns.open(sessionWithSecret(), { analysisId: ANALYSIS, threadId, userInput: "again" });
        expect(next.kind).toBe("started");
        if (next.kind === "started") {
            await turns.stop(next.turnId);
            await DBOS.retrieveWorkflow(next.turnId).getResult();
        }
    });

    it("refuses a second turn on a thread with a turn that runs, and a stop closes the first turn as aborted", async () => {
        let hung = false;
        provider = scriptedModel([hanging(() => (hung = true))]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const first = await startTurn(threadId);
        await waitUntil(() => hung);
        const second = await turns.open(sessionWithSecret(), { analysisId: ANALYSIS, threadId, userInput: "again" });
        await turns.stop(first);
        await DBOS.retrieveWorkflow(first).getResult();

        expect(second.kind).toBe("turn_in_progress");
        expect(await turnRecords(threadId)).toEqual([{ status: "aborted", reason: null }]);
        expect((await readAll(first)).at(-1)?.type).toBe("finish");
    });
});

describe("the approval of a chat turn workflow", () => {
    it("keeps an answer that arrives while the turn is down, and the call runs after the recovery", async () => {
        guardedRuns = 0;
        const scripted = scriptedModel([callTools(toolCall("g1", "guarded", {})), reply([text("It ran.")])]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await waitUntilAsync(async () => (await askOf(threadId))?.status === "pending");
        const ask = await askOf(threadId);
        if (ask === undefined) throw new Error("the turn raised no ask");
        // A cancelled execution waits in its receive until a message wakes it. The answer wakes it while the turn is
        // cancelled, thus it leaves and keeps the answer for the resume, and its end drops the live credential.
        credentialAfterRestart = undefined;
        await DBOS.cancelWorkflow(turnId);
        expect(await turns.answer(ask.id, { kind: "once" })).toBe("applied");
        await waitUntil(() => turnCredentials.of(turnId) === undefined, 15_000);
        credentialAfterRestart = makeLocalAuth();
        const handle = await DBOS.resumeWorkflow(turnId);
        await handle.getResult();

        expect(guardedRuns).toBe(1);
        expect(scripted.calls).toHaveLength(2);
        expect(await askOf(threadId)).toMatchObject({ status: "resolved" });
        // The stored display replays the ask with its answer.
        const replayed = storedMessagesToChat((await createThreadHistory(rig.pool).loadAll(threadId))._unsafeUnwrap().flat())
            .flatMap((message) => message.parts)
            .find((part) => part.type === "data-ask");
        expect(replayed).toMatchObject({ type: "data-ask", title: "Run the script", status: "resolved" });
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
    }, 20_000);

    it("denies the call when the user rejects it, and stops the turn", async () => {
        guardedRuns = 0;
        const scripted = scriptedModel([callTools(toolCall("g1", "guarded", {}))]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await waitUntilAsync(async () => (await askOf(threadId))?.status === "pending");
        const ask = await askOf(threadId);
        if (ask === undefined) throw new Error("the turn raised no ask");
        await turns.answer(ask.id, { kind: "reject", feedback: "not now" });
        await DBOS.retrieveWorkflow(turnId).getResult();

        expect(guardedRuns).toBe(0);
        expect(scripted.calls).toHaveLength(1);
        expect(await askOf(threadId)).toMatchObject({ status: "rejected" });
        const frames = await readAll(turnId);
        expect(frames.find((frame) => frame.type === "tool-finished")).toMatchObject({ outcome: "denied" });
    });

    it("runs the call with no wait when the user holds a grant for its command", async () => {
        guardedRuns = 0;
        const gateway = createAskGateway({ pool: rig.pool });
        const earlier = `ask-${rig.nextWorkflowId()}`;
        await gateway.raise(earlier, { title: "Run the script", command: "Rscript go.R" }, { analysisId: ANALYSIS, userId: "user-1" });
        expect(await gateway.answer(earlier, { kind: "always" })).toBe("applied");
        provider = scriptedModel([callTools(toolCall("g1", "guarded", {})), reply([text("It ran.")])]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        try {
            const turnId = await startTurn(threadId);
            await DBOS.retrieveWorkflow(turnId).getResult();

            expect(guardedRuns).toBe(1);
            expect(await askOf(threadId)).toMatchObject({ status: "resolved" });
            const frames = await readAll(turnId);
            expect(frames.find((frame) => frame.type === "data-ask")).toMatchObject({ status: "resolved", reply: "always" });
        } finally {
            // The grant lasts for the analysis, thus the later cases of this file must not meet it.
            await rig.pool.query("DELETE FROM cortex_ask_grants WHERE analysis_id = $1", [ANALYSIS]);
        }
    });

    it("expires an ask that nobody answers, and denies the call", async () => {
        guardedRuns = 0;
        askWaitSeconds = 1;
        provider = scriptedModel([callTools(toolCall("g1", "guarded", {}))]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await DBOS.retrieveWorkflow(turnId).getResult();
        askWaitSeconds = 60;

        expect(guardedRuns).toBe(0);
        expect(await askOf(threadId)).toMatchObject({ status: "expired" });
    });
});

describe("the sub-agents of a chat turn workflow", () => {
    it("pauses a sub-agent under its turn, and a resume of the turn ends the wait of the child", async () => {
        credentialAfterRestart = makeLocalAuth();
        const child = scriptedModel([{ fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }, reply([text("a late report")])]);
        childProvider = child.provider;
        provider = scriptedModel([callTools(toolCall("p1", "pausing_research", { brief: "a" })), reply([text("Done.")])]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const childId = `${turnId}-p1`;
        expect(await pausedWorkOf(turnId)).toMatchObject({
            kind: "turn",
            threadId,
            waiting: [{ workflowId: childId, state: "paused", cause: { kind: "host", reason: "payment_required" } }],
        });
        expect(await pausedWork.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });

        const frames = await readAll(turnId);
        expect(textOf(frames)).toBe("Done.");
        expect(child.calls).toHaveLength(2);
        const pauses = frames.filter((frame) => frame.type === "data-pause");
        expect(pauses.map((frame) => frame.source?.callPath.join("/"))).toEqual([
            `conversation-agent/${PAUSING_RESEARCHER}`,
            `conversation-agent/${PAUSING_RESEARCHER}`,
        ]);
        expect(await pausedWork.list(ANALYSIS)).toEqual([]);
    });

    it("runs the sub-agents of one reply as child workflows at the same time, and adds their usage to the turn", async () => {
        credentialAfterRestart = makeLocalAuth();
        let started = 0;
        // Each child answers only after both children called the model, thus two children that run one after the
        // other never answer.
        const together: ScriptStep = async () => {
            started += 1;
            await waitUntil(() => started >= 2);
            return reply([text("a report")], "stop", { inputTokens: 100, outputTokens: 20 });
        };
        childProvider = scriptedModel([together, together]).provider;
        provider = scriptedModel([
            callTools(toolCall("r1", "research", { brief: "a" }), toolCall("r2", "research", { brief: "b" })),
            reply([text("Both done.")], "stop", { inputTokens: 10, outputTokens: 5 }),
        ]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const frames = await readAll(turnId);

        expect(textOf(frames)).toBe("Both done.");
        expect((await DBOS.getWorkflowStatus(`${turnId}-r1`))?.status).toBe("SUCCESS");
        expect((await DBOS.getWorkflowStatus(`${turnId}-r2`))?.status).toBe("SUCCESS");
        expect(frames.filter((frame) => frame.type === "tool-finished")).toMatchObject([{ outcome: "ok" }, { outcome: "ok" }]);
        expect(frames.at(-1)).toMatchObject({ type: "finish", turnUsage: { inputTokens: 210, outputTokens: 45 } });
        // The read merges the stream of each child, and each frame of a child carries the call path of the sub-agent.
        const childFrames = frames.filter((frame) => frame.source?.callPath.at(-1) === RESEARCHER);
        expect(childFrames.filter((frame) => frame.type === "iteration")).toHaveLength(2);
        expect(childFrames.every((frame) => frame.source?.callPath.join("/") === `conversation-agent/${RESEARCHER}`)).toBe(true);
    });

    it("recovers a child from its checkpoints, and the child makes no model request again", async () => {
        credentialAfterRestart = makeLocalAuth();
        childToolRuns = 0;
        researchCallsSettled = 0;
        childParked = false;
        parkChildTool = true;
        const child = scriptedModel([callTools(toolCall("k1", "child_park", {})), reply([text("a report")])]);
        childProvider = child.provider;
        const root = scriptedModel([callTools(toolCall("r1", "research", { brief: "a" })), reply([text("Done.")])]);
        provider = root.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const childId = `${turnId}-r1`;
        await waitUntil(() => childParked);
        const childEnded = DBOS.retrieveWorkflow(childId)
            .getResult()
            .catch(() => undefined);
        // The cancel of the turn cancels its child too, as a crash ends both. A cancelled execution runs until it reads
        // the cancel, thus the resume waits until the turn left its call of the child.
        await DBOS.cancelWorkflow(turnId, { cancelChildren: true });
        await childEnded;
        await waitUntil(() => researchCallsSettled === 1);
        await DBOS.resumeWorkflow(childId);
        const handle = await DBOS.resumeWorkflow(turnId);
        await handle.getResult();

        expect(child.calls).toHaveLength(2);
        expect(root.calls).toHaveLength(2);
        expect(childToolRuns).toBe(2);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        const frames = await readAll(turnId);
        expect(textOf(frames)).toBe("Done.");
        // The call of the caller shows the activity of its child.
        expect(frames.filter((frame) => frame.type === "data-subagent-activity")).toMatchObject([{ toolCallId: "r1" }]);
    });
});

const pausedWork = createPausedWork({
    get pool() {
        return rig.pool;
    },
    runAuthorizer: createLocalRunAuthorizer(),
});

/** The paused work of a turn, when the turn waits in a pause. */
async function pausedWorkOf(turnId: string, timeoutMs = 15_000): Promise<PausedWork> {
    let found: PausedWork | undefined;
    await waitUntilAsync(async () => {
        found = (await pausedWork.list(ANALYSIS)).find((work) => work.workId === turnId);
        return found !== undefined;
    }, timeoutMs);
    if (found === undefined) throw new Error(`the turn ${turnId} did not pause`);
    return found;
}

async function waitUntilAsync(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error("the condition did not hold in time");
        await Bun.sleep(20);
    }
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("the condition did not hold in time");
        await Bun.sleep(10);
    }
}
