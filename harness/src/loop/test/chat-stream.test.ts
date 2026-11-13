/**
 * The durable stream of a chat turn: a workflow runs a loop that writes its text and its frames to the stream, and
 * the reader gives the frames of the turn. A frame of a tool call carries its shown input, result, and error, and no
 * raw value of the model record. A crash during a reply runs the model call again, and a read after the recovery
 * shows the text of the second attempt only.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { closeDurableStream, type DurableStreamRecord } from "@dbos-inc/vercel-ai";
import type { UIMessageChunk } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { recoverAtCrashPoint } from "../../__tests__/setup/dbos-crash.js";
import type { ChatFrame, EventSource } from "../../contracts/chat-events.js";
import { applyChatFrame } from "../../contracts/chat-frame.js";
import type { ChatMessage } from "../../contracts/message.js";
import { runLoop } from "../run-loop.js";
import { createAiSdkProvider } from "../../providers/ai-sdk.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { defineTool } from "../../tools/define-tool.js";
import {
    CHAT_STREAM_KEY,
    chunkOfFrame,
    createTurnStreamWriter,
    framesOfChunk,
    readChatTurn,
    SUB_AGENT_STREAM_PART,
    type ChatStreamSource,
} from "../chat-stream.js";

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ROOT: EventSource = { agentId: "stream-agent", callPath: ["stream-agent"] };
const SECRET_INPUT = "ghp_0123456789abcdefghij0123456789abcdef";
const SECRET_OUTPUT = "hunter2";

const lookup = defineTool({
    id: "lookup",
    description: "Look a value up.",
    inputSchema: z.object({ query: z.string(), env: z.record(z.string(), z.string()) }),
    describeCall: (input) => `lookup ${input.query.length}`,
    view: { input: (input) => input, result: (_input, result) => result, error: true },
    execute: ({ query }) =>
        Promise.resolve(query === "missing" ? err({ error: "no record for missing", retryable: false }) : ok({ found: "TP53", password: SECRET_OUTPUT })),
});

const agent = { id: "stream-agent", systemPrompt: "Test.", model: "scripted-model", tools: [lookup], maxIterations: 5 };

const freshModel = () =>
    scriptedModel([
        callTools(toolCall("c1", "lookup", { query: "TP53", env: { GITHUB_TOKEN: SECRET_INPUT } }), toolCall("c2", "lookup", { query: "missing", env: {} })),
        reply([text("The answer is 42.")]),
    ]);

/** Each turn of the test gets its own script, because a script answers each request one time. */
let scripted = freshModel();

const streamWorkflow = DBOS.registerWorkflow(
    async (): Promise<string> => {
        const writer = createTurnStreamWriter(ROOT, () => undefined);
        const result = await runLoop(agent, [{ role: "user", content: "go" }], makeSession({ agentId: ROOT.agentId, callPath: ROOT.callPath }), {
            provider: scripted.provider,
            emit: writer.emit,
            toolWriter: writer.toolWriter,
            signal: new AbortController().signal,
            chatStream: CHAT_STREAM_KEY,
        });
        await writer.write({ type: "finish", source: ROOT, finishReason: result.finish.reason });
        await writer.settle();
        await closeDurableStream(CHAT_STREAM_KEY, result.finish.reason);
        return result.finish.reason;
    },
    { name: "chat-stream-turn" },
);

const STARTED_IDS = ["c1", "c2", "c3"];

/** Three body writes that start in one tick, and a step after them that takes the next function id. */
const concurrentWritesWorkflow = DBOS.registerWorkflow(
    async (): Promise<void> => {
        const writer = createTurnStreamWriter(ROOT, () => undefined);
        const writes = STARTED_IDS.map((toolUseId) => writer.write({ type: "tool-started", source: ROOT, toolUseId, name: "lookup" }));
        const stepped = DBOS.runStep(() => Promise.resolve("done"), { name: "after-writes" });
        await Promise.all([...writes, stepped]);
        await writer.write({ type: "finish", source: ROOT, finishReason: "stop" });
        await writer.settle();
        await closeDurableStream(CHAT_STREAM_KEY, "stop");
    },
    { name: "chat-stream-concurrent-writes" },
);

const RETRY_ATTEMPTS = Array.from({ length: 12 }, (_, index) => index + 1);

/** One step that emits the retry parts of a request in one tick, with no wait between the emits. */
const stepEmitsWorkflow = DBOS.registerWorkflow(
    async (): Promise<void> => {
        const writer = createTurnStreamWriter(ROOT, () => undefined);
        await DBOS.runStep(
            async () => {
                const emits = RETRY_ATTEMPTS.map((attempt) =>
                    writer.emit({
                        type: "data-model-retry",
                        source: ROOT,
                        data: { id: "request-1", attempt, maxRetries: RETRY_ATTEMPTS.length, retryAt: "2026-01-01T00:00:00.000Z" },
                    }),
                );
                await Promise.all(emits);
            },
            { name: "emit-retries" },
        );
        await writer.write({ type: "finish", source: ROOT, finishReason: "stop" });
        await writer.settle();
        await closeDurableStream(CHAT_STREAM_KEY, "stop");
    },
    { name: "chat-stream-step-emits" },
);

let parked = false;
let attempts = 0;

/** The first attempt streams half of its text and then hangs, and the second attempt gives the whole reply. */
const halting = new MockLanguageModelV4({
    provider: "scripted",
    modelId: "scripted-model",
    doStream: (call) => {
        attempts += 1;
        if (attempts > 1) {
            return Promise.resolve({
                stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "t" },
                    { type: "text-delta", id: "t", delta: "The whole answer." },
                    { type: "text-end", id: "t" },
                    {
                        type: "finish",
                        finishReason: { unified: "stop", raw: "stop" },
                        usage: {
                            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                            outputTokens: { total: 1, text: undefined, reasoning: undefined },
                        },
                    },
                ]),
            });
        }
        return Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
                start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ type: "text-start", id: "t" });
                    controller.enqueue({ type: "text-delta", id: "t", delta: "Half of the" });
                    parked = true;
                    call.abortSignal?.addEventListener("abort", () => controller.error(call.abortSignal?.reason), { once: true });
                },
            }),
        });
    },
});

const haltingWorkflow = DBOS.registerWorkflow(
    async (): Promise<string> => {
        const writer = createTurnStreamWriter(ROOT, () => undefined);
        const result = await runLoop(
            { ...agent, tools: [] },
            [{ role: "user", content: "go" }],
            makeSession({ agentId: ROOT.agentId, callPath: ROOT.callPath }),
            {
                provider: createAiSdkProvider({ model: halting, maxRetries: 0 }),
                emit: writer.emit,
                toolWriter: writer.toolWriter,
                signal: new AbortController().signal,
                chatStream: CHAT_STREAM_KEY,
            },
        );
        await writer.write({ type: "finish", source: ROOT, finishReason: result.finish.reason });
        await writer.settle();
        await closeDurableStream(CHAT_STREAM_KEY, result.finish.reason);
        return result.finish.reason;
    },
    { name: "chat-stream-halting-turn" },
);

async function readAll(turnId: string): Promise<ChatFrame[]> {
    const frames: ChatFrame[] = [];
    for await (const frame of readChatTurn(turnId, { rootSource: ROOT })) frames.push(frame);
    return frames;
}

const textOf = (frames: readonly ChatFrame[]): string => frames.map((frame) => (frame.type === "text-delta" ? frame.text : "")).join("");

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("chat_turn_stream");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

describe("the durable stream of a chat turn", () => {
    it("gives the text, the tool frames with their input and result, and the end, with no secret", async () => {
        const turnId = rig.nextWorkflowId("chat-stream-");
        const handle = await DBOS.startWorkflow(streamWorkflow, { workflowID: turnId })();
        await handle.getResult();

        const frames = await readAll(turnId);

        expect(textOf(frames)).toBe("The answer is 42.");
        expect(frames.filter((frame) => frame.type === "tool-started")).toHaveLength(2);
        expect(frames.filter((frame) => frame.type === "tool-finished")).toHaveLength(2);
        const input = { kind: "json", text: '{"query":"TP53","env":{"GITHUB_TOKEN":"[REDACTED: Secret Field]"}}', cut: false };
        expect(frames.find((frame) => frame.type === "tool-started" && frame.toolUseId === "c1")).toMatchObject({ input });
        expect(frames.find((frame) => frame.type === "tool-finished" && frame.toolUseId === "c1")).toMatchObject({
            outcome: "ok",
            detail: "lookup 4",
            input,
            result: { kind: "json", text: '{"found":"TP53","password":"[REDACTED: Secret Field]"}', cut: false },
        });
        const failed = frames.find((frame) => frame.type === "tool-finished" && frame.toolUseId === "c2");
        expect(failed).toMatchObject({
            outcome: "error",
            input: { kind: "json", text: '{"query":"missing","env":{}}', cut: false },
            error: { kind: "text", text: "no record for missing", cut: false },
        });
        expect(JSON.stringify(failed)).not.toContain('"result"');
        expect(frames.at(-1)?.type).toBe("finish");
        const serialized = JSON.stringify(frames);
        expect(serialized).not.toContain(SECRET_INPUT);
        expect(serialized).not.toContain(SECRET_OUTPUT);
    });

    it("gives the same frames on a second read", async () => {
        const turnId = rig.nextWorkflowId("chat-stream-again-");
        scripted = freshModel();
        const handle = await DBOS.startWorkflow(streamWorkflow, { workflowID: turnId })();
        await handle.getResult();

        expect(await readAll(turnId)).toEqual(await readAll(turnId));
    });

    it("writes the concurrent body writes in the order of the calls, with no retry of a stream offset", async () => {
        const turnId = rig.nextWorkflowId("chat-stream-concurrent-");
        await (await DBOS.startWorkflow(concurrentWritesWorkflow, { workflowID: turnId })()).getResult();

        // A write that loses the offset tries again after a sleep, thus it lands after the writes that follow it.
        const frames = await readAll(turnId);
        expect(frames.map((frame) => (frame.type === "tool-started" ? frame.toolUseId : frame.type))).toEqual([...STARTED_IDS, "finish"]);
        const steps = (await DBOS.listWorkflowSteps(turnId)) ?? [];
        expect(steps.slice(0, 4).map((step) => step.name)).toEqual(["DBOS.writeStream", "DBOS.writeStream", "DBOS.writeStream", "after-writes"]);
    });

    it("writes the frames that a step emits in one tick in the order of the emits", async () => {
        const turnId = rig.nextWorkflowId("chat-stream-step-emits-");
        await (await DBOS.startWorkflow(stepEmitsWorkflow, { workflowID: turnId })()).getResult();

        const frames = await readAll(turnId);
        expect(frames.map((frame) => (frame.type === "data-model-retry" ? frame.attempt : frame.type))).toEqual([...RETRY_ATTEMPTS, "finish"]);
    });

    it("shows the text of the second attempt only, after a crash during a reply", async () => {
        const turnId = rig.nextWorkflowId("chat-stream-crash-");
        const first = await DBOS.startWorkflow(haltingWorkflow, { workflowID: turnId })();
        const ended = first.getResult().catch(() => undefined);

        const handle = await recoverAtCrashPoint<string>(turnId, () => parked, { ended });
        await handle.getResult();

        expect(attempts).toBe(2);
        expect(textOf(await readAll(turnId))).toBe("The whole answer.");
    });
});

describe("the frames of one chunk of the stream", () => {
    it("ends a workflow that the library aborted with a finish frame of the reason aborted", () => {
        expect(framesOfChunk({ type: "abort" }, ROOT)).toEqual([{ type: "finish", source: ROOT, finishReason: "aborted" }]);
    });
});

const STEP = 3;
const ASSISTANT_ID = "assistant-1";

const attemptText = (attempt: string, delta: string): DurableStreamRecord => ({
    kind: "model",
    step: STEP,
    attempt,
    parts: [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta },
        { type: "text-end", id: "t" },
    ],
});

const END: DurableStreamRecord = { kind: "end", finishReason: "stop" };

/**
 * A stream of recorded values. A read takes `history` as the records that are already stored, and it takes `live` as the
 * records that arrive after it. The real reader of the library converts them.
 */
function recordedSource(history: readonly DurableStreamRecord[], live: readonly DurableStreamRecord[] = []): ChatStreamSource {
    const all = [...history, ...live];
    // The overload signature is the generic one that the source declares. The implementation signature gives the record
    // type that the fake stores, and TypeScript accepts the pair because it compares them with the type parameter erased.
    function readStreamOffset<T>(workflowID: string, key: string, offset: number): Promise<T>;
    function readStreamOffset(workflowID: string, key: string, offset: number): Promise<DurableStreamRecord> {
        const record = all[offset];
        return offset < history.length && record !== undefined
            ? Promise.resolve(record)
            : Promise.reject(new DBOSErrors.DBOSStreamTimeoutError(workflowID, key, 0));
    }
    function readStream<T>(workflowID: string, key: string, options?: { offset?: number }): AsyncGenerator<T, void, unknown>;
    async function* readStream(_workflowID: string, _key: string, options?: { offset?: number }): AsyncGenerator<DurableStreamRecord, void, unknown> {
        for (const record of all.slice(options?.offset ?? 0)) yield await Promise.resolve(record);
    }
    return {
        readStreamOffset,
        readStream,
        retrieveWorkflow: () => ({ getStatus: () => Promise.resolve({ status: "SUCCESS" }) }),
    };
}

async function readRecorded(history: readonly DurableStreamRecord[], live: readonly DurableStreamRecord[] = []): Promise<ChatFrame[]> {
    const frames: ChatFrame[] = [];
    for await (const frame of readChatTurn("recorded-turn", { rootSource: ROOT, client: recordedSource(history, live) })) frames.push(frame);
    return frames;
}

/** The text of the reply that a client holds after it applies the frames. */
function foldedText(frames: readonly ChatFrame[]): string {
    let messages: ChatMessage[] = [];
    for (const frame of frames) messages = applyChatFrame(messages, frame, ASSISTANT_ID).messages;
    return (messages[0]?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

const frameKinds = (frames: readonly ChatFrame[]): string[] =>
    frames.map((frame) => (frame.type === "text-delta" ? `+${frame.text}` : frame.type === "text-superseded" ? `-${frame.length}` : frame.type));

describe("the reader of a turn and a model step that a recovery runs again", () => {
    it("removes the text of the earlier attempt when the new attempt streams during the read", async () => {
        const frames = await readRecorded([attemptText("A", "Half of the")], [attemptText("B", "Whole reply."), END]);

        expect(frameKinds(frames)).toEqual(["+Half of the", "-11", "+Whole reply."]);
        expect(frames.find((frame) => frame.type === "text-superseded")).toMatchObject({ source: ROOT });
        expect(foldedText(frames)).toBe("Whole reply.");
    });
});

const uiRecord = (...chunks: UIMessageChunk[]): DurableStreamRecord => ({ kind: "ui", chunks });

const toolStarted = (toolUseId: string): UIMessageChunk => chunkOfFrame({ type: "tool-started", source: ROOT, toolUseId, name: "lookup" });

const CHILD_ID = "quiet-child";

const subAgentNamed = uiRecord({ type: "data-harness-frame", data: { type: SUB_AGENT_STREAM_PART, workflowId: CHILD_ID } });

/** How long a live read of the quiet source waits for a value before it ends in a timeout, in place of the requested window. */
const QUIET_WINDOW_MS = 50;

type QuietSource = {
    readonly source: ChatStreamSource;
    /** The reads of the stream of a workflow that are in progress. */
    open(workflowID: string): number;
    /** The reads of the stream of a workflow that started. */
    started(workflowID: string): number;
    /** The `timeoutSeconds` of each live read that started. */
    readonly windows: (number | undefined)[];
    append(workflowID: string, record: DurableStreamRecord): void;
    /** End each wait, and end each read that still waits. */
    close(): void;
};

/**
 * Streams that give their records and then wait with no value. A live read with `timeoutSeconds` waits for one short
 * window and then ends in `DBOSStreamTimeoutError`. A live read with no `timeoutSeconds` waits until a record arrives.
 */
function quietSource(streams: Record<string, DurableStreamRecord[]>): QuietSource {
    const open = new Map<string, number>();
    const started = new Map<string, number>();
    const windows: (number | undefined)[] = [];
    const wakeups = new Set<AbortController>();
    let closed = false;
    const wake = (): void => {
        for (const wakeup of [...wakeups]) wakeup.abort();
    };
    const wait = async (ms: number | undefined): Promise<void> => {
        const wakeup = new AbortController();
        wakeups.add(wakeup);
        try {
            if (ms === undefined) await new Promise<void>((resolve) => wakeup.signal.addEventListener("abort", () => resolve(), { once: true }));
            else await sleep(ms, undefined, { signal: wakeup.signal }).catch(() => undefined);
        } finally {
            wakeups.delete(wakeup);
        }
    };
    const count = (map: Map<string, number>, workflowID: string, by: number): void => {
        map.set(workflowID, (map.get(workflowID) ?? 0) + by);
    };

    function readStreamOffset<T>(workflowID: string, key: string, offset: number): Promise<T>;
    function readStreamOffset(workflowID: string, key: string, offset: number): Promise<DurableStreamRecord> {
        const record = streams[workflowID]?.[offset];
        return record === undefined ? Promise.reject(new DBOSErrors.DBOSStreamTimeoutError(workflowID, key, 0)) : Promise.resolve(record);
    }
    // The overload pair has the same shape as the one of `recordedSource`, and TypeScript accepts it for the same reason.
    function readStream<T>(workflowID: string, key: string, options?: { offset?: number; timeoutSeconds?: number }): AsyncGenerator<T, void, unknown>;
    async function* readStream(
        workflowID: string,
        key: string,
        options?: { offset?: number; timeoutSeconds?: number },
    ): AsyncGenerator<DurableStreamRecord, void, unknown> {
        count(started, workflowID, 1);
        count(open, workflowID, 1);
        windows.push(options?.timeoutSeconds);
        try {
            let offset = options?.offset ?? 0;
            let deadline = options?.timeoutSeconds === undefined ? undefined : Date.now() + QUIET_WINDOW_MS;
            for (;;) {
                const record = streams[workflowID]?.[offset];
                if (record !== undefined) {
                    offset += 1;
                    if (deadline !== undefined) deadline = Date.now() + QUIET_WINDOW_MS;
                    yield record;
                    continue;
                }
                if (closed) return;
                const remaining = deadline === undefined ? undefined : deadline - Date.now();
                if (remaining !== undefined && remaining <= 0) throw new DBOSErrors.DBOSStreamTimeoutError(workflowID, key, QUIET_WINDOW_MS);
                await wait(remaining);
            }
        } finally {
            count(open, workflowID, -1);
        }
    }
    return {
        source: { readStreamOffset, readStream, retrieveWorkflow: () => ({ getStatus: () => Promise.resolve({ status: "PENDING" }) }) },
        open: (workflowID) => open.get(workflowID) ?? 0,
        started: (workflowID) => started.get(workflowID) ?? 0,
        windows,
        append(workflowID, record) {
            (streams[workflowID] ??= []).push(record);
            wake();
        },
        close() {
            closed = true;
            wake();
        },
    };
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > end) return false;
        await Bun.sleep(5);
    }
    return true;
}

/** Read a turn up to its first frame and leave the loop. Gives whether the loop ended within one second. */
async function leavesAtOnce(turnId: string, client: ChatStreamSource): Promise<boolean> {
    const leaving = (async () => {
        for await (const frame of readChatTurn(turnId, { rootSource: ROOT, client })) {
            expect(frame.type).toBe("tool-started");
            break;
        }
    })();
    return await Promise.race([leaving.then(() => true), Bun.sleep(1000).then(() => false)]);
}

describe("the stop of a read", () => {
    it("ends the loop of a host that leaves a read of a quiet turn, and ends the reads of the stream", async () => {
        const quiet = quietSource({ "quiet-turn": [uiRecord(toolStarted("c1"))] });
        try {
            expect(await leavesAtOnce("quiet-turn", quiet.source)).toBe(true);
            expect(await until(() => quiet.open("quiet-turn") === 0, 2000)).toBe(true);
            const reads = quiet.started("quiet-turn");
            await Bun.sleep(4 * QUIET_WINDOW_MS);
            expect(quiet.started("quiet-turn")).toBe(reads);
            expect(quiet.open("quiet-turn")).toBe(0);
        } finally {
            quiet.close();
        }
    });

    it("ends the reads of the stream of a sub-agent child after the stop", async () => {
        const quiet = quietSource({ "quiet-turn": [subAgentNamed], [CHILD_ID]: [uiRecord(toolStarted("k1"))] });
        try {
            expect(await leavesAtOnce("quiet-turn", quiet.source)).toBe(true);
            expect(quiet.started(CHILD_ID)).toBeGreaterThan(0);
            expect(await until(() => quiet.open("quiet-turn") === 0 && quiet.open(CHILD_ID) === 0, 2000)).toBe(true);
            const reads = [quiet.started("quiet-turn"), quiet.started(CHILD_ID)];
            await Bun.sleep(4 * QUIET_WINDOW_MS);
            expect([quiet.started("quiet-turn"), quiet.started(CHILD_ID)]).toEqual(reads);
            expect([quiet.open("quiet-turn"), quiet.open(CHILD_ID)]).toEqual([0, 0]);
        } finally {
            quiet.close();
        }
    });

    it("gives a record that arrives after some windows of a quiet turn", async () => {
        const quiet = quietSource({ "quiet-turn": [] });
        const finish = chunkOfFrame({ type: "finish", source: ROOT, finishReason: "stop" });
        const frames: ChatFrame[] = [];
        const reading = (async () => {
            for await (const frame of readChatTurn("quiet-turn", { rootSource: ROOT, client: quiet.source })) frames.push(frame);
        })();
        try {
            await Bun.sleep(4 * QUIET_WINDOW_MS);
            quiet.append("quiet-turn", uiRecord(toolStarted("late")));
            quiet.append("quiet-turn", uiRecord(finish));
            quiet.append("quiet-turn", END);
            await Promise.race([reading, Bun.sleep(2000)]);
            expect(frames.map((frame) => frame.type)).toEqual(["tool-started", "finish"]);
        } finally {
            quiet.close();
        }
    });
});
