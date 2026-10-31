import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../../providers/ai-sdk.js";
import type { ChatProvider } from "../../providers/types.js";
import { defineTool } from "../../tools/define-tool.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptedPart, type ScriptedReply, type ScriptStep } from "../../testing.js";
import { __resetMetricsForTest } from "../metrics.js";
import { continueLoop, runLoop, type LoopOptions } from "../run-loop.js";
import type { AgentDefinition } from "../types.js";

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
    view: "none",
    describeCall: "none",
    execute: () => Promise.resolve(ok({ ok: true })),
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

function runOpts(chat: ChatProvider): LoopOptions {
    return {
        provider: chat,
        signal: new AbortController().signal,
        emit: () => {},
    };
}

describe("runLoop metrics", () => {
    it("records the iteration count of a 3-iteration run", async () => {
        const chat = scriptedModel([callTools(toolCall("t0", "echo", {})), callTools(toolCall("t1", "echo", {})), reply([text("done")])]);

        await runLoop(agentDef(8), GO, makeSession(), runOpts(chat.provider));

        const collected = await collectMetrics();
        const iterations = collected.find((m) => m.descriptor.name === ITERATIONS_METRIC);
        expect(iterations).toBeDefined();
        if (iterations === undefined) throw new Error("the iterations metric is absent");
        expect(iterations.dataPoints).toHaveLength(1);
        const histogram = iterations.dataPoints[0]?.value;
        if (histogram === undefined || typeof histogram === "number" || !("count" in histogram) || !("sum" in histogram)) {
            throw new Error("the iterations metric exported no histogram value");
        }
        expect(histogram.count).toBe(1);
        expect(histogram.sum).toBe(3);

        // A non-capped run never touches the cap-hit counter.
        const capHits = collected.find((m) => m.descriptor.name === CAP_HITS_METRIC);
        if (capHits !== undefined) {
            const total = capHits.dataPoints.reduce((acc, dp) => {
                const pointValue: unknown = dp.value;
                return typeof pointValue === "number" ? acc + pointValue : acc;
            }, 0);
            expect(total).toBe(0);
        }
    });

    it("increments the cap-hit counter exactly once for a capped run", async () => {
        // Never ends on its own — each reply asks for a tool until the cap.
        const chat = scriptedModel([callTools(toolCall("t0", "echo", {})), callTools(toolCall("t1", "echo", {}))]);

        await runLoop(agentDef(2), GO, makeSession(), runOpts(chat.provider));

        const collected = await collectMetrics();
        const capHits = collected.find((m) => m.descriptor.name === CAP_HITS_METRIC);
        expect(capHits).toBeDefined();
        if (capHits === undefined) throw new Error("the cap-hit metric is absent");
        const total = capHits.dataPoints.reduce((acc, dp) => {
            const pointValue: unknown = dp.value;
            return typeof pointValue === "number" ? acc + pointValue : acc;
        }, 0);
        expect(total).toBe(1);

        const iterations = collected.find((m) => m.descriptor.name === ITERATIONS_METRIC);
        expect(iterations).toBeDefined();
        if (iterations === undefined) throw new Error("the iterations metric is absent");
        const histogram = iterations.dataPoints[0]?.value;
        if (histogram === undefined || typeof histogram === "number" || !("sum" in histogram))
            throw new Error("the iterations metric exported no histogram value");
        expect(histogram.sum).toBe(2);
    });
});

/** A model whose stream names no model: it sends no response metadata. */
function unnamedModel(inputTokens: number): ChatProvider {
    const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p0" },
        { type: "text-delta", id: "p0", delta: "done" },
        { type: "text-end", id: "p0" },
        {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
        },
    ];
    const model = new MockLanguageModelV4({ provider: "unnamed", doStream: () => Promise.resolve({ stream: convertArrayToReadableStream(parts) }) });
    return createAiSdkProvider({ model, maxRetries: 0 });
}

describe("runLoop token counters for each call", () => {
    /** Shares one provenance across agents, so a provenance label would merge their tokens. */
    const agentSession = () => makeSession({ agentId: "tui-chat", callPath: ["tui-chat"] });

    async function series(name: string): Promise<{ attributes: Record<string, unknown>; value: number }[]> {
        const metric = (await collectMetrics()).find((m) => m.descriptor.name === name);
        return (metric?.dataPoints ?? []).flatMap((dp) => {
            const pointValue: unknown = dp.value;
            return typeof pointValue === "number" ? [{ attributes: { ...dp.attributes }, value: pointValue }] : [];
        });
    }

    const LABELS = { agent_id: "metrics-agent", model: "claude-opus-5-5", provider: "scripted" };

    function served(content: readonly ScriptedPart[], finishReason: ScriptedReply["finishReason"]): ScriptedReply {
        return {
            ...reply(content, finishReason, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 60, cacheCreationInputTokens: 40, reasoningTokens: 5 }),
            modelId: "claude-opus-5-5",
        };
    }

    const servedToolCall = (callIndex: number): ScriptedReply => served([toolCall(`t${callIndex}`, "echo", {})], "tool-calls");

    it("grows each counter for each call, with the agent, the served model, and the provider as labels", async () => {
        const chat = scriptedModel([servedToolCall(0), servedToolCall(1), served([text("done")], "stop")]);

        await runLoop(agentDef(8), GO, agentSession(), runOpts(chat.provider));

        expect(chat.calls).toHaveLength(3);
        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 300 }]);
        expect(await series(OUTPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 30 }]);
        expect(await series(CACHE_READ_METRIC)).toEqual([{ attributes: LABELS, value: 180 }]);
        expect(await series(CACHE_WRITE_METRIC)).toEqual([{ attributes: LABELS, value: 120 }]);
        expect(await series(REASONING_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 15 }]);
    });

    it("omits the model label when the response names no model", async () => {
        await runLoop(agentDef(2), GO, agentSession(), runOpts(unnamedModel(7)));

        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: { agent_id: "metrics-agent", provider: "unnamed" }, value: 7 }]);
    });

    it("gives the counter attributes of such a response no model key", async () => {
        await runLoop(agentDef(2), GO, agentSession(), runOpts(unnamedModel(7)));

        const [point] = await series(INPUT_TOKENS_METRIC);
        expect(point).toBeDefined();
        expect(Object.keys(point?.attributes ?? {})).toEqual(["agent_id", "provider"]);
    });

    it("keeps the counts of the calls that completed before the run throws", async () => {
        const script: ScriptStep[] = [servedToolCall(0), servedToolCall(1), { fail: new Error("upstream exploded") }];
        const chat = scriptedModel(script);

        await expect(runLoop(agentDef(8), GO, agentSession(), runOpts(chat.provider))).rejects.toThrow("upstream exploded");

        expect(chat.calls).toHaveLength(3);
        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 200 }]);
        expect(await series(REASONING_TOKENS_METRIC)).toEqual([{ attributes: LABELS, value: 10 }]);
    });

    it("labels two agents of one root provenance apart, by the id of the agent of each loop", async () => {
        const done = (): ScriptedReply => reply([text("done")], "stop", { inputTokens: 5 });

        await runLoop({ ...agentDef(2), id: "conversation-agent" }, GO, agentSession(), runOpts(scriptedModel([done()]).provider));
        await runLoop({ ...agentDef(2), id: "report-agent" }, GO, agentSession(), runOpts(scriptedModel([done()]).provider));

        const byAgent = (await series(INPUT_TOKENS_METRIC)).map((point) => [point.attributes["agent_id"], point.value]);
        expect(byAgent).toEqual([
            ["conversation-agent", 5],
            ["report-agent", 5],
        ]);
    });

    it("counts a continuation under its accounting agent id, not the id of the agent it continues", async () => {
        const chat = scriptedModel([served([text("summary")], "stop")]);

        await continueLoop(
            agentDef(2),
            GO,
            { text: "Summarize.", mask: "none", maxRequests: 2, accountingAgentId: "step-summary-writer" },
            agentSession(),
            runOpts(chat.provider),
        );

        expect(await series(INPUT_TOKENS_METRIC)).toEqual([{ attributes: { ...LABELS, agent_id: "step-summary-writer" }, value: 100 }]);
        const iterations = (await collectMetrics()).find((m) => m.descriptor.name === ITERATIONS_METRIC);
        expect(iterations).toBeDefined();
        if (iterations === undefined) throw new Error("the iterations metric is absent");
        expect(iterations.dataPoints.map((dp) => dp.attributes["agent_id"])).toEqual(["step-summary-writer"]);
    });
});
