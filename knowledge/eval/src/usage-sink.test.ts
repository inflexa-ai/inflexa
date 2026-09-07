import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentSession, ChatProvider, ChatRequest, ChatResponse, ChatStreamEvent, LlmUsageRecord } from "@inflexa-ai/harness";

import { recordingProvider, type CallLine } from "./record-provider.js";
import { createEvalUsageRecorder, createJsonlSink, foldUsage, parseUsageLines, readUsageFile } from "./usage-sink.js";

// The harness answers `chat` with a neverthrow `ResultAsync`, and the knowledge package holds no
// copy of neverthrow. The fake inner provider takes the constructors from the install of the
// harness, thus the wrapper is driven with the same class the real providers answer with.
const harnessDist = dirname(Bun.resolveSync("@inflexa-ai/harness", import.meta.dir));
const neverthrow = (await import(Bun.resolveSync("neverthrow", harnessDist))) as {
    okAsync: (value: unknown) => unknown;
    errAsync: (error: unknown) => unknown;
};

function record(overrides: Partial<LlmUsageRecord> & Pick<LlmUsageRecord, "recordKey">): LlmUsageRecord {
    return {
        agentId: "planner",
        callPath: ["planner"],
        scope: { kind: "analysis", analysisId: "a1" },
        usage: { inputTokens: 100, outputTokens: 10 },
        ...overrides,
    };
}

function lines(path: string): unknown[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
}

describe("createEvalUsageRecorder", () => {
    it("appends one line per record, makes the directory, and moves with the sink", () => {
        const dir = mkdtempSync(join(tmpdir(), "usage-sink-"));
        const first = join(dir, "attempt-1", "usage.jsonl");
        const recorder = createEvalUsageRecorder(first);
        recorder.record(record({ recordKey: "k1", runId: "r1", stepId: "s1" }));
        recorder.record(record({ recordKey: "k2" }));
        const written = lines(first) as (LlmUsageRecord & { recordedAt: string })[];
        expect(written.map((line) => line.recordKey)).toEqual(["k1", "k2"]);
        expect(written[0]?.stepId).toBe("s1");
        expect(typeof written[0]?.recordedAt).toBe("string");

        const second = join(dir, "attempt-2", "usage.jsonl");
        recorder.sink.retarget(second);
        recorder.record(record({ recordKey: "k3" }));
        expect(lines(second).length).toBe(1);
        expect(lines(first).length).toBe(2);
    });

    it("never throws on a target that cannot be written", () => {
        const dir = mkdtempSync(join(tmpdir(), "usage-sink-"));
        const blocker = join(dir, "not-a-dir");
        writeFileSync(blocker, "x");
        const recorder = createEvalUsageRecorder(join(blocker, "usage.jsonl"));
        expect(() => recorder.record(record({ recordKey: "k1" }))).not.toThrow();
    });
});

describe("foldUsage", () => {
    it("dedups by recordKey with the last write winning", () => {
        const fold = foldUsage([
            record({ recordKey: "k1", usage: { inputTokens: 100, outputTokens: 10 } }),
            record({ recordKey: "k1", usage: { inputTokens: 120, outputTokens: 12 } }),
            record({ recordKey: "k2", usage: { inputTokens: 50, outputTokens: 5 } }),
        ]);
        expect(fold.records).toBe(2);
        expect(fold.replayed).toBe(1);
        expect(fold.total).toEqual({ inputTokens: 170, outputTokens: 17 });
        expect(fold.byRole.planner).toEqual({ inputTokens: 170, outputTokens: 17 });
    });

    it("keeps the cache categories apart from inputTokens", () => {
        const fold = foldUsage([
            record({ recordKey: "k1", usage: { inputTokens: 150, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 10 } }),
            record({ recordKey: "k1", usage: { inputTokens: 150, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 10 } }),
            record({ recordKey: "k2", usage: { inputTokens: 30, outputTokens: 3 } }),
        ]);
        expect(fold.total.inputTokens).toBe(180);
        expect(fold.total.cacheReadInputTokens).toBe(100);
        expect(fold.total.cacheCreationInputTokens).toBe(20);
        expect(fold.total.reasoningTokens).toBeUndefined();
    });

    it("sums by agentId and by stepId, and leaves a record without a step out of byStep", () => {
        const fold = foldUsage([
            record({ recordKey: "k1", agentId: "bulk-transcriptomics-agent", runId: "r1", stepId: "T1S2", usage: { inputTokens: 10, outputTokens: 1 } }),
            record({ recordKey: "k2", agentId: "step-summary-writer", runId: "r1", stepId: "T1S2", usage: { inputTokens: 5, outputTokens: 2 } }),
            record({ recordKey: "k3", agentId: "enrichment-agent", runId: "r1", stepId: "T1S3", usage: { inputTokens: 7, outputTokens: 3 } }),
            record({ recordKey: "k4", agentId: "run-synthesizer", runId: "r1", usage: { inputTokens: 9, outputTokens: 4 } }),
        ]);
        expect(fold.byStep).toEqual({ T1S2: { inputTokens: 15, outputTokens: 3 }, T1S3: { inputTokens: 7, outputTokens: 3 } });
        expect(Object.keys(fold.byRole).sort()).toEqual(["bulk-transcriptomics-agent", "enrichment-agent", "run-synthesizer", "step-summary-writer"]);
        expect(fold.total).toEqual({ inputTokens: 31, outputTokens: 10 });
    });

    it("reads raw lines, skips a broken line, and reads a file back", () => {
        const dir = mkdtempSync(join(tmpdir(), "usage-sink-"));
        const path = join(dir, "usage.jsonl");
        const recorder = createEvalUsageRecorder(path);
        recorder.record(record({ recordKey: "k1" }));
        recorder.record(record({ recordKey: "k2" }));
        const text = `${readFileSync(path, "utf8")}{not json\n`;
        expect(parseUsageLines(text).length).toBe(2);
        expect(foldUsage(text.split("\n")).records).toBe(2);
        expect(readUsageFile(path).length).toBe(2);
        expect(readUsageFile(join(dir, "absent.jsonl"))).toEqual([]);
    });
});

const SESSION: AgentSession = {
    identity: { user: "eval" },
    scope: { kind: "analysis", analysisId: "a1" },
    provenance: { agentId: "planner", callPath: ["conversation-agent", "planner"] },
    runFrame: { runId: "r1", stepId: "T1S2" },
    auth: {},
};

const REQUEST: ChatRequest = {
    system: "You are the planner.",
    messages: [{ role: "user", content: "plan it" }],
    tools: { knowledge_recommend: {} as never, submit_plan: {} as never },
};

const RESPONSE: ChatResponse = {
    message: { role: "assistant", content: [{ type: "text", text: "the plan" }] },
    finishReason: "stop",
    usage: { inputTokens: 40, outputTokens: 4, cacheReadInputTokens: 30 },
    requestedModelId: "model-a",
    servedModelId: "model-a-2026",
};

function fakeInner(chat: () => unknown, stream: () => AsyncIterable<ChatStreamEvent>): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        requestTimeoutMs: 1234,
        chat: chat as ChatProvider["chat"],
        chatStream: stream,
    };
}

async function* streamOk(): AsyncIterable<ChatStreamEvent> {
    yield { type: "text-delta", text: "the " };
    yield { type: "text-delta", text: "plan" };
    yield { type: "done", response: RESPONSE };
}

async function* streamFail(): AsyncIterable<ChatStreamEvent> {
    yield { type: "text-delta", text: "the " };
    throw new Error("connection reset");
}

describe("recordingProvider", () => {
    it("records a chat reply with the role, the provenance, the request size, and the reply facts", async () => {
        const dir = mkdtempSync(join(tmpdir(), "calls-"));
        const sink = createJsonlSink(join(dir, "calls.jsonl"));
        const provider = recordingProvider(
            fakeInner(() => neverthrow.okAsync(RESPONSE), streamOk),
            "planner",
            sink,
        );
        expect(provider.requestTimeoutMs).toBe(1234);
        const result = await provider.chat(REQUEST, SESSION);
        expect(result.isOk()).toBe(true);
        const [line] = lines(sink.path) as CallLine[];
        expect(line).toMatchObject({
            role: "planner",
            agentId: "planner",
            callPath: ["conversation-agent", "planner"],
            runFrame: { runId: "r1", stepId: "T1S2" },
            systemChars: REQUEST.system.length,
            messageCount: 1,
            toolNames: ["knowledge_recommend", "submit_plan"],
            assistantMessage: RESPONSE.message,
            finishReason: "stop",
            usage: RESPONSE.usage,
            requestedModel: "model-a",
            servedModel: "model-a-2026",
            error: null,
        });
        expect(typeof line?.elapsedMs).toBe("number");
    });

    it("records a failed chat with the error and forwards the failure", async () => {
        const dir = mkdtempSync(join(tmpdir(), "calls-"));
        const sink = createJsonlSink(join(dir, "calls.jsonl"));
        const failure = { type: "provider", retryable: true, message: "overloaded" };
        const provider = recordingProvider(
            fakeInner(() => neverthrow.errAsync(failure), streamOk),
            "sandbox",
            sink,
        );
        const result = await provider.chat(REQUEST, SESSION);
        expect(result.isErr()).toBe(true);
        const [line] = lines(sink.path) as CallLine[];
        expect(line?.role).toBe("sandbox");
        expect(line?.assistantMessage).toBeNull();
        expect(line?.error).toEqual({ type: "provider", message: "overloaded", retryable: true });
    });

    it("records a streamed reply at the done event and a thrown stream as an error", async () => {
        const dir = mkdtempSync(join(tmpdir(), "calls-"));
        const sink = createJsonlSink(join(dir, "calls.jsonl"));
        const ok = recordingProvider(
            fakeInner(() => neverthrow.okAsync(RESPONSE), streamOk),
            "utility",
            sink,
        );
        const events: ChatStreamEvent[] = [];
        for await (const event of ok.chatStream(REQUEST, SESSION)) events.push(event);
        expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "done"]);

        const failing = recordingProvider(
            fakeInner(() => neverthrow.okAsync(RESPONSE), streamFail),
            "utility",
            sink,
        );
        await expect(
            (async () => {
                for await (const _event of failing.chatStream(REQUEST, SESSION)) {
                    // drain
                }
            })(),
        ).rejects.toThrow("connection reset");

        const written = lines(sink.path) as CallLine[];
        expect(written.length).toBe(2);
        expect(written[0]?.finishReason).toBe("stop");
        expect(written[1]?.error).toEqual({ type: "Error", message: "connection reset" });
    });
});
