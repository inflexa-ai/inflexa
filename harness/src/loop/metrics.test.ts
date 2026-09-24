import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import type { LlmUsageRecord, UsageRecorder } from "../billing/usage-recorder.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ProviderError } from "../providers/errors.js";
import type { AgentChat, ChatResponse } from "../providers/types.js";
import { defineTool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { __resetMetricsForTest } from "./metrics.js";
import { runAgent } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition, RunStep } from "./types.js";

const ITERATIONS_METRIC = "cortex.harness.agent.iterations";
const CAP_HITS_METRIC = "cortex.harness.agent.cap_hits";
const INPUT_TOKENS_METRIC = "cortex.harness.agent.input_tokens";
const OUTPUT_TOKENS_METRIC = "cortex.harness.agent.output_tokens";
const CACHE_READ_METRIC = "cortex.harness.agent.cache_read_tokens";
const CACHE_WRITE_METRIC = "cortex.harness.agent.cache_write_tokens";
const REASONING_TOKENS_METRIC = "cortex.harness.agent.reasoning_tokens";

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let provider: MeterProvider;

beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({
        exporter,
        // Long interval — every export in this suite is a manual forceFlush.
        exportIntervalMillis: 3_600_000,
    });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    // Drop memoized instruments so they rebind to this fresh provider.
    __resetMetricsForTest();
});

afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetMetricsForTest();
});

/** Flush the reader and return the flat list of exported metrics. */
async function collectMetrics(): Promise<MetricData[]> {
    await provider.forceFlush();
    return exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics);
}

const echoTool = defineTool({
    id: "echo",
    description: "A no-op tool.",
    inputSchema: z.object({}),
    describeCall: "none",
    execute: async () => ok({ ok: true }),
});

function agentDef(maxIterations: number): AgentDefinition {
    return {
        id: "metrics-agent",
        systemPrompt: "test",
        model: "claude-test",
        tools: [echoTool],
        maxIterations,
    };
}

const GO = [{ role: "user" as const, content: "go" }];

function runOpts(provider: ReturnType<typeof scriptedProvider>) {
    return {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: passthroughStep,
    };
}

describe("runAgent metrics", () => {
    it("records the iteration count of a 3-iteration run", async () => {
        const chat = scriptedProvider([
            makeMessage([toolUseBlock("t0", "echo", {})], "tool_use"),
            makeMessage([toolUseBlock("t1", "echo", {})], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        await runAgent(agentDef(8), GO, makeSession(), runOpts(chat));

        const collected = await collectMetrics();
        const iterations = collected.find((m) => m.descriptor.name === ITERATIONS_METRIC);
        expect(iterations).toBeDefined();
        expect(iterations!.dataPoints).toHaveLength(1);
        const value = iterations!.dataPoints[0]!.value as { count: number; sum: number };
        expect(value.count).toBe(1);
        expect(value.sum).toBe(3);

        // A non-capped run never touches the cap-hit counter.
        const capHits = collected.find((m) => m.descriptor.name === CAP_HITS_METRIC);
        if (capHits !== undefined) {
            const total = capHits.dataPoints.reduce((acc, dp) => acc + (dp.value as number), 0);
            expect(total).toBe(0);
        }
    });

    it("increments the cap-hit counter exactly once for a capped run", async () => {
        // Never terminates on its own — only the wrap-up call, which forbids a
        // tool, ends it.
        const chat = scriptedProvider((_callIndex, request) =>
            request.toolChoice === "none" ? makeMessage([textBlock("wrap-up")], "end_turn") : makeMessage([toolUseBlock("t", "echo", {})], "tool_use"),
        );

        await runAgent(agentDef(2), GO, makeSession(), runOpts(chat));

        const collected = await collectMetrics();
        const capHits = collected.find((m) => m.descriptor.name === CAP_HITS_METRIC);
        expect(capHits).toBeDefined();
        const total = capHits!.dataPoints.reduce((acc, dp) => acc + (dp.value as number), 0);
        expect(total).toBe(1);

        const iterations = collected.find((m) => m.descriptor.name === ITERATIONS_METRIC);
        const value = iterations!.dataPoints[0]!.value as { sum: number };
        expect(value.sum).toBe(2);
    });
});

describe("runAgent token counters for each call", () => {
    /**
     * A root session of the CLI. Its provenance names `tui-chat` for each agent
     * that a root turn runs, thus a label from the provenance would merge the
     * tokens of different agents.
     */
    const agentSession = () => makeSession({ agentId: "tui-chat", callPath: ["tui-chat"] });

    /** The data points of one counter: the labels and the value of each series. */
    async function series(name: string): Promise<{ attributes: Record<string, unknown>; value: number }[]> {
        const metric = (await collectMetrics()).find((m) => m.descriptor.name === name);
        return (metric?.dataPoints ?? []).map((dp) => ({ attributes: { ...dp.attributes }, value: dp.value as number }));
    }

    const LABELS = { agent_id: "metrics-agent", model: "claude-opus-5-5", provider: "anthropic.messages" };

    /** The reply with the usage of one call, the served model, and the provider of the response. */
    function served(reply: ChatResponse): ChatResponse {
        return {
            ...reply,
            usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 60, cacheCreationInputTokens: 40, reasoningTokens: 5 },
            servedModelId: "claude-opus-5-5",
            provider: "anthropic.messages",
        };
    }

    const toolCall = (callIndex: number): ChatResponse => served(makeMessage([toolUseBlock(`t${callIndex}`, "echo", {})], "tool_use"));

    it("grows each counter for each call, with the agent, the served model, and the provider as labels", async () => {
        const chat = scriptedProvider((callIndex, request) =>
            request.toolChoice === "none" ? served(makeMessage([textBlock("done")], "end_turn")) : toolCall(callIndex),
        );

        await runAgent(agentDef(2), GO, agentSession(), runOpts(chat));

        // 2 iterations + the forced wrap-up: three calls of the same usage.
        expect(chat.calls).toHaveLength(3);
        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 300 }]);
        expect(await series(OUTPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 30 }]);
        expect(await series(CACHE_READ_METRIC)).toEqual([{ attributes: LABELS, value: 180 }]);
        expect(await series(CACHE_WRITE_METRIC)).toEqual([{ attributes: LABELS, value: 120 }]);
        expect(await series(REASONING_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 15 }]);
    });

    it("omits the model and the provider labels when the response gives neither", async () => {
        const chat = scriptedProvider([makeMessage([textBlock("done")], "end_turn", { inputTokens: 7 })]);

        await runAgent(agentDef(2), GO, agentSession(), runOpts(chat));

        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: { agent_id: "metrics-agent" }, value: 7 }]);
    });

    it("keeps the counts of the calls that completed before the run throws", async () => {
        let calls = 0;
        const failsOnThirdCall: AgentChat = {
            capabilities: { toolCalling: true },
            chat: () => {
                calls += 1;
                if (calls === 3) return errAsync({ type: "provider", retryable: false, message: "upstream exploded" } as ProviderError);
                return okAsync(toolCall(calls));
            },
        };

        await expect(runAgent(agentDef(8), GO, agentSession(), { ...runOpts(scriptedProvider([])), provider: failsOnThirdCall })).rejects.toThrow();

        // The counters grew when each of the first two calls completed, not at
        // the end of the run, which never came.
        expect(calls).toBe(3);
        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 200 }]);
        expect(await series(REASONING_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 10 }]);
    });

    it("labels two agents of one root provenance apart, by the id of the agent of each loop", async () => {
        const reply = (): ChatResponse => makeMessage([textBlock("done")], "end_turn", { inputTokens: 5 });

        await runAgent({ ...agentDef(2), id: "conversation-agent" }, GO, agentSession(), runOpts(scriptedProvider([reply()])));
        await runAgent({ ...agentDef(2), id: "report-agent" }, GO, agentSession(), runOpts(scriptedProvider([reply()])));

        const byAgent = (await series(INPUT_TOKENS_METRIC)).map((point) => [point.attributes["agent_id"], point.value]);
        expect(byAgent).toEqual([
            ["conversation-agent", 5],
            ["report-agent", 5],
        ]);
    });

    it("counts each call once when a recovery replays the steps of the run", async () => {
        // A step store keyed by the step name, the same as the durability
        // engine: the replay returns each stored value, and it runs no body.
        const stored = new Map<string, unknown>();
        const replayingStep: RunStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
            if (stored.has(name)) return stored.get(name) as T;
            const value = await fn();
            stored.set(name, value);
            return value;
        };
        const records: LlmUsageRecord[] = [];
        const usageRecorder: UsageRecorder = {
            record: (record) => {
                records.push(record);
                return okAsync(undefined);
            },
        };
        const chat = scriptedProvider((callIndex, request) =>
            request.toolChoice === "none" ? served(makeMessage([textBlock("done")], "end_turn")) : toolCall(callIndex),
        );
        const session = { ...agentSession(), runFrame: { runId: "run-1", stepId: "step-1" } };
        const run = () => runAgent(agentDef(2), GO, session, { ...runOpts(chat), runStep: replayingStep, usageRecorder });

        await run();
        await run();

        // The replay made no model call, and the counters hold one count of each call.
        expect(chat.calls).toHaveLength(3);
        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 300 }]);
        // The replay delivers each record again under the same key, thus an
        // upserting sink counts each call once.
        expect(records).toHaveLength(6);
        expect(new Set(records.map((record) => record.recordKey)).size).toBe(3);
    });
});
