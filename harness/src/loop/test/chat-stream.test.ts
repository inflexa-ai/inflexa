/**
 * The durable stream of a chat turn: a workflow runs a loop that writes its text and its frames to the stream, and
 * the reader gives the frames of the turn. A frame of a tool call carries its shown input, result, and error, and no
 * raw value of the model record. A crash during a reply runs the model call again, and a read after the recovery
 * shows the text of the second attempt only.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { closeDurableStream } from "@dbos-inc/vercel-ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { recoverAtCrashPoint } from "../../__tests__/setup/dbos-crash.js";
import type { ChatFrame, EventSource } from "../../contracts/chat-events.js";
import { runLoop } from "../run-loop.js";
import { createAiSdkProvider } from "../../providers/ai-sdk.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { defineTool } from "../../tools/define-tool.js";
import { CHAT_STREAM_KEY, createTurnStreamWriter, readChatTurn } from "../chat-stream.js";

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
        await writer.write({ type: "finish", source: ROOT });
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
        await writer.write({ type: "finish", source: ROOT });
        await writer.settle();
        await closeDurableStream(CHAT_STREAM_KEY, "stop");
    },
    { name: "chat-stream-concurrent-writes" },
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
        await writer.write({ type: "finish", source: ROOT });
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
        const input = { text: '{"query":"TP53","env":{"GITHUB_TOKEN":"[REDACTED: Secret Field]"}}', cut: false };
        expect(frames.find((frame) => frame.type === "tool-started" && frame.toolUseId === "c1")).toMatchObject({ input });
        expect(frames.find((frame) => frame.type === "tool-finished" && frame.toolUseId === "c1")).toMatchObject({
            outcome: "ok",
            detail: "lookup 4",
            input,
            result: { text: '{"found":"TP53","password":"[REDACTED: Secret Field]"}', cut: false },
        });
        const failed = frames.find((frame) => frame.type === "tool-finished" && frame.toolUseId === "c2");
        expect(failed).toMatchObject({
            outcome: "error",
            input: { text: '{"query":"missing","env":{}}', cut: false },
            error: { text: JSON.stringify({ error: "no record for missing", retryable: false }), cut: false },
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
