import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { defineTool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { __resetMetricsForTest } from "./metrics.js";
import { runAgent } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition } from "./types.js";

const ITERATIONS_METRIC = "cortex.harness.agent.iterations";
const CAP_HITS_METRIC = "cortex.harness.agent.cap_hits";

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
        // Never terminates on its own — only the tool-less wrap-up call ends it.
        const chat = scriptedProvider((_callIndex, request) =>
            request.tools !== undefined && request.tools.length === 0
                ? makeMessage([textBlock("wrap-up")], "end_turn")
                : makeMessage([toolUseBlock("t", "echo", {})], "tool_use"),
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
