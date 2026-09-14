import { afterAll, beforeAll, expect, it } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createAiSdkProvider } from "../providers/ai-sdk.js";
import { defineTool } from "../tools/define-tool.js";
import { runAgent } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";

const exporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => tracerProvider.register());

afterAll(async () => {
    await tracerProvider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
});

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };

const toolCall = (toolCallId: string, toolName: string, input: unknown): LanguageModelV4StreamPart => ({
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify(input),
});

const turns: LanguageModelV4StreamPart[][] = [
    [
        { type: "stream-start", warnings: [] },
        toolCall("tc-1", "lookup", { query: "SECRET-ARGS" }),
        toolCall("tc-2", "explode", {}),
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ],
    [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "SECRET-COMPLETION" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ],
];

const lookup = defineTool({
    id: "lookup",
    description: "Look a term up.",
    inputSchema: z.object({ query: z.string() }),
    describeCall: "none",
    execute: async () => ok({ answer: "SECRET-RESULT" }),
});

const explode = defineTool({
    id: "explode",
    description: "Always fails.",
    inputSchema: z.object({}),
    describeCall: "none",
    execute: async () => {
        throw new Error("SECRET-TOOL-ERROR");
    },
});

it("exports the loop and model-call spans as one trace, with no prompt or completion text", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(turns.shift() ?? []) }) });

    await runAgent(
        { id: "test-agent", systemPrompt: "SECRET-SYSTEM", model: "mock-model-id", tools: [lookup, explode], maxIterations: 4 },
        [{ role: "user", content: "SECRET-PROMPT" }],
        makeSession(),
        {
            provider: createAiSdkProvider({ model, resolveBilling: async () => ({}) }),
            signal: new AbortController().signal,
            emit: () => {},
            runStep: passthroughStep,
        },
    );

    const spans = exporter.getFinishedSpans();
    const named = (name: string) => spans.find((span) => span.name === name);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(named("invoke_agent test-agent")?.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(named("chat mock-model-id")?.attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(named("execute_tool lookup")?.attributes["inflexa.tool.outcome"]).toBe("ok");
    expect(named("execute_tool explode")?.attributes["inflexa.tool.outcome"]).toBe("error");
    expect(JSON.stringify(spans.map((span) => [span.attributes, span.events, span.status]))).not.toContain("SECRET");
});
