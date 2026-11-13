/**
 * The chat turn as a DBOS workflow: the open, the stream, the recovery from the checkpoints, a recovery with no
 * credential, the claim of a thread, the stop, the approval, and the sub-agents as child workflows.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { APICallError, type LanguageModelV4CallOptions, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { recoverAtCrashPoint } from "../../__tests__/setup/dbos-crash.js";
import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { forSubAgent, type AuthContext } from "../../auth/types.js";
import { createNoopUsageRecorder } from "../../billing/noop-usage-recorder.js";
import type { ChatFrame } from "../../contracts/chat-events.js";
import { applyChatFrame } from "../../contracts/chat-frame.js";
import type { ChatMessage } from "../../contracts/message.js";
import type { Connectable } from "../../lib/db-result.js";
import { parseJsonAs } from "../../lib/parse-json.js";
import { CONTINUE_REQUEST, finalText, runLoop } from "../../loop/run-loop.js";
import { registerSubAgent } from "../../loop/sub-agent.js";
import { turnCredentials } from "../../loop/turn-credentials.js";
import type { Querier } from "../../state/db.js";
import { storedMessagesToChat } from "../../memory/conversation-display-replay.js";
import { createThreadHistory } from "../../memory/thread-history.js";
import { createThreadStore } from "../../memory/thread-store.js";
import { createAiSdkProvider } from "../../providers/ai-sdk.js";
import type { ResolveRequestHeaders } from "../../providers/request-headers.js";
import type { ChatProvider } from "../../providers/types.js";
import type { ThreadAgentResolver } from "../../runtime/assemble.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptEntry, type ScriptStep } from "../../testing.js";
import { createAskGateway } from "../../tools/approval/gateway.js";
import { defineTool } from "../../tools/define-tool.js";
import { queryPausesOfWork } from "../../state/paused-work.js";
import { workPause } from "../../workflows/pause.js";
import { registerChatTurns } from "../chat-turn-workflow.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import { createWork, type Work } from "../work.js";

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

const ANALYSIS = "analysis-wf";

/** An asymmetric matcher for a timestamp string; typed `unknown` because the matcher API returns `any`. */
const ANY_STRING: unknown = expect.any(String);
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
let pausingResearchSettled = 0;

const TOKEN_HEADER = "x-test-token";

/** Puts the token of the credential of each model call on its request, as a host puts the headers of its billing. */
const tokenHeaders: ResolveRequestHeaders = (session) => {
    const token: unknown = Reflect.get(session.auth, "token");
    return okAsync({ [TOKEN_HEADER]: typeof token === "string" ? token : "none" });
};

const echo = defineTool({
    id: "echo",
    description: "Echo the text.",
    inputSchema: z.object({ text: z.string() }),
    view: "none",
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
    view: "none",
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
    view: "none",
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
    view: "none",
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
    view: "none",
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
    (work, waiter, emit) => workPause({ pool: rig.pool, ...work, waiter, emit }).afterFailure,
);

const pausingResearch = defineTool({
    id: "pausing_research",
    description: "Research a brief in a sub-agent that can pause.",
    inputSchema: z.object({ brief: z.string() }),
    view: "none",
    describeCall: "none",
    startsWorkflow: true,
    execute: async (input, ctx) => {
        try {
            return ok({ report: await pausingResearcher(input, ctx) });
        } finally {
            pausingResearchSettled += 1;
        }
    },
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
function sessionWithSecret(token = SECRET) {
    return {
        identity: { user: "user-1" },
        scope: { kind: "analysis" as const, analysisId: ANALYSIS },
        auth: Object.assign(makeLocalAuth(), { token }),
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

/** The stored result of a `chat-turn.prepare` step: SuperJSON puts the value of the step under `json`. */
const StoredPrepareSchema = z.looseObject({ json: z.looseObject({ model: z.string() }) });

/** Removes `model` from the stored result of the `chat-turn.prepare` step of a turn, as a turn of an earlier harness stored it. */
async function dropStoredModel(turnId: string, model: string): Promise<void> {
    const { rows } = await rig.pool.query<{ output: string }>(
        "SELECT output FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = 'chat-turn.prepare'",
        [turnId],
    );
    expect(rows).toHaveLength(1);
    const {
        json: { model: stored, ...result },
        ...envelope
    } = parseJsonAs(rows[0]?.output ?? "", StoredPrepareSchema);
    expect(stored).toBe(model);
    await rig.pool.query("UPDATE dbos.operation_outputs SET output = $2 WHERE workflow_uuid = $1 AND function_name = 'chat-turn.prepare'", [
        turnId,
        JSON.stringify({ ...envelope, json: result }),
    ]);
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

    it("stores the text before a tool call ahead of its part, in the order of the stream", async () => {
        provider = scriptedModel([callTools(text("Let me look."), toolCall("c1", "echo", { text: "a" })), reply([text("Found it.")])]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const frames = await readAll(turnId);

        const assistants = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(partOrderOf(assistants[0])).toEqual(["Let me look.", "tool-call", "Found it."]);
        const assistantId = frames.find((frame) => frame.type === "message-start" && frame.role === "assistant");
        if (assistantId?.type !== "message-start") throw new Error("the stream has no assistant message-start");
        const folded = frames.reduce<ChatMessage[]>((messages, frame) => applyChatFrame(messages, frame, assistantId.messageId).messages, []);
        expect(partOrderOf(folded.find((message) => message.role === "assistant"))).toEqual(["Let me look.", "tool-call", "Found it."]);
    });

    it("keeps the order of the stream when the turn recovers after its tool step", async () => {
        toolRuns = 0;
        parkedWrite = false;
        credentialAfterRestart = makeLocalAuth();
        provider = scriptedModel([callTools(text("Running it."), toolCall("c1", "crash_after", {})), reply([text("Done after the crash.")])]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const ended = DBOS.retrieveWorkflow(turnId)
            .getResult()
            .catch(() => undefined);
        const handle = await recoverAtCrashPoint(turnId, () => parkedWrite, { ended });
        await handle.getResult();

        expect(toolRuns).toBe(1);
        const assistants = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(partOrderOf(assistants[0])).toEqual(["Running it.", "tool-call", "Done after the crash."]);
    });

    it("retries a model call that fails before its first output part as a whole, and the turn does not pause", async () => {
        provider = scriptedModel([{ fail: unavailable() }, reply([text("the retry")])], { maxRetries: 1 }).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const frames = await readAll(turnId);

        expect(textOf(frames)).toBe("the retry");
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        const stored = await transcriptOf(threadId);
        const assistants = stored.filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(partOrderOf(assistants[0])).toEqual(["the retry"]);
        expect(stored.flatMap((message) => message.parts.filter((part) => part.type === "data-pause"))).toEqual([]);
    }, 30_000);

    it("gives a reader the text of a model call before the call ends", async () => {
        const release = gate();
        provider = plannedModel([{ deltas: ["First text. ", () => release.opened, "The rest."], end: "finish" }]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const first = await readUntil(turnId, (frame) => frame.type === "text-delta");

        expect(textOf(first)).toBe("First text. ");
        expect((await DBOS.getWorkflowStatus(turnId))?.status).toBe("PENDING");
        release.open();
        await DBOS.retrieveWorkflow(turnId).getResult();
        expect(textOf(await readAll(turnId))).toBe("First text. The rest.");
    }, 30_000);

    it("pauses a turn whose model call fails after a text, and the continuation follows the text", async () => {
        const scripted = scriptedModel([{ breakAfter: [text("Half of the ")], error: unavailable() }, reply([text("answer.")])], { maxRetries: 1 });
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const beforePause = await readUntil(turnId, (frame) => frame.type === "data-pause");

        expect(textOf(beforePause)).toBe("Half of the ");
        expect(beforePause.at(-1)).toMatchObject({ type: "data-pause", state: "retrying", cause: { kind: "outage" } });
        expect(scripted.calls).toHaveLength(1);

        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await DBOS.retrieveWorkflow(turnId).getResult();

        expect(scripted.calls).toHaveLength(2);
        const prompt = JSON.stringify(scripted.calls[1]?.prompt);
        expect(prompt).toContain("Half of the ");
        expect(prompt).toContain(CONTINUE_REQUEST.slice(1, 40));
        expect(textOf(await readAll(turnId))).toBe("Half of the answer.");
        const assistants = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(textPartsOf(assistants[0])).toBe("Half of the answer.");
    }, 30_000);

    it("ends the loop of a host that leaves a read of a paused turn before the turn writes again", async () => {
        const scripted = scriptedModel([{ breakAfter: [text("Half of the ")], error: unavailable() }, reply([text("answer.")])], { maxRetries: 1 });
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        let leftAt = 0;
        const loop = (async () => {
            for await (const frame of turns.read(turnId)) {
                if (frame.type !== "data-pause") continue;
                leftAt = Date.now();
                break;
            }
            return Date.now() - leftAt;
        })();
        const msToLeave = await Promise.race([loop, Bun.sleep(5_000).then(() => Number.POSITIVE_INFINITY)]);

        expect((await DBOS.getWorkflowStatus(turnId))?.status).toBe("PENDING");
        expect(msToLeave).toBeLessThan(1_000);
        await work.resume(sessionWithSecret(), turnId);
        await DBOS.retrieveWorkflow(turnId).getResult();
    }, 30_000);

    it("keeps the partial reply of a failed model call when the turn recovers during the pause", async () => {
        const scripted = scriptedModel([{ breakAfter: [text("Half of the ")], error: unavailable() }, reply([text("answer.")])], { maxRetries: 1 });
        provider = scripted.provider;
        credentialAfterRestart = makeLocalAuth();
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await pausedWorkOf(turnId);
        const ended = DBOS.retrieveWorkflow(turnId)
            .getResult()
            .catch(() => undefined);
        const handle = await recoverAtCrashPoint(turnId, () => true, { ended });

        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(scripted.calls).toHaveLength(2);
        const prompt = JSON.stringify(scripted.calls[1]?.prompt);
        expect(prompt).toContain("Half of the ");
        expect(prompt).toContain(CONTINUE_REQUEST.slice(1, 40));
        const assistants = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(textPartsOf(assistants[0])).toBe("Half of the answer.");
    }, 30_000);

    it("replays the recorded operations of a turn that paused before the partial reply was recorded", async () => {
        const scripted = scriptedModel([{ breakAfter: [text("Half of the ")], error: unavailable() }, reply([text("answer.")])], { maxRetries: 1 });
        provider = scripted.provider;
        credentialAfterRestart = makeLocalAuth();
        const threadId = `thread-${rig.nextWorkflowId()}`;

        // A patch that gives false with no record makes the body run the operations of a turn from before the upgrade.
        const patch = spyOn(DBOS, "patch").mockResolvedValue(false);
        let turnId: string;
        try {
            turnId = await startTurn(threadId);
            await pausedWorkOf(turnId);
        } finally {
            patch.mockRestore();
        }
        const ended = DBOS.retrieveWorkflow(turnId)
            .getResult()
            .catch(() => undefined);
        const handle = await recoverAtCrashPoint(turnId, () => true, { ended });

        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        const steps = (await DBOS.listWorkflowSteps(turnId)) ?? [];
        expect(steps.filter((step) => step.name.endsWith(".model.partial"))).toEqual([]);
        const assistants = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect(textPartsOf(assistants[0])).toContain("answer.");
    }, 30_000);

    it("gives a read during a recovery the superseded text and then the text of the second execution", async () => {
        credentialAfterRestart = makeLocalAuth();
        const secondMayStream = gate();
        provider = plannedModel([
            { deltas: ["Half of the "], end: "hang" },
            { before: () => secondMayStream.opened, deltas: ["The whole reply."], end: "finish" },
        ]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await readUntil(turnId, (frame) => frame.type === "text-delta");
        const ended = DBOS.retrieveWorkflow(turnId)
            .getResult()
            .catch(() => undefined);
        const handle = await recoverAtCrashPoint(turnId, () => true, { ended });

        // The second execution waits before its first output, and the read gets its marker before it streams.
        const frames: ChatFrame[] = [];
        for await (const frame of turns.read(turnId)) {
            frames.push(frame);
            if (frame.type === "text-superseded") secondMayStream.open();
        }
        await handle.getResult();

        expect(frames.filter((frame) => frame.type === "text-delta" || frame.type === "text-superseded")).toMatchObject([
            { type: "text-delta", text: "Half of the " },
            { type: "text-superseded", length: "Half of the ".length },
            { type: "text-delta", text: "The whole reply." },
        ]);
        expect(textPartsOf(foldedAssistantOf(frames))).toBe("The whole reply.");
        expect(textPartsOf((await transcriptOf(threadId)).find((message) => message.role === "assistant"))).toBe("The whole reply.");
    }, 30_000);

    it("drops the half text of a rerun that fails before its first output part", async () => {
        credentialAfterRestart = undefined;
        const scripted = plannedModel([
            { deltas: ["Half of the "], end: "hang" },
            { deltas: ["Fresh reply."], end: "finish" },
        ]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await readUntil(turnId, (frame) => frame.type === "text-delta");
        // The cancelled execution drops the live credential when it leaves, thus the rerun finds none.
        const ended = Promise.all([
            DBOS.retrieveWorkflow(turnId)
                .getResult()
                .catch(() => undefined),
            waitUntil(() => turnCredentials.of(turnId) === undefined),
        ]);
        const handle = await recoverAtCrashPoint(turnId, () => true, { ended });

        expect(await pausedWorkOf(turnId)).toMatchObject({ waiting: [{ workflowId: turnId, state: "paused", cause: { kind: "credential" } }] });
        const paused = await readUntil(turnId, (frame) => frame.type === "data-pause" && "state" in frame && frame.state === "paused");

        expect(paused.filter((frame) => frame.type === "text-delta" || frame.type === "text-superseded")).toMatchObject([
            { type: "text-delta", text: "Half of the " },
            { type: "text-superseded", length: "Half of the ".length },
        ]);
        expect(textPartsOf(foldedAssistantOf(paused))).toBe("");
        expect(scripted.calls).toHaveLength(1);

        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(scripted.calls).toHaveLength(2);
        expect(textPartsOf(foldedAssistantOf(await readAll(turnId)))).toBe("Fresh reply.");
        credentialAfterRestart = makeLocalAuth();
    }, 30_000);

    it("continues on the model of the host a turn whose stored prepare result holds no model", async () => {
        toolRuns = 0;
        parkedWrite = false;
        credentialAfterRestart = makeLocalAuth();
        const PINNED = "claude-opus-5";
        const pinned = scriptedModel([callTools(toolCall("c1", "crash_after", {}))], { modelId: PINNED });
        const host = scriptedModel([reply([text("on the model of the host")])]);
        provider = {
            ...host.provider,
            withModel: (modelId) => {
                if (modelId !== PINNED) throw new Error(`the test provider has no model ${modelId}`);
                return pinned.provider;
            },
        };
        const threadId = `thread-${rig.nextWorkflowId()}`;
        (await createThreadStore(rig.pool).createThread({ threadId, analysisId: ANALYSIS }))._unsafeUnwrap();
        (await createThreadStore(rig.pool).setModel(threadId, PINNED))._unsafeUnwrap();

        const turnId = await startTurn(threadId);
        // A turn that started on a harness before the pin of the model recorded its prepare step with no `model` key.
        const ended = DBOS.retrieveWorkflow(turnId)
            .getResult()
            .catch(() => undefined)
            .then(() => dropStoredModel(turnId, PINNED));
        const handle = await recoverAtCrashPoint(turnId, () => parkedWrite, { ended });
        await handle.getResult();

        expect(pinned.calls).toHaveLength(1);
        expect(host.calls).toHaveLength(1);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        expect(textOf(await readAll(turnId))).toBe("on the model of the host");
    });

    it("pauses a recovered turn with no credential, and a resume with a credential continues it under that credential", async () => {
        toolRuns = 0;
        parkedWrite = false;
        credentialAfterRestart = undefined;
        const scripted = scriptedModel([callTools(toolCall("c1", "crash_after", {})), reply([text("after the resume")])], {
            resolveRequestHeaders: tokenHeaders,
        });
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
        const rows = (await queryPausesOfWork(rig.pool, ANALYSIS, turnId))._unsafeUnwrap();
        expect(rows.map((row) => ({ workflowId: row.workflowId, waiter: row.waiter }))).toEqual([{ workflowId: turnId, waiter: { kind: "turn" } }]);
        expect(scripted.calls).toHaveLength(1);
        expect((await turnRecords(threadId)).map((record) => record.status)).toEqual(["open"]);

        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(scripted.calls).toHaveLength(2);
        expect(scripted.calls[1]?.headers?.[TOKEN_HEADER]).toBe(SECRET);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        expect(await turns.outcome(turnId)).toMatchObject({ status: "done" });
        const frames = await readAll(turnId);
        expect(textOf(frames)).toContain("after the resume");
        expect(frames.filter((frame) => frame.type === "data-pause").map((frame) => ("data" in frame ? frame.data : frame))).toEqual([
            expect.objectContaining({ state: "paused", cause: { kind: "credential" }, waiter: { kind: "turn" } }),
            expect.objectContaining({ state: "running", waiter: { kind: "turn" }, end: "resume" }),
        ]);
        expect(await work.list(ANALYSIS)).toEqual([]);
        credentialAfterRestart = makeLocalAuth();
    }, 30_000);

    it("pauses a turn whose host refuses its expired credential, and a resume continues it under the new credential", async () => {
        const fresh = "pass-fresh-456";
        const scripted = scriptedModel([reply([text("under the new credential")])], {
            resolveRequestHeaders: (session) =>
                Reflect.get(session.auth, "token") === fresh
                    ? okAsync({ [TOKEN_HEADER]: fresh })
                    : errAsync({ reason: "the passport expired", suspend: false, credential: true }),
        });
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);

        expect(await pausedWorkOf(turnId)).toMatchObject({ waiting: [{ workflowId: turnId, state: "paused", cause: { kind: "credential" } }] });
        expect(scripted.calls).toHaveLength(0);
        expect(await work.resume(sessionWithSecret(fresh), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        expect(textOf(await readAll(turnId))).toBe("under the new credential");
        expect(scripted.calls[0]?.headers?.[TOKEN_HEADER]).toBe(fresh);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
    }, 30_000);

    it("stops a paused turn through the work surface, and the turn leaves the active work", async () => {
        const scripted = scriptedModel([{ fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;
        const stopping = createWork({
            get pool() {
                return rig.pool;
            },
            ...WORK_DEPS,
            stopTurn: (turnId) => turns.stop(turnId),
        });

        const turnId = await startTurn(threadId);
        await pausedWorkOf(turnId);
        expect(await stopping.stop(sessionWithSecret(), turnId)).toMatchObject({ kind: "stopped", work: { workId: turnId, kind: "turn", threadId } });
        await DBOS.retrieveWorkflow(turnId).getResult();

        expect(await turnRecords(threadId)).toEqual([{ status: "aborted", reason: null }]);
        expect(await stopping.list(ANALYSIS)).toEqual([]);
    }, 30_000);

    it("stores the pause part of a turn that paused and resumed, with the end of the wait", async () => {
        const scripted = scriptedModel([{ fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }, reply([text("after the resume")])]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await pausedWorkOf(turnId);
        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await DBOS.retrieveWorkflow(turnId).getResult();

        const assistant = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(assistant).toHaveLength(1);
        const pauses = assistant[0]?.parts.filter((part) => part.type === "data-pause");
        expect(pauses).toEqual([
            {
                type: "data-pause",
                id: turnId,
                workId: turnId,
                workKind: "turn",
                waiter: { kind: "turn" },
                state: "running",
                cause: { kind: "host", reason: "payment_required" },
                pausedAt: ANY_STRING,
                endedAt: ANY_STRING,
                end: "resume",
            },
        ]);
    }, 30_000);

    it("stores the pause part of a turn that failed after a resume, with the end of the wait", async () => {
        const scripted = scriptedModel([
            { fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) },
            { fail: Object.assign(new Error("HTTP 400"), { statusCode: 400 }) },
        ]);
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        await pausedWorkOf(turnId);
        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await DBOS.retrieveWorkflow(turnId).getResult();

        expect((await turnRecords(threadId)).map((record) => record.status)).toEqual(["failed"]);
        const pauses = (await transcriptOf(threadId)).flatMap((message) => message.parts.filter((part) => part.type === "data-pause"));
        expect(pauses).toMatchObject([
            {
                type: "data-pause",
                id: turnId,
                state: "running",
                cause: { kind: "host", reason: "payment_required" },
                pausedAt: ANY_STRING,
                endedAt: ANY_STRING,
                end: "resume",
            },
        ]);
    }, 30_000);

    it("waits in retrying with the cause outage when Bun refuses the connection to the model", async () => {
        const refused = new APICallError({
            message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
            url: "http://127.0.0.1:8181/v1/messages",
            requestBodyValues: {},
            isRetryable: true,
            cause: Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }),
        });
        const scripted = scriptedModel([{ fail: refused }, { fail: refused }], { maxRetries: 1 });
        provider = scripted.provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);

        expect(await pausedWorkOf(turnId)).toMatchObject({ waiting: [{ workflowId: turnId, state: "retrying", cause: { kind: "outage" } }] });
        expect(scripted.calls).toHaveLength(2);
        await turns.stop(turnId);
        await DBOS.retrieveWorkflow(turnId).getResult();
        expect(await turnRecords(threadId)).toEqual([{ status: "aborted", reason: null }]);
    }, 30_000);

    it("gives each reader the retry parts of a model request, and stores none of them", async () => {
        const unavailable = () =>
            new APICallError({
                message: "HTTP 503",
                url: "https://models.example/v1/messages",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "10" },
            });
        const gate = () => {
            let open = () => {};
            const opened = new Promise<void>((resolve) => (open = resolve));
            return { opened, open };
        };
        // A gate that never opens ends the wait, thus a missing retry part fails an assertion and does not hang the file.
        const held = async (...gates: { opened: Promise<void> }[]): Promise<void> => {
            await Promise.race([Promise.all(gates.map((candidate) => candidate.opened)), Bun.sleep(5_000)]);
        };
        const firstHasFrame = gate();
        const secondHasFrame = gate();
        const firstHasRetry2 = gate();
        const secondHasRetry2 = gate();
        provider = scriptedModel(
            [
                async () => {
                    await held(firstHasFrame);
                    return { fail: unavailable() };
                },
                async () => {
                    await held(secondHasFrame);
                    return { fail: unavailable() };
                },
                async () => {
                    await held(firstHasRetry2, secondHasRetry2);
                    return reply([text("back")]);
                },
            ],
            { maxRetries: 2 },
        ).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;
        const retriesSeen = (frames: readonly ChatFrame[]) => frames.filter((frame) => frame.type === "data-model-retry").length;
        const readerOf = async (turnId: string, onFrame: (frames: readonly ChatFrame[]) => void): Promise<ChatFrame[]> => {
            const frames: ChatFrame[] = [];
            for await (const frame of turns.read(turnId)) {
                frames.push(frame);
                onFrame(frames);
            }
            return frames;
        };

        const turnId = await startTurn(threadId);
        let second: Promise<ChatFrame[]> | undefined;
        const first = readerOf(turnId, (frames) => {
            firstHasFrame.open();
            if (retriesSeen(frames) >= 1 && second === undefined) {
                second = readerOf(turnId, (secondFrames) => {
                    secondHasFrame.open();
                    if (retriesSeen(secondFrames) >= 2) secondHasRetry2.open();
                });
            }
            if (retriesSeen(frames) >= 2) firstHasRetry2.open();
        });
        const firstFrames = await first;
        const secondFrames = (await second) ?? [];

        const retryParts = (frames: readonly ChatFrame[]) =>
            frames.filter((frame) => frame.type === "data-model-retry").map((frame) => ("data" in frame ? frame.data : frame));
        for (const frames of [firstFrames, secondFrames]) {
            const parts = retryParts(frames);
            expect(parts).toMatchObject([
                { attempt: 1, maxRetries: 2, status: 503 },
                { attempt: 2, maxRetries: 2, status: 503 },
            ]);
            const ids = parts.map((part) => z.object({ id: z.string().min(1) }).parse(part).id);
            expect(ids[1]).toBe(ids[0]);
            expect(textOf(frames)).toBe("back");
        }
        const stored = await transcriptOf(threadId);
        expect(stored.flatMap((message) => message.parts.filter((part) => part.type === "data-model-retry"))).toEqual([]);
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
        expect(await work.list(ANALYSIS)).toEqual([]);
        const stopped = (await transcriptOf(threadId)).filter((message) => message.role === "assistant");
        expect(stopped).toMatchObject([
            {
                interrupted: true,
                parts: [
                    {
                        type: "data-pause",
                        id: turnId,
                        state: "running",
                        cause: { kind: "host", reason: "payment_required" },
                        pausedAt: ANY_STRING,
                        endedAt: ANY_STRING,
                        end: "abort",
                    },
                ],
            },
        ]);
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
        const rows = (await queryPausesOfWork(rig.pool, ANALYSIS, turnId))._unsafeUnwrap();
        expect(rows.map((row) => ({ workflowId: row.workflowId, waiter: row.waiter }))).toEqual([
            { workflowId: childId, waiter: { kind: "sub-agent", agentId: PAUSING_RESEARCHER } },
        ]);
        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });

        const frames = await readAll(turnId);
        expect(textOf(frames)).toBe("Done.");
        expect(child.calls).toHaveLength(2);
        const pauses = frames.filter((frame) => frame.type === "data-pause");
        expect(pauses.map((frame) => ("data" in frame ? frame.data : frame))).toEqual([
            expect.objectContaining({ state: "paused", waiter: { kind: "sub-agent", agentId: PAUSING_RESEARCHER } }),
            expect.objectContaining({ state: "running", waiter: { kind: "sub-agent", agentId: PAUSING_RESEARCHER }, end: "resume" }),
        ]);
        expect(pauses.map((frame) => frame.source?.callPath.join("/"))).toEqual([
            `conversation-agent/${PAUSING_RESEARCHER}`,
            `conversation-agent/${PAUSING_RESEARCHER}`,
        ]);
        // The stream closes before the last steps of the turn, and the turn is active work until its workflow ends.
        await DBOS.retrieveWorkflow(turnId).getResult();
        expect(await work.list(ANALYSIS)).toEqual([]);
    });

    it("pauses a recovered child with no credential, and a resume of the turn continues the child under that credential", async () => {
        credentialAfterRestart = makeLocalAuth();
        childParked = false;
        parkChildTool = true;
        pausingResearchSettled = 0;
        const child = scriptedModel([callTools(toolCall("k1", "child_park", {})), reply([text("a report")])], { resolveRequestHeaders: tokenHeaders });
        childProvider = child.provider;
        provider = scriptedModel([callTools(toolCall("p1", "pausing_research", { brief: "a" })), reply([text("Done.")])]).provider;
        const threadId = `thread-${rig.nextWorkflowId()}`;

        const turnId = await startTurn(threadId);
        const childId = `${turnId}-p1`;
        await waitUntil(() => childParked);
        const childEnded = DBOS.retrieveWorkflow(childId)
            .getResult()
            .catch(() => undefined);
        // The cancel of the turn and its child is the crash. The recovery runs where the turn has no live credential.
        await DBOS.cancelWorkflow(turnId, { cancelChildren: true });
        await childEnded;
        credentialAfterRestart = undefined;
        await waitUntil(() => pausingResearchSettled === 1 && turnCredentials.of(turnId) === undefined);
        await DBOS.resumeWorkflow(childId);
        const handle = await DBOS.resumeWorkflow(turnId);

        expect(await pausedWorkOf(turnId)).toMatchObject({ waiting: [{ workflowId: childId, state: "paused", cause: { kind: "credential" } }] });
        expect(await work.resume(sessionWithSecret(), turnId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(child.calls).toHaveLength(2);
        expect(child.calls[1]?.headers?.[TOKEN_HEADER]).toBe(SECRET);
        expect(await turnRecords(threadId)).toEqual([{ status: "done", reason: null }]);
        credentialAfterRestart = makeLocalAuth();
    }, 30_000);

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
        expect(frames.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", turnUsage: { inputTokens: 210, outputTokens: 45 } });
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

const work = createWork({
    get pool() {
        return rig.pool;
    },
    ...WORK_DEPS,
});

/** A retryable failure of the model service. */
function unavailable(): APICallError {
    return new APICallError({
        message: "HTTP 503",
        url: "https://models.example/v1/messages",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: { "retry-after-ms": "10" },
    });
}

/** A latch: `opened` settles when `open` runs. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
}

/** One request of {@link plannedModel}: the text it streams, and how its stream ends. */
type RequestPlan = {
    /** Settles before the request opens its stream, thus the model holds the request before its first output part. */
    readonly before?: () => Promise<void>;
    /** The text deltas of the reply. A function is a wait between two deltas. */
    readonly deltas: readonly (string | (() => Promise<void>))[];
    /** `hang`: the stream stays open until the cancel of its step ends it, as a crash in the middle of a reply does. */
    readonly end: "finish" | "hang";
};

/** A provider over a model that streams the planned text of each request, for a test that stops a reply while it streams. */
function plannedModel(plans: readonly RequestPlan[]): { readonly provider: ChatProvider; readonly calls: LanguageModelV4CallOptions[] } {
    const calls: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
        provider: "scripted",
        modelId: "scripted-model",
        doStream: async (call) => {
            const index = calls.length;
            calls.push(call);
            const plan = plans[index];
            if (plan === undefined) throw new Error(`the plan has no request ${index}`);
            await plan.before?.();
            const stream = new ReadableStream<LanguageModelV4StreamPart>({
                start(controller) {
                    void (async () => {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ type: "response-metadata", id: `response-${index}`, modelId: "scripted-model", timestamp: new Date(0) });
                        controller.enqueue({ type: "text-start", id: "t" });
                        for (const delta of plan.deltas) {
                            if (typeof delta === "string") controller.enqueue({ type: "text-delta", id: "t", delta });
                            else await delta();
                        }
                        if (plan.end === "hang") return;
                        controller.enqueue({ type: "text-end", id: "t" });
                        controller.enqueue({
                            type: "finish",
                            finishReason: { unified: "stop", raw: "stop" },
                            usage: {
                                inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
                            },
                        });
                        controller.close();
                    })().catch(() => undefined);
                },
            });
            return { stream };
        },
    });
    return { provider: createAiSdkProvider({ model, maxRetries: 0 }), calls };
}

/** The frames of a read, up to and including the first frame that `stop` accepts. The read ends at that frame. */
async function readUntil(turnId: string, stop: (frame: ChatFrame) => boolean, timeoutMs = 10_000): Promise<ChatFrame[]> {
    const frames: ChatFrame[] = [];
    const read = (async () => {
        for await (const frame of turns.read(turnId)) {
            frames.push(frame);
            if (stop(frame)) return frames;
        }
        throw new Error("the read ended before the frame that the test waits for");
    })();
    read.catch(() => undefined);
    return await Promise.race([read, Bun.sleep(timeoutMs).then(() => Promise.reject(new Error("the read did not give the frame in time")))]);
}

/** The assistant message that the frames of a turn fold to. */
function foldedAssistantOf(frames: readonly ChatFrame[]): ChatMessage | undefined {
    const start = frames.find((frame) => frame.type === "message-start" && frame.role === "assistant");
    if (start?.type !== "message-start") throw new Error("the frames have no assistant message-start");
    return frames
        .reduce<ChatMessage[]>((messages, frame) => applyChatFrame(messages, frame, start.messageId).messages, [])
        .find((message) => message.role === "assistant");
}

/** The text of the text parts of a message, joined. */
function textPartsOf(message: ChatMessage | undefined): string {
    return (message?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The parts of a message in order: the text of a text part, and the type of any other part. */
function partOrderOf(message: ChatMessage | undefined): string[] {
    return (message?.parts ?? []).map((part) => (part.type === "text" ? part.text : part.type));
}

/** The transcript of a thread as a host reads it after a reload. */
async function transcriptOf(threadId: string): Promise<ChatMessage[]> {
    const stored = (await createThreadHistory(rig.pool).loadAll(threadId))._unsafeUnwrap();
    return storedMessagesToChat(stored.flat());
}

/** The paused work of a turn, when the turn waits in a pause. */
async function pausedWorkOf(turnId: string, timeoutMs = 15_000): Promise<Work> {
    let found: Work | undefined;
    await waitUntilAsync(async () => {
        found = (await work.list(ANALYSIS)).find((candidate) => candidate.workId === turnId && candidate.waiting.length > 0);
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
